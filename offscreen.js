// Offscreen document — roda a inferencia ONNX em WASM.
// Vive porque o service worker MV3 nao permite dynamic import() do
// onnxruntime-web 1.18+. Aqui temos ES modules normais.

ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
ort.env.logLevel = 'warning';

let _session = null;
let _meta = null;
let _loadPromise = null;

async function ensureModel() {
  if (_session) return;
  if (_loadPromise) { await _loadPromise; return; }
  _loadPromise = (async () => {
    const t0 = Date.now();
    console.log('[offscreen] carregando modelo...');
    const metaResp = await fetch(chrome.runtime.getURL('assets/captcha_cnn.meta.json'));
    if (!metaResp.ok) throw new Error('fetch meta HTTP ' + metaResp.status);
    _meta = await metaResp.json();

    const modelResp = await fetch(chrome.runtime.getURL('assets/captcha_cnn.onnx'));
    if (!modelResp.ok) throw new Error('fetch onnx HTTP ' + modelResp.status);
    const modelBuf = await modelResp.arrayBuffer();
    console.log('[offscreen] onnx baixado: ' + Math.round(modelBuf.byteLength/1024) + 'KB');

    _session = await ort.InferenceSession.create(modelBuf, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    console.log('[offscreen] modelo carregado em ' + (Date.now()-t0) + 'ms (in:' +
                _session.inputNames.join(',') + ' out:' + _session.outputNames.join(',') + ')');
  })();
  await _loadPromise;
}

// Inicia o carregamento ja
ensureModel().catch(e => console.error('[offscreen] preload falhou:', e));


// ──────────────── Inferencia ────────────────────────────────────────────────
async function runOcr(imageUrl) {
  await ensureModel();

  const r = await fetch(imageUrl);
  if (!r.ok) throw new Error('fetch image HTTP ' + r.status);
  const blob = await r.blob();

  const inputTensor = await preprocessCaptcha(blob);
  const outputs = await _session.run({ image: inputTensor });
  const logits  = outputs[Object.keys(outputs)[0]].data;
  const { text, score } = decodeWithFormat(logits, _meta.chars, _meta.n_chars);
  return { text, score };
}

async function preprocessCaptcha(blob) {
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width, h = bitmap.height;

  // composita em fundo branco (caso seja RGBA com alpha)
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = w; fullCanvas.height = h;
  const fullCtx = fullCanvas.getContext('2d');
  fullCtx.fillStyle = 'white';
  fullCtx.fillRect(0, 0, w, h);
  fullCtx.drawImage(bitmap, 0, 0);
  const fullData = fullCtx.getImageData(0, 0, w, h);

  // Slicing igual — mesmo método do train.py (4 partes iguais).
  // detectCharBoxes desativado: as linhas de ruído confundem o detector.
  const q = w / _meta.n_chars;
  const boxes = [];
  for (let i = 0; i < _meta.n_chars; i++) {
    boxes.push([Math.floor(i * q), Math.floor((i + 1) * q)]);
  }

  const cw = _meta.char_w;
  const ch = _meta.char_h;
  const tensorData = new Float32Array(_meta.n_chars * 3 * ch * cw);

  for (let i = 0; i < _meta.n_chars; i++) {
    let [s, e] = boxes[i];
    s = Math.max(0, s - 2);
    e = Math.min(w, e + 3);

    const charCanvas = document.createElement('canvas');
    charCanvas.width = cw; charCanvas.height = ch;
    const charCtx = charCanvas.getContext('2d');
    charCtx.fillStyle = 'white';
    charCtx.fillRect(0, 0, cw, ch);
    charCtx.drawImage(fullCanvas, s, 0, e - s, h, 0, 0, cw, ch);
    const charData = charCtx.getImageData(0, 0, cw, ch).data;

    const planeSize = ch * cw;
    const baseR = i * 3 * planeSize + 0 * planeSize;
    const baseG = i * 3 * planeSize + 1 * planeSize;
    const baseB = i * 3 * planeSize + 2 * planeSize;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const px = (y * cw + x) * 4;
        const off = y * cw + x;
        tensorData[baseR + off] = charData[px + 0] / 255;
        tensorData[baseG + off] = charData[px + 1] / 255;
        tensorData[baseB + off] = charData[px + 2] / 255;
      }
    }
  }

  return new ort.Tensor('float32', tensorData, [_meta.n_chars, 3, ch, cw]);
}

