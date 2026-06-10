// Prize Sniper V7 [ADMIN] — Service Worker
// Versão standalone: sem backend, sem licença, botcode embutido na pasta.
// OCR via ONNX Runtime WASM (offscreen) — sem Claude API.

// CapSolver API key
const CAPSOLVER_API_KEY = 'CAP-73AFFE795703209998D00A28C666FCA71A8B3F15685333DCF6F359AE3D78563E';

const OFFSCREEN_URL = 'offscreen.html';

// Rastreia tabs que já receberam loader e/ou botcode
const loaderInjectedTabs  = new Set();   // tabId
const botcodeInjectedTabs = new Set();   // tabId

// Cache de captchas em voo: url → { base64, mediaType, hash }
// Populado pelo handler ocr (auto) ou cacheCaptcha (manual).
// Consumido por confirmCaptcha quando o sucesso é detectado.
const pendingCaptchas = new Map();
const PENDING_TTL_MS  = 5 * 60 * 1000;   // 5min — limpa entradas órfãs

// ============================================================
// INJEÇÃO PROGRAMÁTICA DO LOADER
// ============================================================
// Mesma estratégia da V7: o SW decide onde injetar — só no frame principal
// do jogo (URL com gameId=), 1 vez por aba.

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (!/pokgaming/.test(details.url)) return;
  if (!/gameId=/.test(details.url))   return;
  if (loaderInjectedTabs.has(details.tabId)) return;
  loaderInjectedTabs.add(details.tabId);

  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      files:  ['loader.js'],
      world:  'ISOLATED',
    });
    console.log('[SW-admin] loader injetado tab', details.tabId, 'frame', details.frameId);
  } catch (e) {
    console.error('[SW-admin] loader inject falhou:', e.message);
    loaderInjectedTabs.delete(details.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  loaderInjectedTabs.delete(tabId);
  botcodeInjectedTabs.delete(tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) {
    loaderInjectedTabs.delete(details.tabId);
    botcodeInjectedTabs.delete(details.tabId);
  }
});

// ============================================================
// MESSAGE HANDLERS
// ============================================================

