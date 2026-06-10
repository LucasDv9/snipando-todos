// Prize Sniper V7 — Platform helper (ISOLATED world, only on host cassinos)
// Runs on 7games.bet.br, betao.bet.br, r7.bet.br (NOT pokgaming).
// Two jobs:
//  1. Auto-click the "Jogar" button when it appears in a 7Fly/POPOK modal
//     (needed for r7 reload flow — the game detail modal pops up after reload
//     for some users and blocks the game until Jogar is clicked).
//  2. Listen for PRIZE_SNIPER_REFRESH_GAME postMessage from the pokgaming
//     iframe (via window.top/parent) and click the casino's in-game refresh
//     button. Much faster than a full tab reload.

(function () {
  if (window._psPlatformLoaded) return;
  window._psPlatformLoaded = true;

  const LOG_TAG   = '%c[PS-platform]';
  const LOG_STYLE = 'color:#a78bfa;font-weight:bold';
  const log = (...args) => console.log(LOG_TAG + ' ' + args[0], LOG_STYLE, ...args.slice(1));

  log('loaded @ ' + location.hostname);

  // ============================================================
  // 1. Auto-click Jogar (r7 case)
  // ============================================================

  const JOGAR_DEBOUNCE_MS = 3000;
  let lastJogarClick = 0;

  function findJogarBtn() {
    // Só busca por CSS module hash "playBtn". O fallback varrendo TODOS
    // os <button> foi removido: durante o boot do SPA React do cassino
    // ele fazia querySelectorAll('button') + textContent em 8 ancestrais
    // por nó, em cada mutation, congelando a aba.
    const hashed = document.querySelectorAll('button[class*="playBtn"]');
    for (const btn of hashed) {
      if (btn.textContent.trim().toLowerCase() === 'jogar') {
        if (isBtnFor7Fly(btn)) return btn;
      }
    }
    return null;
  }

  function isBtnFor7Fly(btn) {
    // Sobe até 8 níveis procurando texto "7fly" ou "popok" no ancestral
    let el = btn;
    for (let depth = 0; depth < 8 && el; depth++) {
      const txt = (el.textContent || '').toLowerCase();
      if (txt.includes('7fly') || txt.includes('popok')) return true;
      el = el.parentElement;
    }
    return false;
  }

  function checkAndClickJogar() {
    const now = Date.now();
    if (now - lastJogarClick < JOGAR_DEBOUNCE_MS) return;

    const btn = findJogarBtn();
    if (!btn || btn.disabled) return;

    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;  // invisible

    log('auto-click Jogar (7Fly)');
    lastJogarClick = now;

    try { btn.click(); } catch (e) {}
    try {
      const opts = { bubbles: true, cancelable: true, buttons: 1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      btn.dispatchEvent(new MouseEvent('pointerdown', opts));
      btn.dispatchEvent(new MouseEvent('mousedown',   opts));
      btn.dispatchEvent(new MouseEvent('pointerup',   opts));
      btn.dispatchEvent(new MouseEvent('mouseup',     opts));
      btn.dispatchEvent(new MouseEvent('click',       opts));
    } catch (e) {}
  }

  // ============================================================
  // 2. Refresh game button (postMessage listener)
  // ============================================================

  function clickRefreshBtn() {
    const btn = document.querySelector(
      'i.casino-full-game-panel-element.bc-i-refresh, ' +
      '[title="Atualizar"], ' +
      '.bc-i-refresh'
    );
    if (btn) {
      log('refresh game — clicando botão');
      try { btn.click(); } catch (e) {}
      return true;
    }
    log('refresh game — botão não achado, fallback location.reload()');
    try { window.location.reload(); } catch (e) {}
    return false;
  }

  window.addEventListener('message', (event) => {
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'PRIZE_SNIPER_REFRESH_GAME') {
      clickRefreshBtn();
    }
    if (event.data.type === 'PRIZE_SNIPER_CLICK_GEETEST') {
      const btn = document.querySelector('.geetest_btn_click');
      if (btn) {
        log('clicando Geetest...');
        btn.click();
      }
    }
  }); 

  // ============================================================
  // Observer
  // ============================================================

  function mount() {
    if (!document.body) { setTimeout(mount, 50); return; }

    // Check imediato
    checkAndClickJogar();

    // Observer coalescido via microtask + bail cedo.
    // Durante o boot do SPA React do cassino chegam dezenas de milhares
    // de mutations. Coalescer por microtask reduz pra 1 execução por tick,
    // e o early-bail com querySelector barato (não entra no loop do
    // findJogarBtn a menos que exista pelo menos 1 candidato) mantém o
    // custo baixo enquanto o modal ainda não apareceu.
    let pending = false;
    const trigger = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        if (!document.querySelector('button[class*="playBtn"]')) return;
        checkAndClickJogar();
      });
    };

    const obs = new MutationObserver(trigger);
    obs.observe(document.body, { childList: true, subtree: true });

    // Safety net: polling a cada 2s caso alguma mutation seja perdida
    setInterval(checkAndClickJogar, 2000);

    log('platform helper armado');
  }
  
// Notifica iframe quando Geetest aparecer
  function setupGeetestObserver() {
    if (!document.body) { setTimeout(setupGeetestObserver, 50); return; }
    log('geetest observer armado');
    var _geetestNotified = false;
    
    function checkGeetest() {
      if (_geetestNotified) return;
      var btn = document.querySelector('[class*="geetest_btn_click"]');
      if (!btn) return;
      _geetestNotified = true;
      setTimeout(function() { _geetestNotified = false; }, 30000);
      var iframe = document.querySelector('iframe');
      if (iframe && iframe.contentWindow) {
        try { iframe.contentWindow.postMessage({ type: 'PRIZE_SNIPER_GEETEST_READY' }, '*'); } catch(e) {}
      }
      log('Geetest detectado — notificando iframe');
    }

    new MutationObserver(checkGeetest).observe(document.body, { childList: true, subtree: true });
    setInterval(checkGeetest, 500); // ← polling a cada 500ms como fallback
  }

  setupGeetestObserver();
  mount();
})();