function detectCharBoxes(imageData, w, h) {
  const data = imageData.data;
  const charPx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const gray = (r + g + b) / 3;
      if ((max - min) >= 25 || gray < 120) charPx[y * w + x] = 1;
    }
  }
  const hasStroke = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y <= h - 3; y++) {
      if (charPx[y*w+x] && charPx[(y+1)*w+x] && charPx[(y+2)*w+x]) {
        hasStroke[x] = 1; break;
      }
    }
  }
  const groups = [];
  let start = -1, lastTrue = -1;
  const gapTol = 3, minLen = 4;
  for (let x = 0; x < w; x++) {
    if (hasStroke[x]) {
      if (start < 0 || (x - lastTrue) > gapTol) {
        if (start >= 0) groups.push([start, lastTrue + 1]);
        start = x;
      }
      lastTrue = x;
    }
  }
  if (start >= 0) groups.push([start, lastTrue + 1]);
  let filtered = groups.filter(g => (g[1] - g[0]) >= minLen);
  if (filtered.length > 4) {
    filtered.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    filtered = filtered.slice(0, 4);
    filtered.sort((a, b) => a[0] - b[0]);
  }
  return filtered;
}

function decodeWithFormat(logits, chars, nChars) {
  const numClasses = chars.length;
  const probs = new Float32Array(nChars * numClasses);
  for (let i = 0; i < nChars; i++) {
    const off = i * numClasses;
    let maxL = -Infinity;
    for (let j = 0; j < numClasses; j++) if (logits[off + j] > maxL) maxL = logits[off + j];
    let sum = 0;
    for (let j = 0; j < numClasses; j++) {
      const v = Math.exp(logits[off + j] - maxL);
      probs[off + j] = v;
      sum += v;
    }
    for (let j = 0; j < numClasses; j++) probs[off + j] /= sum;
  }
  const greedy = new Array(nChars);
  for (let i = 0; i < nChars; i++) {
    let mx = -1, ix = 0;
    for (let j = 0; j < numClasses; j++) {
      if (probs[i * numClasses + j] > mx) { mx = probs[i * numClasses + j]; ix = j; }
    }
    greedy[i] = ix;
  }
  // Score de confiança: produto das probs dos chars escolhidos (greedy)
  const greedyScore = greedy.reduce((acc, ix, i) => acc * probs[i * numClasses + ix], 1);
  const greedyText = greedy.map(i => chars[i]).join('');
  if (validFormat(greedyText)) return { text: greedyText, score: greedyScore };

  // Busca top-5 por posição — encontra a combinação válida com maior log-prob
  const K = 5;
  const topIdx = [];
  for (let i = 0; i < nChars; i++) {
    const slice = [];
    for (let j = 0; j < numClasses; j++) slice.push([j, probs[i * numClasses + j]]);
    slice.sort((a, b) => b[1] - a[1]);
    topIdx.push(slice.slice(0, K).map(x => x[0]));
  }
  let bestText = greedyText, bestScore = -Infinity, bestProb = greedyScore;
  for (let a = 0; a < K; a++)
  for (let b = 0; b < K; b++)
  for (let c = 0; c < K; c++)
  for (let d = 0; d < K; d++) {
    const idxs = [topIdx[0][a], topIdx[1][b], topIdx[2][c], topIdx[3][d]];
    const text = idxs.map(i => chars[i]).join('');
    if (!validFormat(text)) continue;
    let s = 0, p = 1;
    for (let i = 0; i < nChars; i++) {
      s += Math.log(probs[i * numClasses + idxs[i]] + 1e-12);
      p *= probs[i * numClasses + idxs[i]];
    }
    if (s > bestScore) { bestScore = s; bestText = text; bestProb = p; }
  }
  return { text: bestText, score: bestProb };
}

function validFormat(s) {
  if (s.length !== 4) return false;
  let upper = 0, lower = 0, digits = 0;
  for (const c of s) {
    if (/[A-Z]/.test(c)) upper++;
    else if (/[a-z]/.test(c)) lower++;
    else if (/[0-9]/.test(c)) digits++;
  }
  return upper === 1 && lower === 1 && digits === 2;
}


// ──────────────── Mensagens do SW ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.type === 'ocr') {
    runOcr(msg.imageUrl)
      .then(({ text, score }) => sendResponse({ ok: true, text, score }))
      .catch(e => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;   // async response
  }
  return false;
});