const handlers = {

  // ---------- OCR via ONNX WASM (offscreen) ----------
  ocr: async (body) => {
    const t0 = Date.now();
    const images = body && body.images;
    if (!Array.isArray(images) || images.length === 0) {
      return { error: 'images array required' };
    }
    const firstUrl = images[0] && images[0].type === 'url' ? images[0].url : null;
    if (firstUrl) cacheCaptchaFromUrl(firstUrl).catch(() => {});
    try {
      const { otp, attempts, raw } = await solveOcrWasm(images);
      return { ok: true, otp, attempts, raw, duration_ms: Date.now() - t0 };
    } catch (e) {
      return { error: 'ocr falhou: ' + e.message, duration_ms: Date.now() - t0 };
    }
  },

  // ---------- Cache imagem do captcha ----------
  // Botcode captura do DOM (canvas/img) e manda base64+url. URL do servidor
  // virou inacessível, então o fetch só é tentado como fallback histórico.
  cacheCaptcha: async (body) => {
    const url       = body && body.url;
    const base64    = body && body.base64;
    const mediaType = (body && body.mediaType) || 'image/png';
    if (!url) return { error: 'url required' };
    try {
      if (base64) await cacheCaptchaFromBase64(url, base64, mediaType);
      else        await cacheCaptchaFromUrl(url);
      return { ok: true };
    } catch (e) {
      return { error: 'cache falhou: ' + e.message };
    }
  },

  // ---------- Persiste captcha labelado no disco ----------
  // Chamado pelo botcode quando o servidor aceita o OTP.
  // Dedup por SHA-256 do PNG. Salva em Downloads/ps-captchas/.
  confirmCaptcha: async (body) => {
    const url       = body && body.url;
    const otp       = body && body.otp;
    const source    = (body && body.source) || 'auto';
    const base64    = body && body.base64;
    const mediaType = (body && body.mediaType) || 'image/png';
    if (!url || !otp) return { error: 'url + otp required' };
    if (!/^[A-Za-z0-9]{4}$/.test(otp)) return { error: 'otp inválido: ' + otp };

    let entry = pendingCaptchas.get(url);
    if (!entry) {
      try {
        if (base64) await cacheCaptchaFromBase64(url, base64, mediaType);
        else        await cacheCaptchaFromUrl(url);
        entry = pendingCaptchas.get(url);
      } catch (e) { return { error: 'cache miss + refetch falhou: ' + e.message }; }
    }
    if (!entry) return { error: 'cache miss e refetch silencioso falhou' };

    try {
      const r = await saveCaptchaToDisk(entry, otp, source);
      pendingCaptchas.delete(url);
      return { ok: true, ...r };
    } catch (e) {
      return { error: 'save falhou: ' + e.message };
    }
  },

  // ---------- Injeção do botcode local ----------
  fetchBotcode: async (body, sender) => {
    const tabId = sender.tab.id;
    if (botcodeInjectedTabs.has(tabId)) {
      return { ok: true, skipped: true };
    }
    const stopKeepAlive = keepAlive(); // ← adiciona
    try {
      const url  = chrome.runtime.getURL('botcode.js');
      const r    = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) return { error: 'fetch botcode HTTP ' + r.status };
      const code = await r.text();
      if (!code || code.length < 50) return { error: 'botcode vazio' };

      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [sender.frameId] },
        world:  'MAIN',
        func:   (src) => {
          try {
            var _G = Symbol.for('ps.injected');
            if (window[_G]) return;
            window[_G] = true;
            (new Function(src))();
          } catch (e) { console.error('[PS-admin] botcode erro:', e); }
        },
        args: [code],
      });
      botcodeInjectedTabs.add(tabId);
      return { ok: true, size: code.length };
    } catch (e) {
      return { error: 'inject: ' + e.message };
    } finally {
      stopKeepAlive(); // ← adiciona
    }
  },

  // ---------- Tab control ----------
  focusTab: async (body, sender) => {
    try {
      await chrome.tabs.update(sender.tab.id, { active: true });
      await chrome.windows.update(sender.tab.windowId, { focused: true });
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  },

  reloadTab: async (body, sender) => {
    try {
      loaderInjectedTabs.delete(sender.tab.id);
      botcodeInjectedTabs.delete(sender.tab.id);
      await chrome.tabs.reload(sender.tab.id);
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  },

  // ---------- Storage bridge ----------
  storageGet: async (body) => {
    const data = await chromeStorageGet(body.keys || []);
    return { ok: true, data };
  },

  storageSet: async (body) => {
    await new Promise(r => chrome.storage.local.set(body.data || {}, r));
    return { ok: true };
  },

  // ---------- Resolve Geetest V4 via CapSolver ----------
  solveGeetest: async (body) => {
    const { captcha_id } = body;
    if (!captcha_id) return { error: 'captcha_id required' };
    try {
      console.log('[CapSolver] enviando captcha_id:', captcha_id);
      const submitResp = await fetch('https://api.capsolver.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: CAPSOLVER_API_KEY,
          task: {
         type: 'GeeTestTask',
         websiteURL: 'https://sa2.pokgaming80.com/',
         captchaId: captcha_id,
         proxyType: 'http',
         proxyAddress: '74.81.81.81',
         proxyPort: 823,
         proxyLogin: '663f3c3b5731478b1ce2__cr.br',
        proxyPassword: '27463e3dc58f97b0',
},
        }),
      });
      const submitData = await submitResp.json();
      if (submitData.errorId !== 0) return { error: 'CapSolver submit falhou: ' + submitData.errorDescription };
      const taskId = submitData.taskId;
      console.log('[CapSolver] taskId:', taskId);

      // 2. Polling até resolver (max 120s)
      for (let i = 0; i < 24; i++) {
        await sleep(5000);
        const pollResp = await fetch('https://api.capsolver.com/getTaskResult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientKey: CAPSOLVER_API_KEY,
            taskId: taskId,
          }),
        });
        const pollData = await pollResp.json();
        console.log('[CapSolver] poll:', pollData.status);
        if (pollData.status === 'ready') {
          console.log('[CapSolver] solução:', JSON.stringify(pollData.solution));
          return { ok: true, solution: pollData.solution };
        }
        if (pollData.status !== 'processing') {
          return { error: 'CapSolver erro: ' + pollData.errorDescription };
        }
      }
      return { error: 'CapSolver timeout' };
    } catch (e) {
      return { error: 'solveGeetest falhou: ' + e.message };
    }
  },
