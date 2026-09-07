/* ══════════════════════════════════════════════════════════════════
   OSÍRIS — Ponte nativa (Capacitor / Android)
   ------------------------------------------------------------------
   Este arquivo NÃO altera nenhuma função do app. Ele apenas:

   1. Cria window.NDEFReader em cima do plugin nativo de NFC, com a
      mesma interface do Web NFC. Assim doScanNFC() roda inalterado.
   2. Mapeia o botão físico "voltar" do Android para o router go().
   3. Ajusta a barra de status.

   No navegador (GitHub Pages) este arquivo não faz absolutamente
   nada — o Web NFC nativo do Chrome continua sendo usado.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) {
    return; // rodando no navegador: nada a fazer
  }

  function plugin(name) {
    if (C.Plugins && C.Plugins[name]) return C.Plugins[name];
    if (typeof C.registerPlugin === 'function') return C.registerPlugin(name);
    return null;
  }

  var Nfc = plugin('CapacitorNfc');
  var App = plugin('App');
  var StatusBar = plugin('StatusBar');

  /* ────────────────────────────────────────────────
     1. Polyfill do Web NFC (NDEFReader)
     ──────────────────────────────────────────────── */

  // Bytes do Java chegam com sinal (-128..127). Normaliza para 0..255.
  function toBytes(arr) {
    var out = new Uint8Array(arr ? arr.length : 0);
    for (var i = 0; i < out.length; i++) out[i] = arr[i] & 0xff;
    return out;
  }

  function bytesToAscii(arr) {
    var s = '';
    var b = toBytes(arr);
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  // Formato do serialNumber no Web NFC: "04:1a:2b:3c"
  function formatSerial(idArr) {
    if (!idArr || !idArr.length) return '';
    var b = toBytes(idArr), parts = [];
    for (var i = 0; i < b.length; i++) {
      parts.push(('0' + b[i].toString(16)).slice(-2));
    }
    return parts.join(':');
  }

  // Converte um registro NDEF cru no formato que o Web NFC entrega.
  // O ponto crítico: em um registro de texto, o payload tem um byte de
  // status e o código de idioma na frente. O Web NFC já entrega o texto
  // limpo, então precisamos remover esse cabeçalho — senão o app leria
  // "enAB12CD34" em vez de "AB12CD34".
  function convertRecord(rec) {
    var payload = toBytes(rec.payload);
    var type = bytesToAscii(rec.type);
    var tnf = rec.tnf;

    var recordType = 'unknown';
    var encoding = null;
    var lang = null;
    var data = payload;

    if (tnf === 1 && type === 'T') {
      // Registro de texto bem conhecido
      recordType = 'text';
      var status = payload[0] || 0;
      var langLen = status & 0x3f;
      encoding = (status & 0x80) ? 'utf-16' : 'utf-8';
      lang = bytesToAscii(payload.subarray(1, 1 + langLen));
      data = payload.subarray(1 + langLen);
    } else if (tnf === 1 && type === 'U') {
      // Registro de URI: o primeiro byte é o prefixo abreviado
      recordType = 'url';
      encoding = 'utf-8';
      var PREFIX = ['', 'http://www.', 'https://www.', 'http://', 'https://',
        'tel:', 'mailto:', 'ftp://anonymous:anonymous@', 'ftp://ftp.',
        'ftps://', 'sftp://', 'smb://', 'nfs://', 'ftp://', 'dav://',
        'news:', 'telnet://', 'imap:', 'rtsp://', 'urn:', 'pop:', 'sip:',
        'sips:', 'tftp:', 'btspp://', 'btl2cap://', 'btgoep://',
        'tcpobex://', 'irdaobex://', 'file://', 'urn:epc:id:',
        'urn:epc:tag:', 'urn:epc:pat:', 'urn:epc:raw:', 'urn:epc:',
        'urn:nfc:'];
      var pre = PREFIX[payload[0]] || '';
      var rest = bytesToAscii(payload.subarray(1));
      var full = pre + rest;
      data = new Uint8Array(full.length);
      for (var i = 0; i < full.length; i++) data[i] = full.charCodeAt(i) & 0xff;
    } else if (tnf === 2) {
      recordType = 'mime';
      encoding = 'utf-8';
    } else if (tnf === 4) {
      recordType = type;
      encoding = 'utf-8';
    } else {
      encoding = 'utf-8';
    }

    return {
      recordType: recordType,
      mediaType: (tnf === 2) ? type : null,
      id: rec.id && rec.id.length ? bytesToAscii(rec.id) : null,
      encoding: encoding,
      lang: lang,
      // O app faz TextDecoder().decode(record.data) — precisa ser DataView
      data: new DataView(data.buffer, data.byteOffset, data.byteLength)
    };
  }

  function nfcError(name, message) {
    var e = new Error(message || name);
    e.name = name;
    return e;
  }

  function NDEFReaderNative() {
    this._listeners = { reading: [], readingerror: [] };
    this._handle = null;
    this._scanning = false;
  }

  NDEFReaderNative.prototype.addEventListener = function (type, fn) {
    if (this._listeners[type]) this._listeners[type].push(fn);
  };

  NDEFReaderNative.prototype.removeEventListener = function (type, fn) {
    var l = this._listeners[type];
    if (!l) return;
    var i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };

  NDEFReaderNative.prototype._emit = function (type, ev) {
    var l = this._listeners[type] || [];
    for (var i = 0; i < l.length; i++) {
      try { l[i].call(this, ev); } catch (e) { console.error('[osiris-nfc]', e); }
    }
    // Suporte a onreading / onreadingerror, por compatibilidade
    var handler = this['on' + type];
    if (typeof handler === 'function') {
      try { handler.call(this, ev); } catch (e) { console.error('[osiris-nfc]', e); }
    }
  };

  NDEFReaderNative.prototype._stop = function () {
    this._scanning = false;
    if (this._handle && typeof this._handle.remove === 'function') {
      try { this._handle.remove(); } catch (e) {}
    }
    this._handle = null;
    if (Nfc) { try { Nfc.stopScanning(); } catch (e) {} }
  };

  NDEFReaderNative.prototype.scan = function (options) {
    var self = this;
    options = options || {};

    if (!Nfc) return Promise.reject(nfcError('NotSupportedError'));

    return Nfc.getStatus().then(function (res) {
      var status = res && res.status;

      // Mapeia para os mesmos nomes de erro do Web NFC, para que as
      // mensagens já existentes no app apareçam sem alteração.
      if (status === 'NO_NFC') throw nfcError('NotSupportedError');
      if (status === 'NFC_DISABLED') throw nfcError('NotReadableError');

      if (options.signal) {
        if (options.signal.aborted) throw nfcError('AbortError');
        options.signal.addEventListener('abort', function () { self._stop(); });
      }

      return Nfc.addListener('nfcEvent', function (event) {
        if (!self._scanning) return;
        var tag = (event && event.tag) || {};
        var records = [];
        if (tag.ndefMessage && tag.ndefMessage.length) {
          for (var i = 0; i < tag.ndefMessage.length; i++) {
            try { records.push(convertRecord(tag.ndefMessage[i])); } catch (e) {}
          }
        }
        self._emit('reading', {
          message: { records: records },
          serialNumber: formatSerial(tag.id)
        });
      }).then(function (handle) {
        self._handle = handle;
        self._scanning = true;
        return Nfc.startScanning();
      });
    }).catch(function (err) {
      self._stop();
      // Erros vindos do plugin nativo
      var code = err && (err.code || err.message || '');
      if (err && err.name) throw err;
      if (String(code).indexOf('NO_NFC') >= 0) throw nfcError('NotSupportedError');
      if (String(code).indexOf('DISABLED') >= 0) throw nfcError('NotReadableError');
      throw nfcError('NotAllowedError', String(code));
    });
  };

  NDEFReaderNative.prototype.write = function () {
    return Promise.reject(nfcError('NotSupportedError', 'Escrita não habilitada.'));
  };

  // Só define se o WebView não tiver Web NFC (é sempre o caso no Android)
  if (!('NDEFReader' in window)) {
    window.NDEFReader = NDEFReaderNative;
  }

  /* ────────────────────────────────────────────────
     2. Botão voltar do Android
     ──────────────────────────────────────────────── */

  // Mapa de retorno de cada tela. Telas ausentes = raiz.
  var BACK = {
    'register': 'login',
    'forgot': 'login',
    'patient-emergency': 'login',
    'doctor-emergency': 'login',
    'emergency-loading': 'doctor-emergency',
    'emergency-confirm': 'doctor-emergency',
    'emergency-data': 'doctor-emergency',
    'patient-appointments': 'patient-home',
    'patient-exams': 'patient-home',
    'patient-history': 'patient-home',
    'patient-vaccines': 'patient-home',
    'patient-doctors': 'patient-home',
    'patient-insurance': 'patient-home',
    'doctor-appointments': 'doctor-home',
    'doctor-exams': 'doctor-home',
    'doctor-history': 'doctor-home',
    'doctor-vaccines': 'doctor-home',
    'doctor-doctors': 'doctor-home',
    'doctor-insurance': 'doctor-home'
  };

  var lastBack = 0;

  if (App && App.addListener) {
    App.addListener('backButton', function () {
      try {
        // 1) Modal aberto: fecha o modal
        if (typeof S !== 'undefined' && S.openModal) {
          S.openModal = null;
          var ov = document.getElementById('modal-overlay');
          if (ov) ov.remove();
          return;
        }
        // 2) Menu lateral aberto: fecha o menu
        if (typeof S !== 'undefined' && S.sidebarOpen) {
          S.sidebarOpen = false;
          if (typeof render === 'function') render();
          return;
        }
        // 3) Tela com pai definido: volta
        if (typeof S !== 'undefined' && BACK[S.page] && typeof go === 'function') {
          go(BACK[S.page]);
          return;
        }
        // 4) Tela raiz: exige dois toques para sair
        var now = Date.now();
        if (now - lastBack < 2000) {
          App.exitApp();
        } else {
          lastBack = now;
          toast('Toque em voltar novamente para sair');
        }
      } catch (e) {
        console.error('[osiris-back]', e);
      }
    });
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);' +
      'background:#1e293b;color:#f1f5f9;padding:11px 18px;border-radius:9999px;' +
      'font-size:13px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'z-index:99999;box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none;opacity:0;' +
      'transition:opacity .18s ease';
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 200);
    }, 1600);
  }

  /* ────────────────────────────────────────────────
     3. Barra de status
     ──────────────────────────────────────────────── */

  if (StatusBar) {
    try {
      StatusBar.setOverlaysWebView({ overlay: false });
      StatusBar.setBackgroundColor({ color: '#020617' }); // --bg-950
      StatusBar.setStyle({ style: 'DARK' });              // ícones claros
    } catch (e) {}
  }
})();
