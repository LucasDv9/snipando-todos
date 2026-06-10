// Prize Sniper V7 — Botcode
// Hot-loaded no MAIN world pelo shell. Toda lógica de jogo vive aqui.
// Não tem chrome.*, não fala com a Anthropic. Usa psRequest() pro shell fazer tudo.

// ============================================================
// MÓDULO 1 — FUNDAÇÃO
// ============================================================

(function () {
  'use strict';

  // Spoof da Visibility API + rAF — impede que a página pare de renderizar o
  // canvas quando a aba está em background.
  //
  // document.hidden / visibilityState: engana código da página que verifica
  // visibilidade antes de pintar.
  // requestAnimationFrame override: o browser throttla rAF em background
  // independente do que a página pensa. Substituindo por setTimeout(fn, 16)
  // o loop de render do captcha roda normalmente mesmo sem foco.
  // Seguro pra múltiplas abas — cada override é isolado no próprio documento.
  try {
    Object.defineProperty(document, 'hidden',          { get: () => false,     configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  } catch (_) {}
  try {
    const _realRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      if (document.visibilityState === 'hidden') return setTimeout(() => cb(performance.now()), 16);
      return _realRaf(cb);
    };
  } catch (_) {}

  // ---------- Hot-swap: limpa versão anterior se existir ----------
  if (typeof window._prizeSniperCleanup === 'function') {
    try { window._prizeSniperCleanup(); } catch (e) { console.warn('[PS] cleanup erro:', e); }
  }

  // ---------- Config fixa ----------
  const DEBOUNCE_LOG_FLUSH_MS = 500;
  const LOG_BUFFER_MAX        = 100;
  const PS_REQUEST_TIMEOUT_MS = 30000;

  // ---------- State machine (simplificada: 4 estados) ----------
  const STATES = {
    IDLE:    'IDLE',     // esperando prize aparecer
    OTP:     'OTP',      // clicou no prize, lidando com OTP (captura → digitação → confirmação)
    BETTING: 'BETTING',  // auto-aposta em andamento
    ERROR:   'ERROR',    // algo quebrou, esperando recuperação (reload, popup, etc)
  };

  let state          = STATES.IDLE;
  let botcodeVersion = null;

  // ---------- Config (load/save via storage no Módulo 12) ----------
  let cfg = {
  valorMinimo: 0.10,
  cashout:     1.50,
  somAtivo:    true,
  autoApostar: false,
  modoManual:  false,
  paused:      false,
  hudPos:      null,
  hudMinimized: false,
  otpDelay:    4000,  // ← novo: delay em ms antes de iniciar o OTP
};

  function saveCfg() {
    try { storageSet({ ps_cfg: Object.assign({}, cfg) }); } catch (e) {}
  }

  // ---------- Event bus interno (usado por todos os módulos) ----------
  const bus = (function () {
    const handlers = new Map();
    return {
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
        return () => handlers.get(event).delete(fn);
      },
      emit(event, data) {
        const set = handlers.get(event);
        if (!set) return;
        for (const fn of set) {
          try { fn(data); } catch (e) { console.warn('[PS] bus handler erro', event, e); }
        }
      },
      clear() { handlers.clear(); },
    };
  })();

  // ---------- Recursos rastreados para cleanup ----------
  const intervals      = new Set();
  const timeouts       = new Set();
  const eventListeners = [];  // { target, event, handler, options }

  function trackInterval(fn, ms) {
    const id = setInterval(fn, ms);
    intervals.add(id);
    return id;
  }

  function trackTimeout(fn, ms) {
    const id = setTimeout(() => { timeouts.delete(id); fn(); }, ms);
    timeouts.add(id);
    return id;
  }

  function trackListener(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    eventListeners.push({ target, event, handler, options });
  }

  // ---------- Bridge MAIN → shell (sw.js) ----------
  // O loader.js (ISOLATED) escuta PS_REQUEST no window, encaminha pro background,
  // e posta PS_RESPONSE de volta. Aqui no MAIN só tocamos window.postMessage.

  let nextRequestId = 0;
  const pending = new Map();  // id → { resolve, reject }

  trackListener(window, 'message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.type !== 'PS_RESPONSE' || typeof d.id !== 'number') return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error) p.reject(new Error(d.error));
    else         p.resolve(d.result);
  });

  function psRequest(action, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++nextRequestId;
      pending.set(id, { resolve, reject });
      window.postMessage({ type: 'PS_REQUEST', id, action, body: body || {} }, '*');
      trackTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('psRequest timeout: ' + action));
        }
      }, timeoutMs || PS_REQUEST_TIMEOUT_MS);
    });
  }

  // ---------- Storage wrapper ----------
  async function storageGet(keys) {
    const r = await psRequest('storageGet', { keys: Array.isArray(keys) ? keys : [keys] });
    return r && r.data ? r.data : {};
  }

  async function storageSet(data) {
    return psRequest('storageSet', { data });
  }

  // ---------- Logger com buffer + flush debounced pra storage ----------
  const logs = [];
  let flushTimer = null;

  function stringifyArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error)    return a.message;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }

  function flushLogs() {
    flushTimer = null;
    storageSet({ ps_logs: logs.slice() }).catch(() => {});
  }

  function log(...args) {
    const hh   = new Date().toTimeString().slice(0, 8);
    const msg  = args.map(stringifyArg).join(' ');
    const line = '[' + hh + '] ' + msg;

    // console colorido
    console.log('%c[PS]%c ' + args[0], 'color:#a78bfa;font-weight:bold', 'color:inherit', ...args.slice(1));

    // buffer rolling
    logs.push(line);
    if (logs.length > LOG_BUFFER_MAX) {
      logs.splice(0, logs.length - LOG_BUFFER_MAX);
    }

    // flush debounced
    if (!flushTimer) {
      flushTimer = setTimeout(flushLogs, DEBOUNCE_LOG_FLUSH_MS);
      timeouts.add(flushTimer);
    }

    // Notifica HUD log-line
    try { bus.emit('log', msg); } catch (e) {}
  }

  function setState(next) {
    if (state === next) return;
    const prev = state;
    log('state', prev, '→', next);
    state = next;
    try { bus.emit('state-changed', { prev, next }); } catch (e) {}
  }

  function getState() { return state; }

  // ---------- Cleanup hook ----------
  window._prizeSniperCleanup = function () {
    log('cleanup chamado — derrubando versão ' + (botcodeVersion || '?'));

    for (const id of intervals) clearInterval(id);
    intervals.clear();

    for (const id of timeouts) clearTimeout(id);
    timeouts.clear();

    for (const { target, event, handler, options } of eventListeners) {
      try { target.removeEventListener(event, handler, options); } catch (e) {}
    }
    eventListeners.length = 0;

    pending.clear();
    bus.clear();

    if (prizeObserver) { try { prizeObserver.disconnect(); } catch (e) {} prizeObserver = null; }

    if (hudEl)      { try { hudEl.remove();      } catch (e) {} hudEl      = null; }
    if (hudStyleEl) { try { hudStyleEl.remove(); } catch (e) {} hudStyleEl = null; }

    _autoApostaAtiva = false;

    // flush final dos logs direto (sem debounce)
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    try {
      window.postMessage({
        type: 'PS_REQUEST',
        id: -1,
        action: 'storageSet',
        body: { data: { ps_logs: logs.slice() } },
      }, '*');
    } catch (e) {}

    // HUD, observers, etc serão adicionados ao cleanup nos próximos módulos

    delete window._prizeSniperCleanup;
  };

  // ============================================================
  // MÓDULO 2 — WS LISTENER
  // ============================================================
  // Subscreve o evento genérico `ps:ws-message` emitido pelo ws-hook.js do shell,
  // parseia o JSON, e traduz pra eventos semânticos no bus:
  //   - 'otp-rejected' → { msg }   (msg.code === 4014 ou message "incorrect parameters")
  //   - 'prize-storm'  → { valor, data }
  //
  // O captcha NÃO é mais disparado pelo WS — o protocolo do servidor mudou e
  // a URL antiga ficou inacessível. O trigger do flow OTP é 100% DOM-driven
  // (ver setupOtpFlow → runOtpAttempt).

  function setupWsListener() {
    trackListener(window, 'ps:ws-message', (event) => {
      const raw = event && event.detail && event.detail.raw;
      if (!raw) return;

      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;



      // OTP rejeitado — servidor agora manda { code: 1, message: "incorrect parameters" }
      // (era 4014 em versões antigas). Checamos pela mensagem que é o identificador estável.
      if (msg.message === 'incorrect parameters' || msg.code === 4014) {
        log('ws OTP rejeitado');
        bus.emit('otp-rejected', { msg });
        return;
      }

      // Prize Storm anunciado — chega ANTES do botão renderizar, independente do chat
      if (msg.command === 'freeBetsStorm' && msg.data) {
        var valor = msg.data.freeBetAmount || 0;
        log('ws prize storm R$' + valor.toFixed(2) + ' (count:' + (msg.data.freeBetsCount || '?') + ')');
        bus.emit('prize-storm', { valor: valor, data: msg.data });
        return;
      }
    });

    log('ws listener armado');
  }

  // ============================================================
  // MÓDULO 2B — ENSURE CHAT OPEN (abre o chat quando prize storm chega)
  // ============================================================

  function isChatOpen() {
    return !!document.querySelector(
      '.chatPrizeStormsWrapper, .chatPrizeStormTable, .chatHolder, textarea.chatInput'
    );
  }

  function ensureChatOpen() {
    if (isChatOpen()) return;
    var btn = document.querySelector('.flyChatButton button.flyUserActionButton, .flyChatButton .flyUserActionButton');
    if (btn) {
      log('chat fechado — abrindo');
      clickEl(btn);
    }
  }

  function setupPrizeStormHandler() {
    bus.on('prize-storm', function (d) {
      if (cfg.paused) return;

      // Filtra por valor mínimo
      if (d.valor > 0 && d.valor < cfg.valorMinimo) {
        log('prize storm ignorado R$' + d.valor.toFixed(2) + ' (< mínimo R$' + cfg.valorMinimo.toFixed(2) + ')');
        return;
      }

      // Abre o chat se estiver fechado — o checkSnipe pega o botão quando renderizar
      ensureChatOpen();
    });
  }

  // ============================================================
  // MÓDULO 3 — DETECTOR DE PRIZE (MutationObserver + fallback polling)
  // ============================================================
  // Estratégia híbrida:
  // - MutationObserver no document.body (subtree) reage no instante em que qualquer
  //   DOM novo aparece. Callback coalescido via queueMicrotask, então 1000 mutations
  //   viram 1 checkSnipe() por tick.
  // - Fallback setInterval a cada 2s cobre o caso (improvável) do observer perder algo.
  //
  // checkSnipe() só roda quando state === IDLE. Varre .chatPrizeStormClaimBtn,
  // filtra por texto "reivindicar", extrai valor da .chatPrizeStormTr, descarta
  // abaixo do valorMinimo (marcando data-ps-ignored pra não re-escanear), escolhe
  // o maior valor e emite 'prize-detected' no bus.

  let prizeObserver = null;
  let lastClaimTime = 0;
  const SNIPE_DEBOUNCE_MS = 500;  // mesmo valor do bot antigo

  function checkSnipe() {
    if (state !== STATES.IDLE) return;
    if (cfg.paused) return;

    const now = Date.now();
    if (now - lastClaimTime < SNIPE_DEBOUNCE_MS) return;

    const btns = document.querySelectorAll('.chatPrizeStormClaimBtn:not([data-ps-ignored="true"])');
    if (btns.length === 0) return;

    const candidatos = [];
    for (const btn of btns) {
      if (btn.disabled) continue;
      const txt = (btn.textContent || '').toLowerCase().trim();
      if (!txt.includes('reivindicar')) continue;

      const row = btn.closest('.chatPrizeStormTr');
      let valor = -1;
      if (row) {
        const m = row.textContent.match(/R\$\s*(\d+)[.,](\d{2})/i);
        if (m) valor = parseFloat(m[1] + '.' + m[2]);
      }

      if (valor !== -1 && valor < cfg.valorMinimo) {
        btn.setAttribute('data-ps-ignored', 'true');
        btn.style.opacity = '0.3';
        log('prize ignorado R$' + valor.toFixed(2) + ' (< mínimo R$' + cfg.valorMinimo.toFixed(2) + ')');
        continue;
      }

      if (valor === -1) {
        log('prize detectado mas valor não extraído (row textContent sem R$ X,YY)');
      }

      candidatos.push({ btn, valor, row });
    }

    if (candidatos.length === 0) return;

    candidatos.sort((a, b) => b.valor - a.valor);
    const best = candidatos[0];

    lastClaimTime = now;
    const valorStr = best.valor >= 0 ? best.valor.toFixed(2) : '?';
    log('prize detectado R$' + valorStr);
    bus.emit('prize-detected', best);
  }

  // ============================================================
  // MÓDULO 4 — CLIQUE ESTRATÉGICO
  // ============================================================
  // 3 estratégias de click rodam em sequência contra o botão (o custo é ~0,
  // a chance de pelo menos uma funcionar é ~100% contra qualquer framework):
  //   - forceReactClick: procura __reactProps$/__reactFiber$ no fiber interno e
  //     chama o onClick diretamente (engana React mesmo sem evento real)
  //   - simulateClick: dispara sequência pointerdown → mousedown → pointerup →
  //     mouseup → click + touchstart/touchend (pra handlers mobile)
  //   - native click(): fallback do próprio elemento
  // Também clica no <span> interno, porque às vezes o onClick vive nele.

  let capturedCount = 0;
  let lastCapturedValor = null;
  let otpTimeoutId = null;
  const OTP_POPUP_TIMEOUT_MS = 120000;

  function forceReactClick(el) {
    try {
      const key = Object.keys(el).find(k =>
        k.startsWith('__reactProps$')          ||
        k.startsWith('__reactEventHandlers$')  ||
        k.startsWith('__reactFiber$')          ||
        k.startsWith('__reactInternalInstance$')
      );
      if (!key) return false;
      const props = (el[key] && el[key].memoizedProps) || el[key];
      if (!props || typeof props.onClick !== 'function') return false;
      props.onClick({
        bubbles: true, cancelable: true, isTrusted: true,
        preventDefault: () => {}, stopPropagation: () => {},
        target: el, currentTarget: el,
      });
      return true;
    } catch (e) { return false; }
  }

  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width  / 2;
    const y = rect.top  + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, buttons: 1, clientX: x, clientY: y, isTrusted: true };

    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t => {
      try { el.dispatchEvent(new MouseEvent(t, opts)); } catch (e) {}
    });

    try {
      const touch = new Touch({ identifier: Date.now(), target: el, clientX: x, clientY: y, pageX: x, pageY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
      el.dispatchEvent(new TouchEvent('touchend',   { bubbles: true, cancelable: true, touches: [],      targetTouches: [],      changedTouches: [touch] }));
    } catch (e) {}
  }

  function clickPrize(btn) {
    forceReactClick(btn);
    simulateClick(btn);
    try { btn.click(); } catch (e) {}

    // Às vezes o onClick vive no <span> interno
    const span = btn.querySelector('.chatPrizeStormClaimBtnText');
    if (span) forceReactClick(span);
  }

  function flashBtn(btn) {
    try {
      btn.style.transition = 'box-shadow 0.3s';
      btn.style.boxShadow  = '0 0 15px 5px #a78bfa';
    } catch (e) {}
  }

  function beep() {
    if (!cfg.somAtivo) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.15, 0.30].forEach(delay => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.4, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.12);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime  + delay + 0.12);
      });
    } catch (e) {}
  }

  function setupClicker() {
    bus.on('prize-detected', (d) => {
      if (state !== STATES.IDLE) return;

      const valorStr = d.valor >= 0 ? d.valor.toFixed(2) : '?';
      log('SNIPE R$' + valorStr);

      flashBtn(d.btn);
      clickPrize(d.btn);

      capturedCount++;
      lastCapturedValor = d.valor >= 0 ? d.valor : null;

      beep();
      setState(STATES.OTP);

      // Timeout: se nada acontecer em 8s, volta pra IDLE (prize fantasma, etc)
      if (otpTimeoutId) {
        clearTimeout(otpTimeoutId);
        timeouts.delete(otpTimeoutId);
      }
      otpTimeoutId = trackTimeout(() => {
        otpTimeoutId = null;
        if (state === STATES.OTP) {
          log('timeout OTP (' + (OTP_POPUP_TIMEOUT_MS / 1000) + 's) — voltando pra IDLE');
          setState(STATES.IDLE);
        }
      }, OTP_POPUP_TIMEOUT_MS);

      bus.emit('prize-clicked', { btn: d.btn, valor: d.valor });
    });
  }

  // ============================================================
  // MÓDULOS 13 + 15 — AUTO-APOSTA + CHECK PERIÓDICO
  // ============================================================
  // Disparado quando OTP é aceito (bus 'otp-success'), se cfg.autoApostar ligado.
  // Espera 5s, abre o menu de Apostas Grátis, joga/resgata/cancela/aguarda num
  // loop até o badge de prizes zerar.
  //
  // Check periódico (Módulo 15): a cada 5 min, se idle e não em auto-aposta,
  // varre prizes pra resgatar que podem ter ficado pra trás.

  const AUTO_APOSTA_DELAY_AFTER_OTP_MS = 5000;
  const CHECK_PERIODICO_INTERVAL_MS    = 5 * 60 * 1000;

  let _autoApostaAtiva = false;
  const _prizesIgnorados     = new Set();
  const _tentativasResgatar  = {};

  // ------ Helpers ------
  function isVisibleAndActive(el) {
    if (!el) return false;
    if (el.disabled) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none')     return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) < 0.5) return false;
    return true;
  }

  function clickEl(el) {
    if (!el) return false;
    forceReactClick(el);
    simulateClick(el);
    try { el.click(); } catch (e) {}
    return true;
  }

  async function aguardar(fn, ms) {
    const t = Date.now();
    while (Date.now() - t < (ms || 30000)) {
      try { if (fn()) return true; } catch (e) {}
      await sleep(100);
    }
    return false;
  }

  function getPrizeBadgeCount() {
    const badge = document.querySelector('.freeBetPlayCount');
    if (!badge) return 0;
    const n = parseInt(badge.textContent.trim(), 10);
    return isNaN(n) ? 0 : n;
  }

  function getBotaoApostaGratis() {
    const bloco = document.querySelector('div.betSectionBlock.free-bet');
    if (!bloco) return null;
    const btn = bloco.querySelector('button.betButton.start');
    if (!btn || btn.disabled || !isVisibleAndActive(btn)) return null;
    return btn;
  }

  function getBotaoResgatar() {
    const btn = document.querySelector('button.freeBetPlayButton.claim');
    if (btn && isVisibleAndActive(btn)) return btn;
    return null;
  }

  function getBotaoCancelar() {
    if (getBotaoResgatar()) return null;
    const btn = document.querySelector('button.freeBetPlayButton.cancel, button.freeBetPlayButton.cashout');
    if (btn && isVisibleAndActive(btn)) return btn;
    return null;
  }

  function getFreeBetsUsageCount() {
    const countEl = document.querySelector('div.freeBetsCount');
    if (!countEl) return 0;
    const style = window.getComputedStyle(countEl);
    if (style.display === 'none' || style.visibility === 'hidden') return 0;
    const n = parseInt(countEl.textContent.trim(), 10);
    return isNaN(n) ? 0 : n;
  }

  async function configurarCashout() {
    const sw = document.querySelector('.autoPlaySwitcher, .forAvi.switcher');
    if (sw && !sw.classList.contains('active')) { clickEl(sw); await sleep(300); }
    const input = document.querySelector('input.autoPlayTagInput');
    if (input) {
      setReactValue(input, cfg.cashout.toFixed(2).replace('.', ','));
      await sleep(150);
    }
  }

  async function expandirPrize(row) {
    const jaExpandido = row.querySelector('p.playerCollapsedBalance');
    if (jaExpandido) return;
    const btn = row.querySelector('button.playerCollapseButton');
    if (btn) { clickEl(btn); await sleep(300); }
  }

  function getPrizeId(row) {
    const cols = row.querySelectorAll('span.playerCollapsedTitle');
    for (const col of cols) {
      if (col.textContent.trim() === 'ID') {
        const holder = col.closest('.playerCollapsedColumn');
        const p = holder && holder.querySelector('p.playerCollapsedBalance');
        if (p && p.textContent.trim()) return 'id_' + p.textContent.trim();
      }
    }
    const textoRow = row.textContent.replace(/\s+/g, ' ').trim();
    if (textoRow.length > 5) return 'txt_' + textoRow.slice(0, 50);
    const todos = Array.from(document.querySelectorAll('div.playerFreeBetRow:not(.head)'));
    return 'idx_' + todos.indexOf(row);
  }

  async function getPrizeIdAsync(row) {
    let id = getPrizeId(row);
    if (id.startsWith('id_')) return id;
    await expandirPrize(row);
    return getPrizeId(row);
  }

  // ------ Entry point ------
  async function iniciarAutoAposta() {
    if (state === STATES.BETTING) return;
    if (!cfg.autoApostar)          return;
    if (cfg.paused)                return;
    if (getPrizeBadgeCount() === 0) return;

    setState(STATES.BETTING);
    _autoApostaAtiva = true;
    log('auto-aposta iniciada');

    try {
      await executarAutoAposta();
    } catch (e) {
      log('auto-aposta erro: ' + (e && e.message || e));
    } finally {
      _autoApostaAtiva = false;
      // Fecha menu se ficou aberto
      const menu = document.querySelector('div.settingsContentHolder');
      if (menu) { const sb = document.querySelector('button.settingsButton'); if (sb) clickEl(sb); }
      setState(STATES.IDLE);
      log('auto-aposta concluída');
    }
  }

  // ------ Main loop ------
  async function executarAutoAposta() {
    while (_autoApostaAtiva && cfg.autoApostar && !cfg.paused) {
      // 1. Resgatar: se aparecer botão claim, clica
      const resgatar = getBotaoResgatar();
      if (resgatar) {
        const prizeAtivoEl  = document.querySelector('span.playerFreeBetRowText.active');
        const prizeRowAtivo = prizeAtivoEl && prizeAtivoEl.closest('div.playerFreeBetRow');
        const prizeIdAtivo  = prizeRowAtivo ? getPrizeId(prizeRowAtivo) : 'ativo';

        if (_prizesIgnorados.has(prizeIdAtivo)) { await sleep(500); continue; }

        if (!_tentativasResgatar[prizeIdAtivo]) _tentativasResgatar[prizeIdAtivo] = 0;
        _tentativasResgatar[prizeIdAtivo]++;

        if (_tentativasResgatar[prizeIdAtivo] > 2) {
          _prizesIgnorados.add(prizeIdAtivo);
          delete _tentativasResgatar[prizeIdAtivo];
          await sleep(500);
          continue;
        }

        log('resgatando... tentativa ' + _tentativasResgatar[prizeIdAtivo]);
        let ganhoValor = 0;
        try {
          const prizeRow = resgatar.closest('div.playerFreeBetRow');
          if (prizeRow) {
            const ganhoSpan = prizeRow.querySelector('span.commonPopupTimer');
            if (ganhoSpan) {
              const m = ganhoSpan.textContent.match(/R\$\s*(\d+)[.,](\d{2})/i);
              if (m) ganhoValor = parseFloat(m[1] + '.' + m[2]);
            }
          }
        } catch (e) {}

        clickEl(resgatar);
        await sleep(2000);

        if (!getBotaoResgatar()) {
          delete _tentativasResgatar[prizeIdAtivo];
          if (ganhoValor > 0) log('resgatado R$' + ganhoValor.toFixed(2));
        }
        continue;
      }

      // 2. Cancelar: se aparecer botão cancel/cashout
      const cancelar = getBotaoCancelar();
      if (cancelar) {
        log('cancelando aposta anterior');
        clickEl(cancelar);
        await sleep(1500);
        continue;
      }

      // 3. Apostar: se aparecer botão de aposta free bet no painel
      const aposta = getBotaoApostaGratis();
      if (aposta) {
        await configurarCashout();
        log('apostando free bet (cashout ' + cfg.cashout.toFixed(2) + 'x)');
        clickEl(aposta);
        await aguardar(() => !getBotaoApostaGratis() || getBotaoResgatar() || getBotaoCancelar(),  6000);
        await aguardar(() =>  getBotaoApostaGratis() || getBotaoResgatar() || getBotaoCancelar(), 35000);
        await sleep(500);

        const usosRestantes = getFreeBetsUsageCount();
        if (usosRestantes > 0) {
          log('usos restantes: ' + usosRestantes);
          await aguardar(() => getBotaoApostaGratis() !== null, 15000);
        }
        continue;
      }

      // 4. Aguardando round terminar (tem usos ativos mas sem botão visível)
      const usosAtivos = getFreeBetsUsageCount();
      if (usosAtivos > 0 && !getBotaoResgatar() && !getBotaoCancelar()) {
        log('aguardando próximo round (' + usosAtivos + ' usos)');
        await aguardar(() => getBotaoApostaGratis() || getBotaoResgatar() || getBotaoCancelar(), 15000);
        continue;
      }

      // 5. Nada ativo — verifica se ainda tem prize no badge
      if (getPrizeBadgeCount() === 0) break;

      // 6. Abre menu de configurações se não estiver aberto
      if (!document.querySelector('div.settingsContentHolder')) {
        log('abrindo menu');
        const sb = document.querySelector('button.settingsButton');
        if (sb) clickEl(sb);
        await aguardar(() => !!document.querySelector('div.settingsContentHolder'), 3000);
      }

      // 7. Abre aba Apostas Grátis se não estiver aberta
      if (!document.querySelector('button.freeBetPlayButton.play')) {
        log('abrindo aba apostas grátis');
        const item = document.querySelector('div.settingsRowColumn.freeBets');
        if (!item) { await sleep(500); continue; }
        const row = item.closest('div.settingsRow') || item;
        clickEl(row);
        await aguardar(() => !!document.querySelector('button.freeBetPlayButton.play'), 3000);
      }

      // 8. Acha próximo prize "jogável" que não tá na blacklist
      const todosJogar = Array.from(document.querySelectorAll('button.freeBetPlayButton.play:not([disabled])'));
      let jogar = null;
      for (const btn of todosJogar) {
        const row = btn.closest('div.playerFreeBetRow');
        if (row) {
          const prizeId = await getPrizeIdAsync(row);
          if (_prizesIgnorados.has(prizeId)) continue;
        }
        jogar = btn; break;
      }

      if (!jogar) {
        log('nenhum prize disponível — encerrando loop');
        const sb = document.querySelector('button.settingsButton');
        if (sb) clickEl(sb);
        break;
      }

      log('clicando Jogar');
      clickEl(jogar);

      const ok = await aguardar(() => getBotaoApostaGratis() !== null, 60000);
      if (!ok) {
        log('prize não ativou em 60s — encerrando');
        const sb = document.querySelector('button.settingsButton');
        if (sb) clickEl(sb);
        break;
      }
    }
  }

  // ------ Check periódico (Módulo 15) ------
  async function checkPeriodicoResgatar() {
    if (state !== STATES.IDLE || _autoApostaAtiva) return;

    log('check periódico — verificando prizes pra resgatar');

    if (!document.querySelector('div.settingsContentHolder')) {
      const sb = document.querySelector('button.settingsButton');
      if (sb) clickEl(sb);
      await aguardar(() => !!document.querySelector('div.settingsContentHolder'), 3000);
    }
    if (!document.querySelector('button.freeBetPlayButton')) {
      const item = document.querySelector('div.settingsRowColumn.freeBets');
      if (!item) {
        const sb = document.querySelector('button.settingsButton');
        if (sb) clickEl(sb);
        return;
      }
      const row = item.closest('div.settingsRow') || item;
      clickEl(row);
      await aguardar(() => !!document.querySelector('button.freeBetPlayButton'), 3000);
    }

    const prizes = Array.from(document.querySelectorAll('div.playerFreeBetRow:not(.head)'));
    let encontrou = false;
    for (const prize of prizes) {
      const prizeId = await getPrizeIdAsync(prize);
      if (_prizesIgnorados.has(prizeId)) continue;

      const claimBtn = prize.querySelector('button.freeBetPlayButton.claim');
      if (!claimBtn || !isVisibleAndActive(claimBtn)) continue;

      encontrou = true;
      log('check periódico — resgatando prize pendente');

      if (!_tentativasResgatar[prizeId]) _tentativasResgatar[prizeId] = 0;
      _tentativasResgatar[prizeId]++;

      if (_tentativasResgatar[prizeId] > 2) {
        _prizesIgnorados.add(prizeId);
        continue;
      }

      clickEl(claimBtn);
      await sleep(2000);

      const aindaLa = prize.querySelector('button.freeBetPlayButton.claim');
      if (aindaLa && isVisibleAndActive(aindaLa)) {
        if (_tentativasResgatar[prizeId] >= 2) _prizesIgnorados.add(prizeId);
      } else {
        delete _tentativasResgatar[prizeId];
      }
    }

    if (!encontrou) log('check periódico — nenhum prize pendente');

    // Fecha popup e menu
    const closePopup = document.querySelector('button.commonPopupClose');
    if (closePopup) { clickEl(closePopup); await sleep(400); }
    const menu = document.querySelector('div.settingsContentHolder');
    if (menu) {
      const sb = document.querySelector('button.settingsButton');
      if (sb) clickEl(sb);
      await sleep(400);
    }
  }

  // onOtpDone: chamado ao fim de QUALQUER ciclo OTP — sucesso, rejeição
  // terminal, timeout, max retries ou botão sumiu. O resultado do OTP não
  // importa: sempre espera 5s (UI estabilizar/badge atualizar) e checa se
  // há prize pendente. Se houver, dispara auto-aposta.
  async function onOtpDone() {
    currentPrizeBtn = null;
    currentAttempt  = 0;

    // Caso 1: OTP aconteceu DURANTE auto-aposta em andamento (prize storm no
    // meio do betting). Volta pro BETTING pra auto-aposta continuar.
    if (_autoApostaAtiva) {
      setState(STATES.BETTING);
      return;
    }

    // Caso 2: auto-aposta desligada ou bot pausado. IDLE e pronto.
    if (!cfg.autoApostar || cfg.paused) {
      setState(STATES.IDLE);
      return;
    }

    // Caso 3: auto-aposta ligada. Volta pra IDLE, aguarda 5s, e só então
    // checa badge. Se tiver prize pendente, dispara auto-aposta.
    setState(STATES.IDLE);
    log('fim do ciclo OTP — aguardando ' + (AUTO_APOSTA_DELAY_AFTER_OTP_MS / 1000) + 's pra checar badge');
    await sleep(AUTO_APOSTA_DELAY_AFTER_OTP_MS);

    // Re-validar tudo DEPOIS do sleep — estado e config podem ter mudado
    if (!cfg.autoApostar || cfg.paused)   return;
    if (state !== STATES.IDLE)            return;  // outro prize capturou, etc
    const badge = getPrizeBadgeCount();
    if (badge === 0) {
      log('sem prize pendente — fim');
      return;
    }

    setState(STATES.BETTING);
    _autoApostaAtiva = true;
    log('auto-aposta iniciada (badge=' + badge + ')');

    try {
      await executarAutoAposta();
    } catch (e) {
      log('auto-aposta erro: ' + (e && e.message || e));
    } finally {
      _autoApostaAtiva = false;
      var menu = document.querySelector('div.settingsContentHolder');
      if (menu) { var sb = document.querySelector('button.settingsButton'); if (sb) clickEl(sb); }
      setState(STATES.IDLE);
      log('auto-aposta concluída');
    }
  }

  function setupCheckPeriodico() {
    trackInterval(() => {
      if (!cfg.autoApostar) return;
      if (cfg.paused)       return;
      if (state !== STATES.IDLE) return;
      if (_autoApostaAtiva) return;
      checkPeriodicoResgatar().catch(e => log('check periódico erro: ' + (e && e.message || e)));
    }, CHECK_PERIODICO_INTERVAL_MS);
  }

  // ============================================================
  // MÓDULO 11+12 — HUD + CONFIG
  // ============================================================
  // HUD glassmorphism minimalista, canto inferior direito (arrastável).
  // Mostra status, capturados, último prize, sessão, expiração, valor mínimo,
  // toggles auto/manual, cashout, log-line, botão pause.
  // Config é persistida em chrome.storage via saveCfg() a cada alteração.

  let hudEl           = null;
  let hudStyleEl      = null;
  const sessionStart  = Date.now();
  let lastPrizeStr    = '—';

  function setupHud() {
    if (hudEl) return;

    // ------ Style tag ------
    hudStyleEl = document.createElement('style');
    hudStyleEl.id = 'prize-sniper-hud-styles';
    hudStyleEl.textContent = HUD_CSS;
    document.head.appendChild(hudStyleEl);

    // ------ HUD element ------
    hudEl = document.createElement('div');
    hudEl.id = 'prize-sniper-hud';
    hudEl.innerHTML = buildHudHtml();

    const mount = () => {
      if (!document.body) { setTimeout(mount, 50); return; }
      document.body.appendChild(hudEl);
      positionHud();
      bindHudEvents();
      refreshHudAll();

      // Sub pro bus
      bus.on('state-changed',  () => updateHudStatus());
      bus.on('prize-clicked',  (d) => {
        if (d && d.valor >= 0) lastPrizeStr = 'R$ ' + d.valor.toFixed(2).replace('.', ',');
        const els = hudEl && hudEl.querySelector('#ps-captured');
        if (els) els.textContent = String(capturedCount);
        const lastEl = hudEl && hudEl.querySelector('#ps-last');
        if (lastEl) lastEl.textContent = lastPrizeStr;
      });
      bus.on('log', (msg) => {
        const el = hudEl && hudEl.querySelector('#ps-hud-log');
        if (el) el.textContent = '▸ ' + msg;
      });

      // Atualizadores periódicos
      trackInterval(updateHudSession, 30 * 1000);
      trackInterval(updateHudExpira,  60 * 1000);
    };
    mount();
  }

  function buildHudHtml() {
    const valores = [0.1, 0.5, 1, 2, 5, 10];
    const pills = valores.map(v => {
      const label = v === 0.1 ? '0,10' : v === 0.5 ? '0,50' : String(v);
      const active = Math.abs(cfg.valorMinimo - v) < 0.001 ? ' class="active"' : '';
      return '<button data-val="' + v + '"' + active + '>' + label + '</button>';
    }).join('');

    return [
      '<div id="ps-hud-header">',
      '  <span class="ps-status-dot"></span>',
      '  <span class="ps-title">PRIZE SNIPER</span>',
      '  <span class="ps-version" id="ps-hud-version">v?</span>',
      '  <button id="ps-hud-min" title="Minimizar">−</button>',
      '</div>',
      '<div class="ps-stats">',
      '  <div class="ps-row"><span>Status</span>       <span id="ps-status-text">—</span></div>',
      '  <div class="ps-row"><span>Capturados</span>   <span id="ps-captured">0</span></div>',
      '  <div class="ps-row"><span>Último</span>       <span id="ps-last">—</span></div>',
      '  <div class="ps-row"><span>Sessão</span>       <span id="ps-session">0m</span></div>',
      '  <div class="ps-row"><span>Expira</span>       <span id="ps-expira">—</span></div>',
      '</div>',
      '<div class="ps-section">',
      '  <div class="ps-label">VALOR MÍNIMO (R$)</div>',
      '  <div class="ps-pills" id="ps-valor-pills">' + pills + '</div>',
      '</div>',
      '<div class="ps-section">',
      '  <div class="ps-toggle-row">',
      '    <span>Auto-apostar</span>',
      '    <div class="ps-toggle' + (cfg.autoApostar ? ' on' : '') + '" id="ps-toggle-auto"><div class="ps-knob"></div></div>',
      '  </div>',
      '  <div class="ps-toggle-row">',
      '    <span>Manual</span>',
      '    <div class="ps-toggle' + (cfg.modoManual ? ' on' : '') + '" id="ps-toggle-manual"><div class="ps-knob"></div></div>',
      '  </div>',
      '</div>',
      '<div class="ps-section">',
      '  <div class="ps-label">CASHOUT</div>',
      '  <div class="ps-cashout">',
      '    <button id="ps-cashout-down">−</button>',
      '    <span id="ps-cashout-val">' + cfg.cashout.toFixed(2).replace('.', ',') + 'x</span>',
      '    <button id="ps-cashout-up">+</button>',
      '  </div>',
      '</div>',
      '<div id="ps-hud-log">▸ aguardando</div>',
      '<button id="ps-pause-btn">⏸ PAUSAR</button>',
    ].join('\n');
  }

  function positionHud() {
    if (!hudEl) return;
    const p = cfg.hudPos;
    if (p && typeof p.left === 'number' && typeof p.top === 'number') {
      hudEl.style.left   = p.left + 'px';
      hudEl.style.top    = p.top  + 'px';
      hudEl.style.right  = 'auto';
      hudEl.style.bottom = 'auto';
    }
    // else usa o bottom/right do CSS default
  }

  function bindHudEvents() {
    if (!hudEl) return;

    // ------ Drag ------
    const header = hudEl.querySelector('#ps-hud-header');
    let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;

    header.addEventListener('pointerdown', (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = hudEl.getBoundingClientRect();
      sl = r.left; st = r.top;
      hudEl.style.left   = sl + 'px';
      hudEl.style.top    = st + 'px';
      hudEl.style.right  = 'auto';
      hudEl.style.bottom = 'auto';
      header.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const nl = sl + (e.clientX - sx);
      const nt = st + (e.clientY - sy);
      hudEl.style.left = nl + 'px';
      hudEl.style.top  = nt + 'px';
    });
    header.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch (_) {}
      const r = hudEl.getBoundingClientRect();
      cfg.hudPos = { left: Math.round(r.left), top: Math.round(r.top) };
      saveCfg();
    });

    // ------ Pills valor mínimo ------
    hudEl.querySelectorAll('.ps-pills button').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = parseFloat(btn.getAttribute('data-val'));
        if (isNaN(v)) return;
        cfg.valorMinimo = v;
        saveCfg();
        hudEl.querySelectorAll('.ps-pills button').forEach(b => {
          b.classList.toggle('active', Math.abs(parseFloat(b.getAttribute('data-val')) - v) < 0.001);
        });
        // Remove flags de ignored dos botões marcados acima do mínimo novo
        document.querySelectorAll('.chatPrizeStormClaimBtn[data-ps-ignored]').forEach(b => {
          b.removeAttribute('data-ps-ignored');
          b.style.opacity = '';
        });
      });
    });

    // ------ Toggle Auto-apostar ------
    hudEl.querySelector('#ps-toggle-auto').addEventListener('click', () => {
      cfg.autoApostar = !cfg.autoApostar;
      saveCfg();
      hudEl.querySelector('#ps-toggle-auto').classList.toggle('on', cfg.autoApostar);
      log(cfg.autoApostar ? 'auto-apostar ON' : 'auto-apostar OFF');
    });

    // ------ Toggle Manual ------
    hudEl.querySelector('#ps-toggle-manual').addEventListener('click', () => {
      cfg.modoManual = !cfg.modoManual;
      saveCfg();
      hudEl.querySelector('#ps-toggle-manual').classList.toggle('on', cfg.modoManual);
      log(cfg.modoManual ? 'modo manual ON' : 'modo manual OFF');
    });

    // ------ Cashout +/- ------
    const cashVal = hudEl.querySelector('#ps-cashout-val');
    const clamp = (v) => Math.max(1.01, Math.min(999, parseFloat(v.toFixed(2))));
    hudEl.querySelector('#ps-cashout-down').addEventListener('click', () => {
      cfg.cashout = clamp(cfg.cashout - 0.01);
      saveCfg();
      cashVal.textContent = cfg.cashout.toFixed(2).replace('.', ',') + 'x';
    });
    hudEl.querySelector('#ps-cashout-up').addEventListener('click', () => {
      cfg.cashout = clamp(cfg.cashout + 0.01);
      saveCfg();
      cashVal.textContent = cfg.cashout.toFixed(2).replace('.', ',') + 'x';
    });

    // ------ Pause ------
    const pauseBtn = hudEl.querySelector('#ps-pause-btn');
    pauseBtn.addEventListener('click', () => {
      cfg.paused = !cfg.paused;
      saveCfg();
      updatePauseBtn();
      updateHudStatus();
      log(cfg.paused ? 'BOT PAUSADO' : 'bot retomado');
    });
    updatePauseBtn();

    // ------ Minimize ------
    const minBtn = hudEl.querySelector('#ps-hud-min');
    // Bloqueia o drag quando clica no botão de minimizar
    minBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cfg.hudMinimized = !cfg.hudMinimized;
      saveCfg();
      applyMinimized();
    });
    applyMinimized();
  }

  function applyMinimized() {
    if (!hudEl) return;
    hudEl.classList.toggle('minimized', !!cfg.hudMinimized);
    const btn = hudEl.querySelector('#ps-hud-min');
    if (btn) {
      btn.textContent = cfg.hudMinimized ? '+' : '−';
      btn.title = cfg.hudMinimized ? 'Expandir' : 'Minimizar';
    }
  }

  function updatePauseBtn() {
    const btn = hudEl && hudEl.querySelector('#ps-pause-btn');
    if (!btn) return;
    if (cfg.paused) {
      btn.textContent = '▶ RETOMAR';
      btn.classList.add('paused');
    } else {
      btn.textContent = '⏸ PAUSAR';
      btn.classList.remove('paused');
    }
  }

  function refreshHudAll() {
    if (!hudEl) return;
    const ver = hudEl.querySelector('#ps-hud-version');
    if (ver) ver.textContent = 'v' + botcodeVersion;
    updateHudStatus();
    updateHudSession();
    updateHudExpira();
    const cap = hudEl.querySelector('#ps-captured');
    if (cap) cap.textContent = String(capturedCount);
  }

  function updateHudStatus() {
    if (!hudEl) return;
    const dot  = hudEl.querySelector('.ps-status-dot');
    const text = hudEl.querySelector('#ps-status-text');
    if (!dot || !text) return;

    dot.classList.remove('otp', 'betting', 'error', 'paused');

    if (cfg.paused) {
      dot.classList.add('paused');
      text.textContent = 'Pausado';
      return;
    }
    switch (state) {
      case STATES.IDLE:
        text.textContent = 'Ativo';
        break;
      case STATES.OTP:
        dot.classList.add('otp');
        text.textContent = 'Digitando OTP';
        break;
      case STATES.BETTING:
        dot.classList.add('betting');
        text.textContent = 'Apostando';
        break;
      case STATES.ERROR:
        dot.classList.add('error');
        text.textContent = 'Erro';
        break;
    }
  }

  function updateHudSession() {
    if (!hudEl) return;
    const el = hudEl.querySelector('#ps-session');
    if (!el) return;
    const ms = Date.now() - sessionStart;
    const h  = Math.floor(ms / 3600000);
    const m  = Math.floor((ms % 3600000) / 60000);
    el.textContent = h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');
  }

  async function updateHudExpira() {
    if (!hudEl) return;
    const el = hudEl.querySelector('#ps-expira');
    if (!el) return;
    try {
      const s = await storageGet(['expires_at']);
      const exp = s.expires_at;
      if (!exp) { el.textContent = '—'; return; }
      const ms = exp - Date.now();
      if (ms < 0) { el.textContent = 'vencida'; el.style.color = '#ef4444'; return; }
      const d = Math.floor(ms / 86400000);
      const h = Math.floor((ms % 86400000) / 3600000);
      el.textContent = (d > 0 ? d + 'd ' : '') + h + 'h';
      // Cor do countdown
      if (d < 1)      el.style.color = '#ef4444';
      else if (d < 3) el.style.color = '#fbbf24';
      else            el.style.color = '#e8e8f0';
    } catch (e) {}
  }

  const HUD_CSS = [
    '#prize-sniper-hud {',
    '  position: fixed; bottom: 24px; right: 24px;',
    '  width: 240px;',
    '  background: rgba(13, 13, 20, 0.72);',
    '  backdrop-filter: blur(24px) saturate(180%);',
    '  -webkit-backdrop-filter: blur(24px) saturate(180%);',
    '  border: 1px solid rgba(167, 139, 250, 0.18);',
    '  border-radius: 18px;',
    '  padding: 16px 18px;',
    '  color: #e8e8f0;',
    "  font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;",
    '  font-size: 12px; font-weight: 300; letter-spacing: 0.3px;',
    '  z-index: 2147483647;',
    '  box-shadow: 0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(167,139,250,0.05);',
    '  user-select: none;',
    '  transition: box-shadow 0.2s;',
    '}',
    '#prize-sniper-hud:hover { box-shadow: 0 12px 48px rgba(0,0,0,0.6), 0 0 24px rgba(167,139,250,0.15); }',
    '#prize-sniper-hud * { box-sizing: border-box; }',
    '#prize-sniper-hud #ps-hud-header {',
    '  display: flex; align-items: center; gap: 8px;',
    '  padding-bottom: 12px; margin-bottom: 12px;',
    '  cursor: grab;',
    '  border-bottom: 1px solid rgba(255,255,255,0.06);',
    '}',
    '#prize-sniper-hud #ps-hud-header:active { cursor: grabbing; }',
    '#prize-sniper-hud .ps-status-dot {',
    '  width: 8px; height: 8px; border-radius: 50%;',
    '  background: #4ade80; box-shadow: 0 0 8px #4ade80;',
    '  transition: all 0.3s;',
    '}',
    '#prize-sniper-hud .ps-status-dot.otp     { background: #fbbf24; box-shadow: 0 0 8px #fbbf24; }',
    '#prize-sniper-hud .ps-status-dot.betting { background: #60a5fa; box-shadow: 0 0 8px #60a5fa; }',
    '#prize-sniper-hud .ps-status-dot.error   { background: #ef4444; box-shadow: 0 0 8px #ef4444; }',
    '#prize-sniper-hud .ps-status-dot.paused  { background: #6a6a7a; box-shadow: none; }',
    '#prize-sniper-hud .ps-title {',
    '  flex: 1; font-size: 11px; font-weight: 600;',
    '  letter-spacing: 1.2px; color: #e2d9ff;',
    '}',
    '#prize-sniper-hud .ps-version { font-size: 10px; color: #6a6a7a; font-weight: 400; }',
    '#prize-sniper-hud #ps-hud-min {',
    '  width: 20px; height: 20px;',
    '  border-radius: 6px;',
    '  background: rgba(255,255,255,0.04);',
    '  border: 1px solid rgba(167,139,250,0.15);',
    '  color: #6a6a7a;',
    '  cursor: pointer;',
    '  font-family: inherit; font-size: 14px; font-weight: 600;',
    '  line-height: 1; padding: 0;',
    '  display: flex; align-items: center; justify-content: center;',
    '  transition: all 0.15s;',
    '}',
    '#prize-sniper-hud #ps-hud-min:hover {',
    '  background: rgba(167,139,250,0.15); color: #c4b5fd;',
    '  border-color: rgba(167,139,250,0.35);',
    '}',
    '#prize-sniper-hud.minimized {',
    '  width: auto; min-width: 190px; padding: 12px 14px;',
    '}',
    '#prize-sniper-hud.minimized #ps-hud-header {',
    '  padding-bottom: 0; margin-bottom: 0; border-bottom: 0;',
    '}',
    '#prize-sniper-hud.minimized .ps-stats,',
    '#prize-sniper-hud.minimized .ps-section,',
    '#prize-sniper-hud.minimized #ps-hud-log,',
    '#prize-sniper-hud.minimized #ps-pause-btn { display: none; }',
    '#prize-sniper-hud .ps-stats .ps-row {',
    '  display: flex; justify-content: space-between;',
    '  padding: 3px 0; font-size: 11px;',
    '}',
    '#prize-sniper-hud .ps-stats .ps-row span:first-child { color: #6a6a7a; }',
    '#prize-sniper-hud .ps-stats .ps-row span:last-child  { color: #e8e8f0; font-weight: 500; }',
    '#prize-sniper-hud .ps-section {',
    '  margin-top: 12px; padding-top: 12px;',
    '  border-top: 1px solid rgba(255,255,255,0.06);',
    '}',
    '#prize-sniper-hud .ps-label {',
    '  font-size: 9px; color: #6a6a7a;',
    '  letter-spacing: 1px; text-transform: uppercase;',
    '  margin-bottom: 7px;',
    '}',
    '#prize-sniper-hud .ps-pills {',
    '  display: flex; gap: 4px; flex-wrap: wrap;',
    '}',
    '#prize-sniper-hud .ps-pills button {',
    '  flex: 1; min-width: 32px; padding: 5px 0;',
    '  font-size: 10px; font-weight: 400;',
    '  background: rgba(255,255,255,0.04);',
    '  color: #6a6a7a;',
    '  border: 1px solid rgba(167,139,250,0.1);',
    '  border-radius: 8px;',
    '  cursor: pointer;',
    '  font-family: inherit;',
    '  transition: all 0.15s;',
    '}',
    '#prize-sniper-hud .ps-pills button:hover {',
    '  background: rgba(167,139,250,0.08); color: #c4b5fd;',
    '}',
    '#prize-sniper-hud .ps-pills button.active {',
    '  background: rgba(167,139,250,0.22); color: #c4b5fd;',
    '  border-color: rgba(167,139,250,0.4); font-weight: 600;',
    '}',
    '#prize-sniper-hud .ps-toggle-row {',
    '  display: flex; justify-content: space-between; align-items: center;',
    '  padding: 5px 0; font-size: 11px; color: #6a6a7a;',
    '}',
    '#prize-sniper-hud .ps-toggle {',
    '  width: 32px; height: 18px; border-radius: 10px;',
    '  background: rgba(255,255,255,0.08);',
    '  position: relative; cursor: pointer;',
    '  transition: background 0.2s;',
    '}',
    '#prize-sniper-hud .ps-toggle.on { background: #a78bfa; }',
    '#prize-sniper-hud .ps-toggle .ps-knob {',
    '  position: absolute; width: 14px; height: 14px;',
    '  border-radius: 50%; background: #fff;',
    '  top: 2px; left: 2px; transition: left 0.2s;',
    '}',
    '#prize-sniper-hud .ps-toggle.on .ps-knob { left: 16px; }',
    '#prize-sniper-hud .ps-cashout {',
    '  display: flex; align-items: center; gap: 8px; justify-content: center;',
    '}',
    '#prize-sniper-hud .ps-cashout button {',
    '  width: 22px; height: 22px; border-radius: 6px;',
    '  border: 1px solid rgba(167,139,250,0.2);',
    '  background: rgba(255,255,255,0.04);',
    '  color: #c4b5fd;',
    '  cursor: pointer;',
    '  font-family: inherit; font-size: 13px; line-height: 1;',
    '}',
    '#prize-sniper-hud .ps-cashout button:hover { background: rgba(167,139,250,0.12); }',
    '#prize-sniper-hud .ps-cashout span {',
    '  flex: 1; text-align: center;',
    '  font-size: 13px; font-weight: 500; color: #e8e8f0;',
    "  font-family: 'Consolas', monospace;",
    '}',
    '#prize-sniper-hud #ps-hud-log {',
    '  margin-top: 12px; padding: 8px 10px;',
    '  background: rgba(0,0,0,0.3);',
    '  border-radius: 8px;',
    '  font-size: 10px; color: #6a6a7a;',
    "  font-family: 'Consolas', monospace;",
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '  border: 1px solid rgba(255,255,255,0.03);',
    '}',
    '#prize-sniper-hud #ps-pause-btn {',
    '  margin-top: 10px; width: 100%; padding: 10px;',
    '  background: rgba(167,139,250,0.12);',
    '  color: #c4b5fd;',
    '  border: 1px solid rgba(167,139,250,0.25);',
    '  border-radius: 10px;',
    '  font-size: 11px; font-weight: 600; letter-spacing: 1px;',
    '  cursor: pointer; font-family: inherit;',
    '  transition: all 0.15s;',
    '}',
    '#prize-sniper-hud #ps-pause-btn:hover {',
    '  background: rgba(167,139,250,0.22); color: #fff;',
    '}',
    '#prize-sniper-hud #ps-pause-btn.paused {',
    '  background: rgba(251,191,36,0.12);',
    '  color: #fbbf24;',
    '  border-color: rgba(251,191,36,0.3);',
    '}',
    '#prize-sniper-hud #ps-pause-btn.paused:hover { background: rgba(251,191,36,0.22); }',
  ].join('\n');

  // ============================================================
  // MÓDULO 8 — POPUPS INTRUSIVOS (fairness + torneio)
  // ============================================================
  // Popups que aparecem na frente do jogo e bloqueiam tudo. Tentamos fechar
  // via múltiplos seletores de botão X; se nada responder, fallback nuclear:
  // display:none + remove().

  function closePopupGeneric(popupEl, closeBtnSelectors) {
    for (const sel of closeBtnSelectors) {
      const btn = popupEl.querySelector(sel);
      if (!btn) continue;
      // Sobe até 5 níveis procurando um onClick React
      let target = btn;
      for (let depth = 0; depth < 5 && target; depth++) {
        if (forceReactClick(target)) return true;
        target = target.parentElement;
      }
      simulateClick(btn);
      try { btn.click(); } catch (e) {}
    }
    // Fallback nuclear
    try {
      popupEl.style.display = 'none';
      popupEl.remove();
    } catch (e) {}
    return true;
  }

  function checkAndClosePopups() {
    const fairness = document.querySelector('div.fairness-popup-holder');
    if (fairness) {
      log('popup fairness — fechando');
      closePopupGeneric(fairness, [
        'i.icon-close.fairness-popup-close',
        'button.fairness-popup-close',
        'i.icon-close',
        '.fairness-popup-head-column.close button',
        '.fairness-popup-head-column.close',
      ]);
      return true;
    }

    const tournament = document.querySelector('div.tournamentNotificationPopupHolder');
    if (tournament) {
      log('popup torneio — fechando');
      closePopupGeneric(tournament, [
        'button.tournamentNotPopupButton.type-1',
        'button.tournamentNotPopupClose',
      ]);
      return true;
    }

    return false;
  }

  // ============================================================
  // MÓDULO 9 — CONEXÃO PERDIDA / TOKEN EXPIRADO
  // ============================================================
  // Quando detecta tela de erro bloqueante, dispara reloadTab via shell.
  // Debounce de 5s pra não disparar 10 reloads seguidos enquanto a tela está lá.
  // O reload mata a instância atual do botcode; a nova inicia fresh em IDLE.
  //
  // NOTA: No r7.bet.br, após o reload pode aparecer um botão "Jogar" que o
  // botcode não consegue clicar (vive em outro origin). Usuário precisa clicar
  // manualmente 1 vez. Solução definitiva exige content_platform.js no shell,
  // que é reinstalação única (adiado pra v7.1 se virar dor real).

  const ERROR_DEBOUNCE_MS    = 5000;
  const REFRESH_FALLBACK_MS  = 3000;  // se refresh platform não resolver em 3s, reloadTab
  let lastErrorAction = 0;

  function postRefreshToParent() {
    const payload = { type: 'PRIZE_SNIPER_REFRESH_GAME' };
    try { window.top    && window.top.postMessage(payload, '*');    } catch (e) {}
    try { window.parent && window.parent.postMessage(payload, '*'); } catch (e) {}
  }

  function checkConnectionErrors() {
    const now = Date.now();
    if (now - lastErrorAction < ERROR_DEBOUNCE_MS) return false;

    // Tela "Conexão perdida" — tenta refresh via platform helper primeiro (rápido),
    // reloadTab como fallback se o erro persistir após 3s.
    const reloadBtn = document.querySelector(
      'button.message-btn.go-back, ' +
      '.global-message-wrapper button:last-child, ' +
      '.message-btns-wrp button:last-child'
    );
    if (reloadBtn) {
      log('conexão perdida detectada — refresh via platform');
      setState(STATES.ERROR);
      lastErrorAction = now;
      postRefreshToParent();

      // Fallback: se em 3s a tela de erro ainda estiver aí, reloadTab full
      trackTimeout(() => {
        const still = document.querySelector(
          'button.message-btn.go-back, ' +
          '.global-message-wrapper button:last-child, ' +
          '.message-btns-wrp button:last-child'
        );
        if (still) {
          log('refresh platform não resolveu — reloadTab full');
          psRequest('reloadTab', {}).catch(e => log('reloadTab erro:', e.message));
        }
      }, REFRESH_FALLBACK_MS);
      return true;
    }

    // Tela "Token expirado" — vai direto pra reloadTab (precisa auth fresh do cassino,
    // refresh in-game não resolve porque o token está no URL do iframe).
    const msgTitle = document.querySelector('.message-title');
    if (msgTitle) {
      const txt = (msgTitle.textContent || '').toLowerCase();
      if (txt && !txt.includes('conexão perdida')) {
        log('token expirado detectado (' + txt.slice(0, 30) + ') — reloadTab');
        setState(STATES.ERROR);
        lastErrorAction = now;
        psRequest('reloadTab', {}).catch(e => log('reloadTab erro:', e.message));
        return true;
      }
    }

    return false;
  }

  // ============================================================
  // MÓDULOS 5 + 6 + 7 — FLUXO OTP COMPLETO
  // ============================================================
  // Módulo 5: digitar OTP (tenta paste no input[0], fallback char-a-char)
  // Módulo 6: runOtpAttempt — captura canvas do DOM, dispara OCR, digita
  // Módulo 7: confirmação (popup sumiu ou .success-icon) / rejeição / retry fechando
  //           popup e re-clicando o botão Reivindicar original
  //
  // Fluxo geral (DOM-driven, sem WS):
  //   prize-clicked (Mod 4) → setState OTP + runOtpAttempt():
  //     → espera o canvas (.human-verification-numbers-canvas) aparecer no popup
  //     → captura toDataURL → base64
  //     → dispara OCR em paralelo
  //     → digita (paste → char-a-char)
  //     → loop de 4s esperando sucesso OU otp-rejected
  //     → sucesso: IDLE
  //     → rejeitado/falhou: closeAndRetry (fecha popup, re-clica Reivindicar, runOtpAttempt de novo)
  //     → max retries ou botão sumiu: IDLE

  const OTP_MAX_RETRIES       = 5;
  const POPUP_WAIT_MS         = 15000;
  const OTP_CONFIRM_WAIT_MS   = 8000;
  const PASTE_SETTLE_MS       = 250;
  const CHAR_GAP_MS           = 430;

  let otpFlowInProgress = false;
  let currentPrizeBtn   = null;
  let currentAttempt    = 0;


  function sleep(ms) {
    return new Promise(resolve => {
      const id = setTimeout(() => { timeouts.delete(id); resolve(); }, ms);
      timeouts.add(id);
    });
  }

  async function waitForPopup(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const el = document.querySelector('.human-verification-container, .human-verification-popup');
      if (el) return el;
      await sleep(50);
    }
    return null;
  }

  // Captura a imagem do captcha. Devolve { data, mediaType, source } em base64.
  // Ordem de preferência (do melhor pro pior):
  //   1) window._psLatestCaptcha — bytes brutos do PNG que o page baixou
  //      (interceptados pelo ws-hook em fetch/XHR/Image.src). PNG nítido (~14kB).
  //   2) <canvas> da verificação re-encodado em PNG. Lossy se o page usa
  //      imageSmoothingEnabled:false ou pinta com poucas cores (~1.5kB).
  //   3) <img> dentro do popup, redesenhado num canvas auxiliar.
  //
  // skipBase64: força esperar bytes DIFERENTES do anterior. Necessário pro
  // retry: depois do close-and-retry o popup pode re-renderizar antes do
  // novo PNG chegar. Sem esse filtro, a 2ª tentativa lê a imagem da 1ª.
  // Após metade do timeout, abandona o filtro pra não travar.
  //
  // sinceTs: ignora bytes hookados ANTES desse timestamp. Sem isso, um
  // captcha de prize anterior (TTL 30s) seria reusado no prize seguinte.
  // Caminho 1 (preferido): listener do evento 'ps:captcha-bytes' disparado
  //   pelo ws-hook quando o hook de fetch/XHR/Image.src publica.
  // Caminho 2 (fallback após HOOK_HARD_WAIT): canvas/img do popup com filtro
  //   de tamanho mínimo (canvas vazio dá ~2kB; PNG real dá ~14-19kB → 18-25kB
  //   em b64). Threshold de 4000 chars descarta canvas em estado pré-pintura.
  function captureCaptchaFromDom(maxMs, skipBase64, sinceTs) {
    const start          = Date.now();
    const minTs          = sinceTs || start;
    const skipUntil      = start + Math.floor(maxMs / 2);
    const HOOK_HARD_WAIT = 2000;   // espera FORTE pelo hook nos 2s iniciais
    const CANVAS_MIN_B64 = 4000;   // canvas com menos que isso → vazio, ignorar

    return new Promise((resolve) => {
      let done = false;
      let pollId = null;
      let timeoutId = null;

      const finish = (result) => {
        if (done) return;
        done = true;
        try { window.removeEventListener('ps:captcha-bytes', onHookEvent); } catch (e) {}
        if (pollId)    { clearInterval(pollId); intervals.delete(pollId); }
        if (timeoutId) { clearTimeout(timeoutId); timeouts.delete(timeoutId); }
        resolve(result);
      };

      const isStale = (b64) =>
        skipBase64 && Date.now() < skipUntil && b64 === skipBase64;

      const tryHookData = (h) => {
        if (!h || !h.base64 || h.ts < minTs) return null;
        if (isStale(h.base64)) return null;
        return { data: h.base64, mediaType: h.mediaType || 'image/png', source: 'hook' };
      };

      // 1) Já tem bytes recentes em _psLatestCaptcha? Resolve na hora.
      const initial = tryHookData(window._psLatestCaptcha);
      if (initial) { resolve(initial); return; }

      // 2) Listener: dispara assim que o hook publicar (sem gap de polling)
      const onHookEvent = (e) => {
        const out = tryHookData(e && e.detail);
        if (out) finish(out);
      };
      try { window.addEventListener('ps:captcha-bytes', onHookEvent); } catch (_) {}

      // 2b) Re-check pós-listener: se publicou entre o tryHookData inicial e
      // o addEventListener (corrida de microtask), pegamos aqui.
      const afterAdd = tryHookData(window._psLatestCaptcha);
      if (afterAdd) { finish(afterAdd); return; }

      // 3) Polling de canvas/img como ULTRA-fallback após HOOK_HARD_WAIT
      pollId = setInterval(() => {
        if (Date.now() - start < HOOK_HARD_WAIT) return;
        const popup = document.querySelector('.human-verification-container, .human-verification-popup');
        if (!popup) return;

        // Canvas
        const cvs = popup.querySelectorAll('canvas');
        for (const cv of cvs) {
          if (!cv.width || !cv.height) continue;
          if (cv.width < 40 || cv.height < 20) continue;
          try {
            const dataUrl = cv.toDataURL('image/png');
            const out = splitDataUrl(dataUrl);
            if (!out) continue;
            if (out.data.length < CANVAS_MIN_B64) continue;  // canvas vazio, ignora
            if (isStale(out.data)) continue;
            out.source = 'canvas';
            return finish(out);
          } catch (e) { /* tainted */ }
        }
        // <img> redesenhado
        const imgs = popup.querySelectorAll('img');
        for (const img of imgs) {
          if (!img.complete || !img.naturalWidth) continue;
          if (img.naturalWidth < 40 || img.naturalHeight < 20) continue;
          try {
            const tmp = document.createElement('canvas');
            tmp.width  = img.naturalWidth;
            tmp.height = img.naturalHeight;
            tmp.getContext('2d').drawImage(img, 0, 0);
            const dataUrl = tmp.toDataURL('image/png');
            const out = splitDataUrl(dataUrl);
            if (!out) continue;
            if (out.data.length < CANVAS_MIN_B64) continue;
            if (isStale(out.data)) continue;
            out.source = 'img';
            return finish(out);
          } catch (e) { /* CORS-tainted */ }
        }
      }, 80);
      intervals.add(pollId);

      // 4) Timeout final
      timeoutId = setTimeout(() => finish(null), maxMs);
      timeouts.add(timeoutId);
    });
  }

  function splitDataUrl(dataUrl) {
    if (!dataUrl || dataUrl.indexOf('data:') !== 0) return null;
    const i = dataUrl.indexOf(',');
    if (i < 0) return null;
    const head = dataUrl.slice(5, i);                  // ex: "image/png;base64"
    const mediaType = (head.split(';')[0] || 'image/png').trim();
    const data = dataUrl.slice(i + 1);
    if (!data) return null;
    return { data, mediaType };
  }

  // Hash curto pra dedup do dataset no SW (substitui a URL que sumiu)
  async function quickHashB64(b64) {
    try {
      const buf = new TextEncoder().encode(b64);
      const h   = await crypto.subtle.digest('SHA-1', buf);
      const hex = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 16);
    } catch (e) {
      return String(b64.length) + '_' + String(Date.now());
    }
  }

  function getOtpInputs(popup) {
    return popup.querySelectorAll('input.OtpInput, .OtpInputContainer input, .human-verification-input input');
  }

  function clearInput(input) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') && Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (setter) setter.call(input, '');
    else input.value = '';
    try {
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {}
  }

  function setReactValue(input, val) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') && Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (setter) setter.call(input, val);
    else input.value = val;
    try {
      input.dispatchEvent(new InputEvent('input',  { bubbles: true, cancelable: true, data: val, inputType: 'insertText' }));
      input.dispatchEvent(new InputEvent('change', { bubbles: true, cancelable: true }));
    } catch (e) {
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function typeReactChar(input, char) {
    input.focus();
    try { input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); } catch (e) {}

    const isDigit = /\d/.test(char);
    const keyCode = char.charCodeAt(0);
    const code    = isDigit ? ('Digit' + char) : ('Key' + char.toUpperCase());
    const kbOpts  = { bubbles: true, cancelable: true, key: char, code, keyCode, which: keyCode, charCode: keyCode };

    try { input.dispatchEvent(new KeyboardEvent('keydown', kbOpts)); } catch (e) {}

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') && Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (setter) setter.call(input, char);
    else input.value = char;

    try { input.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, kbOpts, { charCode: keyCode }))); } catch (e) {}
    try { input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: char, inputType: 'insertText' })); } catch (e) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    try { input.dispatchEvent(new KeyboardEvent('keyup', kbOpts)); } catch (e) {}
  }

  async function typeOtpIntoPopup(popup, otp) {
    const inputs = getOtpInputs(popup);
    if (inputs.length !== 4) {
      log('OTP inputs qtd errada: ' + inputs.length);
      return false;
    }

   // Char-a-char com delay humano
try {
  for (const inp of inputs) clearInput(inp);
  for (let i = 0; i < 4; i++) {
    typeReactChar(inputs[i], otp[i]);
    await sleep(430); // ← era CHAR_GAP_MS (30ms), agora 480ms
  }
  log('OTP digitado char-a-char');
  return true;
} catch (e) {
  log('char-a-char erro: ' + e.message);
  return false;
}

    // Estratégia 2: char-a-char com sequência React completa
    try {
      for (const inp of inputs) clearInput(inp);
      for (let i = 0; i < 4; i++) {
        typeReactChar(inputs[i], otp[i]);
        await sleep(CHAR_GAP_MS);
      }
      log('OTP digitado char-a-char');
      return true;
    } catch (e) {
      log('char-a-char erro: ' + e.message);
      return false;
    }
  }

  function popupStillThere() {
    return !!document.querySelector('.human-verification-container, .human-verification-popup');
  }

  function popupShowsSuccess(popup) {
    if (!popup) popup = document.querySelector('.human-verification-container, .human-verification-popup');
    if (!popup) return false;
    return !!popup.querySelector('.success-icon, .success-circle, .success-check');
  }

  function clickClosePopup() {
    const closeBtn = document.querySelector('button.commonPopupClose');
    if (!closeBtn) return false;
    forceReactClick(closeBtn);
    simulateClick(closeBtn);
    try { closeBtn.click(); } catch (e) {}
    return true;
  }

  // Preview visual da imagem capturada — aparece no canto superior direito
  // por 10s pra você comparar com o que o popup exibe.
  function showCaptchaPreview(b64, mediaType, source) {
    try {
      const old = document.getElementById('_ps_captcha_preview');
      if (old) old.remove();
      const wrap = document.createElement('div');
      wrap.id = '_ps_captcha_preview';
      Object.assign(wrap.style, {
        position: 'fixed', top: '10px', right: '10px', zIndex: '999999',
        background: 'rgba(0,0,0,0.85)', border: '2px solid #0ff',
        borderRadius: '8px', padding: '6px 8px', fontFamily: 'monospace',
        fontSize: '11px', color: '#0ff', lineHeight: '1.4',
      });
      const label = document.createElement('div');
      label.textContent = 'PS CAPTCHA [' + (source || '?') + ']';
      const img = document.createElement('img');
      img.src = 'data:' + (mediaType || 'image/png') + ';base64,' + b64;
      Object.assign(img.style, { display: 'block', marginTop: '4px', maxWidth: '280px', imageRendering: 'pixelated' });
      wrap.appendChild(label);
      wrap.appendChild(img);
      document.body.appendChild(wrap);
      setTimeout(function () { try { wrap.remove(); } catch (e) {} }, 10000);
    } catch (e) {}
  }

  // Hash do canvas da última tentativa — usado pra forçar captureCaptchaFromDom
  // a esperar um canvas DIFERENTE depois do close-and-retry.
  let lastCapturedB64 = null;

  async function doCloseAndRetry() {
    await sleep(6000);
    clickClosePopup();
    await sleep(600);

    if (currentAttempt >= OTP_MAX_RETRIES) {
      log('max retries (' + OTP_MAX_RETRIES + ') atingido — desistindo');
      return onOtpDone();
    }
    if (!currentPrizeBtn || !document.body.contains(currentPrizeBtn) || currentPrizeBtn.disabled) {
      log('botão Reivindicar não disponível — desistindo');
      return onOtpDone();
    }

    currentAttempt++;
    log('re-click Reivindicar (attempt ' + currentAttempt + '/' + OTP_MAX_RETRIES + ')');
    clickPrize(currentPrizeBtn);
    // Dispara nova tentativa — runOtpAttempt espera o canvas re-renderizar
    return runOtpAttempt();
  }

  // ---- Trigger principal do fluxo OTP ----
  // Chamado pelo prize-clicked (1ª tentativa) e pelo doCloseAndRetry (retries).
  // 100% DOM-driven: não depende do WS, lê os bytes do PNG direto do hook
  // de rede (ws-hook.js intercepta fetch/XHR/Image), com fallback no canvas.
  async function runOtpAttempt() {
    if (state !== STATES.OTP) { log('runOtpAttempt ignorado (state=' + state + ')'); return; }
    if (otpFlowInProgress)    { log('runOtpAttempt ignorado (flow em andamento)'); return; }
    otpFlowInProgress = true;

    // Mata o timer de 8s do Módulo 4 — a partir daqui somos nós que controlamos o timeout
    if (otpTimeoutId) {
      clearTimeout(otpTimeoutId);
      timeouts.delete(otpTimeoutId);
      otpTimeoutId = null;
    }

    // Marca o início da tentativa: bytes hookados ANTES disso são de captchas
    // anteriores (TTL fica em ~30s, suficiente pra atravessar prizes seguidos).
    const attemptStart = Date.now();



    // Captura priorizando bytes brutos do PNG (hook). skipBase64 garante que
    // a 2ª tentativa não pega o captcha da 1ª enquanto o novo não chegou.
    const captured = await captureCaptchaFromDom(POPUP_WAIT_MS, lastCapturedB64, attemptStart);
    if (!captured) {
      log('captura do DOM falhou (canvas indisponível ou tainted)');
      otpFlowInProgress = false;
      return onOtpDone();
    }
    lastCapturedB64 = captured.data;
    showCaptchaPreview(captured.data, captured.mediaType, captured.source);
    const captureId = 'dom_' + (await quickHashB64(captured.data));
    log('captcha capturado [' + (captured.source || '?') + '] (' + captured.mediaType + ', ' + captured.data.length + ' chars b64, id ' + captureId + ')');

    // Pré-cache no SW (idempotente). URL é id sintético — não há mais URL real.
    psRequest('cacheCaptcha', {
      url: captureId, base64: captured.data, mediaType: captured.mediaType,
    }, 5000).catch(() => {});

    // Modo manual: usuário digita o OTP, bot só espera sucesso/falha
    if (cfg.modoManual) {
      try {
        log('modo manual — aguardando usuário digitar OTP');

        const popup = document.querySelector('.human-verification-container, .human-verification-popup');
        if (!popup) { log('popup não apareceu'); return onOtpDone(); }
        const startM = Date.now();
        const MANUAL_WAIT_MS = 70000;
        let lastTypedOtp = '';

        // Lê os inputs e devolve o OTP digitado se completo (4 chars válidos)
        const readTyped = () => {
          const inputs = getOtpInputs(popup);
          if (!inputs || inputs.length === 0) return '';
          const v = Array.from(inputs).map(i => (i.value || '')).join('');
          return /^[A-Za-z0-9]{4}$/.test(v) ? v : '';
        };

        while (Date.now() - startM < MANUAL_WAIT_MS) {
          const typed = readTyped();
          if (typed) lastTypedOtp = typed;
          if (popupShowsSuccess(popup)) {
            log('OTP manual aceito (success icon)');
            if (lastTypedOtp) {
              psRequest('confirmCaptcha', {
                url: captureId, otp: lastTypedOtp, source: 'manual',
                base64: captured.data, mediaType: captured.mediaType,
              }, 5000).catch(() => {});
            }
            return onOtpDone();
          }
          if (!popupStillThere()) {
            log('OTP manual aceito (popup sumiu)');
            if (lastTypedOtp) {
              psRequest('confirmCaptcha', {
                url: captureId, otp: lastTypedOtp, source: 'manual',
                base64: captured.data, mediaType: captured.mediaType,
              }, 5000).catch(() => {});
            }
            return onOtpDone();
          }
          await sleep(500);
        }
        log('OTP manual timeout');
        return onOtpDone();
      } finally {
        otpFlowInProgress = false;
      }
    }

    log('OTP flow — attempt ' + currentAttempt + '/' + OTP_MAX_RETRIES);

    let rejected = false;
    const unsubRej = bus.on('otp-rejected', () => { rejected = true; });

    try {
      // 1. Dispara OCR já com base64
      const ocrP = psRequest('ocr', {
        images: [{ type: 'base64', media_type: captured.mediaType, data: captured.data }],
      }, 15000);

      // 2. Popup já existe — captureCaptchaFromDom esperou ele renderizar
      const popup = document.querySelector('.human-verification-container, .human-verification-popup');
      if (!popup) { log('popup OTP não apareceu'); return onOtpDone(); }
      if (rejected) return doCloseAndRetry();

      // 3. Espera OCR
      let ocr;
      try { ocr = await ocrP; }
      catch (e) { log('OCR erro: ' + e.message); return doCloseAndRetry(); }

      if (rejected) return doCloseAndRetry();
      if (!ocr || ocr.error || !ocr.otp) {
        log('OCR falhou: ' + (ocr && ocr.error ? ocr.error : 'sem otp'));
        return doCloseAndRetry();
      }
      log('OCR ok: ' + ocr.otp + ' (' + (ocr.duration_ms || '?') + 'ms)');

// 4. Digita — ignora rejected durante digitação
      rejected = false; // reset antes de digitar
      const typed = await typeOtpIntoPopup(popup, ocr.otp);
      if (!typed) return doCloseAndRetry();
      
      // 5. Espera confirmação (sucesso OU rejeição OU timeout)
      rejected = false; // reset novamente após digitar
      const start = Date.now();
      while (Date.now() - start < OTP_CONFIRM_WAIT_MS) {
        if (rejected) return doCloseAndRetry();
        if (popupShowsSuccess(popup)) {
          log('OTP aceito (success icon)');
          psRequest('confirmCaptcha', {
            url: captureId, otp: ocr.otp, source: 'auto',
            base64: captured.data, mediaType: captured.mediaType,
          }, 5000).catch(() => {});
          return onOtpDone();
        }
        if (!popupStillThere()) {
          log('OTP aceito (popup sumiu)');
          psRequest('confirmCaptcha', {
            url: captureId, otp: ocr.otp, source: 'auto',
            base64: captured.data, mediaType: captured.mediaType,
          }, 5000).catch(() => {});
          return onOtpDone();
        }
        await sleep(500);
      }
      log('OTP timeout sem confirmação');
      return onOtpDone();

    } finally {
      unsubRej();
      otpFlowInProgress = false;
    }
  }

 function setupOtpFlow() {
    bus.on('prize-clicked', (d) => {
      currentPrizeBtn = d.btn;
      currentAttempt  = 1;
      lastCapturedB64 = null;
      log('Aguardando Geetest aparecer...');
      solveGeetestAndProceed();
    });
  }