// ---------- Verify Geetest via SW ----------
  verifyGeetest: async (body) => {
    const { captcha_id, lot_number, pass_token, gen_time, captcha_output } = body;
    try {
      const verifyUrl = `https://gcaptcha4.geetest.com/verify?captcha_id=${captcha_id}&lot_number=${lot_number}&pass_token=${pass_token}&gen_time=${gen_time}&captcha_output=${encodeURIComponent(captcha_output)}`;
      const resp = await fetch(verifyUrl);
      const text = await resp.text();
      return { ok: true, response: text.slice(0, 200) };
    } catch(e) {
      return { error: 'verify falhou: ' + e.message };
    }
  },
  
// ---------- Clique real via CDP ----------
  clickElement: async (body, sender) => {
    const { selector } = body;
    const tabId = sender.tab.id;
    const frameId = sender.frameId;
    try {
      // Pega coordenadas do elemento no iframe
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        func: (sel) => {
          var el = document.querySelector(sel);
          if (!el) return null;
          var r = el.getBoundingClientRect();
          return { 
            elX: Math.round(r.left + r.width/2), 
            elY: Math.round(r.top + r.height/2) 
          };
        },
        args: [selector],
      });

      const coords = results[0].result;
      if (!coords) return { error: 'elemento não encontrado' };

      // Pega offset do iframe na página principal
      const iframeResults = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          var iframe = document.querySelector('iframe');
          if (!iframe) return { x: 0, y: 0 };
          var r = iframe.getBoundingClientRect();
          return { x: Math.round(r.left), y: Math.round(r.top) };
        },
      });

      const iframeOffset = iframeResults[0].result || { x: 0, y: 0 };
      const finalCoords = {
        x: coords.elX + iframeOffset.x,
        y: coords.elY + iframeOffset.y,
      };

      // Clique real via CDP
      await chrome.debugger.attach({ tabId }, '1.3');
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: finalCoords.x, y: finalCoords.y, 
        button: 'left', clickCount: 1, buttons: 1,
      });
      await new Promise(r => setTimeout(r, 50));
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: finalCoords.x, y: finalCoords.y, 
        button: 'left', clickCount: 1, buttons: 0,
      });
      await chrome.debugger.detach({ tabId });
      return { ok: true, coords: finalCoords };
    } catch (e) {
      try { await chrome.debugger.detach({ tabId }); } catch(_) {}
      return { error: 'click falhou: ' + e.message };
    }
  },
}; // ← fechamento do handlers


// Listener de porta longa — evita SW encerrar antes de responder (MV3)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ps-bridge') return;
  port.onMessage.addListener(async (msg) => {
    const h = handlers[msg.action];
    if (!h) { port.postMessage({ error: 'unknown action: ' + msg.action }); return; }
    try {
      const resp = await h(msg.body || {}, port.sender);
      port.postMessage(resp || {});
    } catch (e) {
      port.postMessage({ error: e.message || String(e) });
    }
  });
});

// Listener padrão para mensagens simples
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === 'offscreen') return false;
  const h = handlers[msg.action];
  if (!h) { sendResponse({ error: 'unknown action: ' + msg.action }); return false; }
  h(msg.body || {}, sender)
    .then(resp => sendResponse(resp || {}))
    .catch(e => sendResponse({ error: e.message || String(e) }));
  return true;
});

// ============================================================
// OCR — ONNX WASM via offscreen
// ============================================================

let _creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    if (await chrome.offscreen.hasDocument()) return;
  } else if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (ctxs.length > 0) return;
  }
  if (_creatingOffscreen) { await _creatingOffscreen; return; }
  _creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS'],
    justification: 'Run ONNX inference for captcha OCR (WASM).',
  });
  try { await _creatingOffscreen; }
  finally { _creatingOffscreen = null; }
}

ensureOffscreen().catch(e => console.warn('[SW-admin] preload offscreen falhou:', e.message));

async function solveOcrWasm(images) {
  const img = images[0];
  if (!img) throw new Error('no images');

  let imageUrl;
  if (img.type === 'url') {
    imageUrl = img.url;
  } else if (img.type === 'base64') {
    imageUrl = 'data:' + (img.media_type || 'image/png') + ';base64,' + img.data;
  } else {
    throw new Error('invalid image type: ' + img.type);
  }

  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'ocr',
    imageUrl,
  });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'sem resposta do offscreen');
  const otp = validateAndCorrect(resp.text);
  return { otp, attempts: 1, raw: resp.text, score: resp.score };
}

// ============================================================
// VALIDAÇÃO — padrão 1U+1L+2D com swap de ambíguos
// ============================================================

