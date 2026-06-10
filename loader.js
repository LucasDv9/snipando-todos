// Prize Sniper V7 [ADMIN] — Loader (ISOLATED world)
// Sem licença, sem heartbeat, sem tela de ativação.
// Injeta botcode local direto e expõe a bridge MAIN ↔ background.

(function () {
  'use strict';

  if (window._prizeSniperLoader) return;
  window._prizeSniperLoader = true;

  // ============================================================
  // BACKGROUND BRIDGE
  // ============================================================

  // Usa connect() para manter a porta aberta e evitar
  // "message port closed before response" no SW MV3.
  function bgCall(action, body) {
    return new Promise((res, rej) => {
      try {
        const port = chrome.runtime.connect({ name: 'ps-bridge' });
        port.onMessage.addListener((resp) => {
          port.disconnect();
          res(resp || {});
        });
        port.onDisconnect.addListener(() => {
          if (chrome.runtime.lastError) {
            rej(new Error(chrome.runtime.lastError.message));
          }
        });
        port.postMessage({ action, body: body || {} });
      } catch (e) {
        rej(e);
      }
    });
  }

  // MAIN world ↔ background bridge (pro botcode usar)
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.type !== 'PS_REQUEST' || typeof msg.id !== 'number') return;

    try {
      const result = await bgCall(msg.action, msg.body);
      window.postMessage({ type: 'PS_RESPONSE', id: msg.id, result }, '*');
    } catch (e) {
      window.postMessage({ type: 'PS_RESPONSE', id: msg.id, error: e.message }, '*');
    }
  });

  // ============================================================
  // INJECT BOTCODE (local, direto)
  // ============================================================

  async function injectBotcode() {
    const resp = await bgCall('fetchBotcode', {});
    if (resp.error) {
      console.warn('[PS-admin] falha inject:', resp.error);
      return;
    }
    console.log('[PS-admin] botcode injetado (' + (resp.size || '?') + ' bytes)');
  }

  injectBotcode().catch(e => console.error('[PS-admin] init fatal:', e));
})();