async function solveGeetestAndProceed() {
    // 1. Espera o botão do Geetest aparecer (max 10s)
    const GEETEST_WAIT_MS = 10000;
    const start = Date.now();
    let geetestBtn = null;
    while (Date.now() - start < GEETEST_WAIT_MS) {
      geetestBtn = document.querySelector('[class*="geetest_btn_click"]');
      if (geetestBtn) break;
      await sleep(200);
    }

    if (!geetestBtn) {
      log('Geetest não detectado, seguindo fluxo normal...');
      trackTimeout(() => { runOtpAttempt(); }, cfg.otpDelay);
      return;
    }

    log('Geetest detectado! Clicando via CDP...');
const clickResult = await psRequest('clickElement', {
  selector: '[class*="geetest_btn_click"]',
});
log('click CDP: ' + JSON.stringify(clickResult));

// Aguarda você resolver o Geetest (tempo fixo)
log('Aguardando ' + cfg.otpDelay + 'ms para resolver Geetest...');
await sleep(cfg.otpDelay);

log('Iniciando OTP...');
trackTimeout(() => { runOtpAttempt(); }, 0);;
  }

  function setupPrizeDetector() {
    // Coalesce: múltiplas mutations → 1 check por task (setTimeout 0).
    // setTimeout(0) em vez de queueMicrotask: microtasks rodam antes do
    // paint e podem engasgar a UI durante boot/render pesado do SPA.
    // setTimeout devolve o controle ao browser entre batches.
    // Cada tick roda: fechar popups → checar erros de conexão → snipe.
    // Ordem importa: popups e erros têm prioridade porque bloqueiam a UI.
    let pending = false;
    const trigger = () => {
      if (pending) return;
      pending = true;
      trackTimeout(() => {
        pending = false;
        try { checkAndClosePopups();    } catch (e) { log('popups erro:', e.message); }
        try { checkConnectionErrors();  } catch (e) { log('errors erro:', e.message); }
        try { checkSnipe();             } catch (e) { log('checkSnipe erro:', e.message); }
      }, 0);
    };

    // Observer reativo
    prizeObserver = new MutationObserver(trigger);
    const mount = () => {
      if (!document.body) { setTimeout(mount, 50); return; }
      prizeObserver.observe(document.body, { childList: true, subtree: true });
      log('prize observer armado');
    };
    mount();

    // Fallback polling a cada 2s
    trackInterval(trigger, 2000);
  }

  // ---------- Init ----------
  async function init() {
    const s = await storageGet(['botcode_version', 'ps_cfg']);
    botcodeVersion = s.botcode_version || '?';
    if (s.ps_cfg) cfg = Object.assign(cfg, s.ps_cfg);

    log('botcode v' + botcodeVersion + ' iniciado (valorMinimo R$' + cfg.valorMinimo.toFixed(2) + ')');
    setState(STATES.IDLE);

    setupWsListener();
    setupPrizeStormHandler();
    setupPrizeDetector();
    setupClicker();
    setupOtpFlow();
    setupCheckPeriodico();
    setupHud();
  }

// Intercepta instância do Geetest4
(function() {
  var origInit = window.initGeetest4;
  if (!origInit) return;
  window.initGeetest4 = function(config, callback) {
    return origInit(config, function(gt) {
      window._gt4Instance = gt;
      callback(gt);
    });
  };
})();

  init().catch(e => {
    console.error('[PS] init fatal:', e);
    try { log('init fatal:', e.message); } catch (_) {}
  });

})();