function matchesCaptchaPattern(code) {
  if (code.length !== 4) return false;
  const upper  = (code.match(/[A-Z]/g) || []).length;
  const lower  = (code.match(/[a-z]/g) || []).length;
  const digits = (code.match(/[0-9]/g) || []).length;
  return upper === 1 && lower === 1 && digits === 2;
}

const AMBIGUOUS = {
  'O': '0', '0': 'O',
  'I': '1', '1': 'I', 'l': '1',
  'S': '5', '5': 'S',
  'Z': '2', '2': 'Z',
  'B': '8', '8': 'B',
  'G': '6', '6': 'G',
  'g': '9', '9': 'g',
  'q': '9',
};

function validateAndCorrect(text) {
  const cleaned = (text || '').replace(/[^A-Za-z0-9]/g, '');
  if (cleaned.length < 4) throw new Error('resposta curta: ' + text);
  const code = cleaned.slice(0, 4);
  if (matchesCaptchaPattern(code)) return code;

  for (let i = 0; i < 4; i++) {
    const alt = AMBIGUOUS[code[i]];
    if (!alt) continue;
    const cand = code.slice(0, i) + alt + code.slice(i + 1);
    if (matchesCaptchaPattern(cand)) return cand;
  }

  for (let i = 0; i < 4; i++) {
    const altI = AMBIGUOUS[code[i]];
    if (!altI) continue;
    for (let j = i + 1; j < 4; j++) {
      const altJ = AMBIGUOUS[code[j]];
      if (!altJ) continue;
      const cand = code.slice(0, i) + altI + code.slice(i + 1, j) + altJ + code.slice(j + 1);
      if (matchesCaptchaPattern(cand)) return cand;
    }
  }

  return code;
}

// ============================================================
// CAPTCHA DATASET — fetch + hash + dedup + save
// ============================================================

async function cacheCaptchaFromUrl(url) {
  const existing = pendingCaptchas.get(url);
  if (existing && (Date.now() - existing.cachedAt) < PENDING_TTL_MS) return;

  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error('fetch HTTP ' + r.status);
  const blob = await r.blob();
  const buf  = await blob.arrayBuffer();
  const hash = await sha256(buf);
  const base64    = bufToBase64(buf);
  const mediaType = blob.type || 'image/png';
  pendingCaptchas.set(url, { base64, mediaType, hash, cachedAt: Date.now() });

  // GC: remove órfãs antigas
  for (const [k, v] of pendingCaptchas) {
    if (Date.now() - v.cachedAt > PENDING_TTL_MS) pendingCaptchas.delete(k);
  }
}

async function cacheCaptchaFromBase64(url, base64, mediaType) {
  const existing = pendingCaptchas.get(url);
  if (existing && (Date.now() - existing.cachedAt) < PENDING_TTL_MS) return;

  const buf  = base64ToBuf(base64);
  const hash = await sha256(buf);
  pendingCaptchas.set(url, {
    base64,
    mediaType: mediaType || 'image/png',
    hash,
    cachedAt: Date.now(),
  });

  for (const [k, v] of pendingCaptchas) {
    if (Date.now() - v.cachedAt > PENDING_TTL_MS) pendingCaptchas.delete(k);
  }
}

function base64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function saveCaptchaToDisk(entry, otp, source) {
  const { hash, base64, mediaType } = entry;

  // Dedup: chrome.storage.local mantém set de hashes já salvos
  const s = await chromeStorageGet(['captcha_hashes']);
  const seen = new Set(s.captcha_hashes || []);
  if (seen.has(hash)) return { skipped: true, reason: 'duplicate', hash };

  const ext  = mediaType === 'image/jpeg' ? 'jpg' : 'png';
  const safe = otp.replace(/[^A-Za-z0-9]/g, '');
  const name = `ps-captchas/${source}_${safe}_${hash.slice(0, 8)}.${ext}`;
  const dataUrl = `data:${mediaType};base64,${base64}`;

  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename: name, conflictAction: 'uniquify', saveAs: false },
      (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      },
    );
  });

  seen.add(hash);
  await new Promise(r => chrome.storage.local.set({ captcha_hashes: [...seen] }, r));
  return { saved: true, hash, filename: name, downloadId };
}

async function sha256(buf) {
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ============================================================
// HELPERS
// ============================================================

function chromeStorageGet(keys) {
  return new Promise(res => chrome.storage.local.get(keys, r => res(r || {})));
}

// Mantém o SW vivo durante operações longas
function keepAlive() {
  const interval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
  return () => clearInterval(interval);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
