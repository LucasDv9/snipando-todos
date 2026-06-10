// Prize Sniper V7 — WebSocket Hook (MAIN world, document_start)

(function () {
  // a) Guard via Symbol — invisível para JS externo, não aparece em window.*
  var _GUARD = Symbol('ps');
  if (window[_GUARD]) return;
  window[_GUARD] = true;

  var OriginalWebSocket = window.WebSocket;
  if (!OriginalWebSocket) return;

  var CAPTCHA_RE = /\/captcha\//;

  // Cache interno via closure — sem window._psLatestCaptcha exposto
  var _lastCaptcha = null;
  Object.defineProperty(window, '_psLatestCaptcha', {
    get: function () { return _lastCaptcha; },
    set: function (v) { _lastCaptcha = v; },
    configurable: true,
  });

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function publish(url, buf, mediaType, b64Override) {
    try {
      var b64 = b64Override || bufToB64(buf);
      var payload = { url: url, base64: b64, mediaType: mediaType || 'image/png', ts: Date.now() };
      _lastCaptcha = payload;
      window.dispatchEvent(new CustomEvent('ps:captcha-bytes', { detail: payload }));
    } catch (e) {}
  }

  // Hook fetch — intercepta o fetch que o JOGO faz para /captcha/.
  // b) Proxy mascarado: toString e name idênticos ao nativo.
  if (window.fetch) {
    var origFetch = window.fetch;
    var patchedFetch = new Proxy(origFetch, {
      apply: function (target, thisArg, args) {
        var url = '';
        try { url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''; } catch (e) {}
        var p = Reflect.apply(target, thisArg, args);
        if (CAPTCHA_RE.test(url)) {
          p.then(function (r) {
            var clone;
            try { clone = r.clone(); } catch (e) { return; }
            clone.blob().then(function (blob) {
              blob.arrayBuffer().then(function (buf) { publish(url, buf, blob.type); });
            });
          }).catch(function () {});
        }
        return p;
      },
    });
    // b) Mascarar toString e name do Proxy para parecer nativo
    try {
      Object.defineProperty(patchedFetch, 'toString', {
        value: function toString() { return origFetch.toString(); },
        configurable: true,
      });
      Object.defineProperty(patchedFetch, 'name', { value: 'fetch', configurable: true });
    } catch (e) {}
    window.fetch = patchedFetch;
  }

  // Hook XMLHttpRequest — fallback se o jogo usar XHR em vez de fetch.
  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR && OrigXHR.prototype) {
    var origOpen = OrigXHR.prototype.open;
    var origSend = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url) {
      this._psUrl = url;
      return origOpen.apply(this, arguments);
    };
    OrigXHR.prototype.send = function () {
      var url = this._psUrl || '';
      if (CAPTCHA_RE.test(url)) {
        this.addEventListener('load', function () {
          try {
            if (this.responseType === 'blob' && this.response) {
              var blob = this.response;
              blob.arrayBuffer().then(function (buf) { publish(url, buf, blob.type); });
            } else if (this.responseType === 'arraybuffer' && this.response) {
              publish(url, this.response, 'image/png');
            }
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  // Image.src setter — define crossOrigin='anonymous' ANTES do browser iniciar o
  // request, depois lê via canvas no onload. Zero segundo request = sem corrida
  // com o jogo em URLs de uso único (comportamento do servidor no modo mobile).
  // c) Setter mascarado: toString idêntico ao descriptor nativo.
  try {
    var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (imgDesc && imgDesc.set) {
      var patchedSetter = function (val) {
        if (val && CAPTCHA_RE.test(val)) {
          try { this.crossOrigin = 'anonymous'; } catch (e) {}
          var self = this;
          var captureUrl = val;
          self.addEventListener('load', function onCaptchaLoad() {
            self.removeEventListener('load', onCaptchaLoad);
            try {
              var c = document.createElement('canvas');
              c.width  = self.naturalWidth  || self.width;
              c.height = self.naturalHeight || self.height;
              c.getContext('2d').drawImage(self, 0, 0);
              var b64 = c.toDataURL('image/png').split(',')[1];
              publish(captureUrl, null, 'image/png', b64);
            } catch (e) {}
          }, { once: true });
        }
        imgDesc.set.call(this, val);
      };
      // c) Mascarar toString do setter para parecer nativo
      try {
        Object.defineProperty(patchedSetter, 'toString', {
          value: function toString() { return imgDesc.set.toString(); },
          configurable: true,
        });
        Object.defineProperty(patchedSetter, 'name', { value: 'set', configurable: true });
      } catch (e) {}
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        get: imgDesc.get,
        set: patchedSetter,
      });
    }
  } catch (e) {}

  // WebSocket — substituição direta preserva ws.constructor === WebSocket.
  // toString e name mascarados contra fingerprinting.
  function WebSocket(url, protocols) {
    var socket = protocols
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);

    socket.addEventListener('message', function (event) {
      try {
        window.dispatchEvent(new CustomEvent('ps:ws-message', {
          detail: { raw: event.data, url: url },
        }));
      } catch (e) {}
    });

    return socket;
  }

  WebSocket.prototype   = OriginalWebSocket.prototype;
  WebSocket.CONNECTING  = OriginalWebSocket.CONNECTING;
  WebSocket.OPEN        = OriginalWebSocket.OPEN;
  WebSocket.CLOSING     = OriginalWebSocket.CLOSING;
  WebSocket.CLOSED      = OriginalWebSocket.CLOSED;

  try {
    Object.defineProperty(WebSocket, 'name', { value: 'WebSocket', configurable: true });
    WebSocket.toString = function () { return OriginalWebSocket.toString(); };
    WebSocket.prototype.toString = OriginalWebSocket.prototype.toString;
  } catch (e) {}

  window.WebSocket = WebSocket;
  
  // Hook Geetest V4 — intercepta parâmetros do desafio
if (origFetch) {
    var origFetchGee = origFetch;  // ← usa o fetch original
    window.fetch = new Proxy(origFetchGee, {
      apply: function(target, thisArg, args) {
        var url = '';
        try { url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''; } catch(e) {}
        var p = Reflect.apply(target, thisArg, args);
        if (/load\?callback=geetest/.test(url)) {
          p.then(function(r) {
            var clone;
            try { clone = r.clone(); } catch(e) { return; }
            clone.text().then(function(text) {
              try {
                var match = text.match(/\((\{.*\})\)/s);
                if (!match) return;
                var data = JSON.parse(match[1]);
                if (data && data.data) {
                  window._psGeetestParams = {
                    challenge: data.data.challenge || '',
                  };
                  window.dispatchEvent(new CustomEvent('ps:geetest-params', {
                    detail: window._psGeetestParams
                  }));
                }
              } catch(e) {}
            }).catch(function(){});
          }).catch(function(){});
        }
        return p;
      }
    });
  }

// Intercepta challenge do Geetest via MutationObserver em script tags
  var _geetestChallenge = null;
  Object.defineProperty(window, '_psGeetestChallenge', {
    get: function() { return _geetestChallenge; },
    set: function(v) { _geetestChallenge = v; },
    configurable: true,
  });

  new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.tagName !== 'SCRIPT') return;
        var src = node.src || '';
        // Extrai challenge da URL do script de load
        if (/load.*callback.*geetest|geetest.*load/.test(src)) {
          var match = src.match(/challenge=([a-f0-9\-]+)/i);
          if (match) {
            _geetestChallenge = match[1];
            window.dispatchEvent(new CustomEvent('ps:geetest-challenge', {
              detail: { challenge: _geetestChallenge }
            }));
          }
        }
        // Detecta verify bem-sucedido via script tag
        if (/verify/.test(src)) {
          node.addEventListener('load', function() {
            window._psGeetestVerified = true;
            window.dispatchEvent(new CustomEvent('ps:geetest-verified', {}));
          });
        }
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Intercepta verify do Geetest via fetch
  if (origFetch) {
    window.fetch = new Proxy(window.fetch, {
      apply: function(target, thisArg, args) {
        var url = '';
        try { url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''; } catch(e) {}
        var p = Reflect.apply(target, thisArg, args);
        if (/gcaptcha4.*verify|verify.*gcaptcha4/.test(url)) {
          p.then(function(r) {
            var clone;
            try { clone = r.clone(); } catch(e) { return; }
            clone.text().then(function(text) {
              try {
                var match = text.match(/\((\{.*\})\)/s);
                if (!match) return;
                var data = JSON.parse(match[1]);
                if (data && data.status === 'success') {
                  window._psGeetestVerified = true;
                  window.dispatchEvent(new CustomEvent('ps:geetest-verified', { detail: data }));
                }
              } catch(e) {}
            }).catch(function(){});
          }).catch(function(){});
        }
        return p;
      }
    });
  }

  // XHR fallback
  var origOpenVerify = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (/gcaptcha4.*verify/.test(url)) {
      this.addEventListener('load', function() {
        try {
          var text = this.responseText;
          var match = text.match(/\((\{.*\})\)/);
          if (match) {
            var data = JSON.parse(match[1]);
            if (data && data.status === 'success') {
              window._psGeetestVerified = true;
              window.dispatchEvent(new CustomEvent('ps:geetest-verified', { detail: data }));
            }
          }
        } catch(e) {}
      });
    }
    return origOpenVerify.apply(this, arguments);
  };

})();
