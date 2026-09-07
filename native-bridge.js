/* ══════════════════════════════════════════════════════════════════
   OSÍRIS — Ponte nativa (Capacitor / Android)  ·  v2
   ------------------------------------------------------------------
   Mudança nesta versão: erros desconhecidos NÃO são mais rotulados
   como "NotAllowedError". A mensagem real aparece na tela, com o
   diagnóstico da etapa em que falhou.

   Diagnóstico manual: 5 toques rápidos no canto superior esquerdo.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) {
    return;
  }

  function plugin(name) {
    if (C.Plugins && C.Plugins[name]) return C.Plugins[name];
    if (typeof C.registerPlugin === 'function') return C.registerPlugin(name);
    return null;
  }

  var Nfc = plugin('CapacitorNfc');
  var App = plugin('App');
  var StatusBar = plugin('StatusBar');

  window.__osirisNfc = { plugin: !!Nfc, etapa: null, status: null, erro: null };

  /* ── 1. Polyfill do Web NFC ─────────────────────── */

  function toBytes(arr) {
    var out = new Uint8Array(arr ? arr.length : 0);
    for (var i = 0; i < out.length; i++) out[i] = arr[i] & 0xff;
    return out;
  }

  function bytesToAscii(arr) {
    var s = '', b = toBytes(arr);
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  function formatSerial(idArr) {
    if (!idArr || !idArr.length) return '';
    var b = toBytes(idArr), p = [];
    for (var i = 0; i < b.length; i++) p.push(('0' + b[i].toString(16)).slice(-2));
    return p.join(':');
  }

  // Em registro NDEF de texto o payload comeca com byte de status e
  // codigo de idioma. O Web NFC entrega o texto limpo, entao removemos
  // esse cabecalho — sem isso o app leria "enAB12CD34".
  function convertRecord(rec) {
    var payload = toBytes(rec.payload);
    var type = bytesToAscii(rec.type);
    var tnf = rec.tnf;
    var recordType = 'unknown', encoding = 'utf-8', lang = null, data = payload;

    if (tnf === 1 && type === 'T') {
      recordType = 'text';
      var status = payload[0] || 0;
      var langLen = status & 0x3f;
      encoding = (status & 0x80) ? 'utf-16' : 'utf-8';
      lang = bytesToAscii(payload.subarray(1, 1 + langLen));
      data = payload.subarray(1 + langLen);
    } else if (tnf === 1 && type === 'U') {
      recordType = 'url';
      var PREFIX = ['', 'http://www.', 'https://www.', 'http://', 'https://',
        'tel:', 'mailto:', 'ftp://anonymous:anonymous@', 'ftp://ftp.', 'ftps://',
        'sftp://', 'smb://', 'nfs://', 'ftp://', 'dav://', 'news:', 'telnet://',
        'imap:', 'rtsp://', 'urn:', 'pop:', 'sip:', 'sips:', 'tftp:', 'btspp://',
        'btl2cap://', 'btgoep://', 'tcpobex://', 'irdaobex://', 'file://',
        'urn:epc:id:', 'urn:epc:tag:', 'urn:epc:pat:', 'urn:epc:raw:',
        'urn:epc:', 'urn:nfc:'];
      var full = (PREFIX[payload[0]] || '') + bytesToAscii(payload.subarray(1));
      data = new Uint8Array(full.length);
      for (var i = 0; i < full.length; i++) data[i] = full.charCodeAt(i) & 0xff;
    } else if (tnf === 2) {
      recordType = 'mime';
    } else if (tnf === 4) {
      recordType = type;
    }

    return {
      recordType: recordType,
      mediaType: (tnf === 2) ? type : null,
      id: rec.id && rec.id.length ? bytesToAscii(rec.id) : null,
      encoding: encoding,
      lang: lang,
      data: new DataView(data.buffer, data.byteOffset, data.byteLength)
    };
  }

  function nfcError(name, message) {
    var e = new Error(message || name);
    e.name = name;
    return e;
  }

  // O Capacitor as vezes rejeita com Error, as vezes com objeto simples.
  function descreve(err) {
    if (!err) return 'erro vazio';
    var p = [];
    if (err.code) p.push('code=' + err.code);
    if (err.message) p.push(err.message);
    if (!p.length) {
      try { p.push(JSON.stringify(err)); } catch (e) { p.push(String(err)); }
    }
    return p.join(' · ');
  }

  function NDEFReaderNative() {
    this._listeners = { reading: [], readingerror: [] };
    this._handle = null;
    this._scanning = false;
  }

  NDEFReaderNative.prototype.addEventListener = function (t, fn) {
    if (this._listeners[t]) this._listeners[t].push(fn);
  };

  NDEFReaderNative.prototype.removeEventListener = function (t, fn) {
    var l = this._listeners[t]; if (!l) return;
    var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  };

  NDEFReaderNative.prototype._emit = function (t, ev) {
    var l = (this._listeners[t] || []).slice();
    for (var i = 0; i < l.length; i++) {
      try { l[i].call(this, ev); } catch (e) { console.error('[osiris-nfc]', e); }
    }
    var h = this['on' + t];
    if (typeof h === 'function') { try { h.call(this, ev); } catch (e) {} }
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
    var D = window.__osirisNfc;
    D.etapa = 'inicio'; D.status = null; D.erro = null;

    if (!Nfc) {
      D.etapa = 'plugin ausente';
      return Promise.reject(nfcError('NotSupportedError'));
    }

    D.etapa = 'getStatus';
    return Nfc.getStatus().then(function (res) {
      var status = (res && res.status) || 'DESCONHECIDO';
      D.status = status;

      if (status === 'NO_NFC') throw nfcError('NotSupportedError');
      if (status === 'NFC_DISABLED') throw nfcError('NotReadableError');

      if (options.signal) {
        if (options.signal.aborted) throw nfcError('AbortError');
        options.signal.addEventListener('abort', function () { self._stop(); });
      }

      D.etapa = 'addListener';
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
      });
    }).then(function (handle) {
      self._handle = handle;
      self._scanning = true;
      D.etapa = 'startScanning';
      return Nfc.startScanning();
    }).then(function () {
      D.etapa = 'escutando';
    }).catch(function (err) {
      self._stop();
      D.erro = descreve(err);

      if (err && (err.name === 'NotSupportedError' ||
                  err.name === 'NotReadableError' ||
                  err.name === 'AbortError')) {
        throw err;
      }

      var code = String((err && (err.code || err.message)) || '');
      if (code.indexOf('NO_NFC') >= 0) throw nfcError('NotSupportedError');
      if (code.indexOf('NFC_DISABLED') >= 0 || code.indexOf('disabled') >= 0) {
        throw nfcError('NotReadableError');
      }

      // Desconhecido: nao inventa "permissao negada". Mostra o que houve.
      throw nfcError('OsirisNfcError',
        'falhou em ' + D.etapa + ' · status=' + D.status + ' · ' + D.erro);
    });
  };

  NDEFReaderNative.prototype.write = function () {
    return Promise.reject(nfcError('NotSupportedError', 'Escrita nao habilitada.'));
  };

  // O WebView do Android EXPOE window.NDEFReader (e Chromium), mas o
  // Web NFC e bloqueado por politica de permissoes ali dentro: o .scan()
  // lanca NotAllowedError. Por isso sobrescrevemos SEMPRE em nativo —
  // checar "if (!('NDEFReader' in window))" faria a ponte nunca instalar.
  window.NDEFReader = NDEFReaderNative;
  window.__osirisNfc.impl = 'ponte-nativa';

  /* ── 2. Botao voltar do Android ─────────────────── */

  var BACK = {
    'register': 'login', 'forgot': 'login',
    'patient-emergency': 'login', 'doctor-emergency': 'login',
    'emergency-loading': 'doctor-emergency',
    'emergency-confirm': 'doctor-emergency',
    'emergency-data': 'doctor-emergency',
    'patient-appointments': 'patient-home', 'patient-exams': 'patient-home',
    'patient-history': 'patient-home', 'patient-vaccines': 'patient-home',
    'patient-doctors': 'patient-home', 'patient-insurance': 'patient-home',
    'doctor-appointments': 'doctor-home', 'doctor-exams': 'doctor-home',
    'doctor-history': 'doctor-home', 'doctor-vaccines': 'doctor-home',
    'doctor-doctors': 'doctor-home', 'doctor-insurance': 'doctor-home'
  };

  var lastBack = 0;

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);' +
      'background:#1e293b;color:#f1f5f9;padding:11px 18px;border-radius:16px;' +
      'font-size:12px;font-family:system-ui,sans-serif;z-index:99999;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none;opacity:0;' +
      'transition:opacity .18s ease;max-width:88vw;text-align:center;' +
      'line-height:1.45;word-break:break-word';
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 200);
    }, 6000);
  }

  if (App && App.addListener) {
    App.addListener('backButton', function () {
      try {
        if (typeof S !== 'undefined' && S.openModal) {
          S.openModal = null;
          var ov = document.getElementById('modal-overlay');
          if (ov) ov.remove();
          return;
        }
        if (typeof S !== 'undefined' && S.sidebarOpen) {
          S.sidebarOpen = false;
          if (typeof render === 'function') render();
          return;
        }
        if (typeof S !== 'undefined' && BACK[S.page] && typeof go === 'function') {
          go(BACK[S.page]);
          return;
        }
        var now = Date.now();
        if (now - lastBack < 2000) { App.exitApp(); }
        else { lastBack = now; toast('Toque em voltar novamente para sair'); }
      } catch (e) { console.error('[osiris-back]', e); }
    });
  }

  /* ── 3. Barra de status ─────────────────────────── */

  if (StatusBar) {
    try {
      StatusBar.setOverlaysWebView({ overlay: false });
      StatusBar.setBackgroundColor({ color: '#020617' });
      StatusBar.setStyle({ style: 'DARK' });
    } catch (e) {}
  }

  /* ── 4. Diagnostico: 5 toques no canto sup. esquerdo ── */

  var toques = 0, ultimo = 0;
  document.addEventListener('click', function (e) {
    if (e.clientX > 90 || e.clientY > 90) { toques = 0; return; }
    var agora = Date.now();
    toques = (agora - ultimo < 900) ? toques + 1 : 1;
    ultimo = agora;
    if (toques < 5) return;
    toques = 0;

    var D = window.__osirisNfc;
    var pStatus = Nfc
      ? Nfc.getStatus().catch(function (e) { return { status: 'ERRO ' + descreve(e) }; })
      : Promise.resolve({ status: 'plugin ausente' });
    var pSup = (Nfc && Nfc.isSupported)
      ? Nfc.isSupported().catch(function () { return {}; })
      : Promise.resolve({});

    Promise.all([pStatus, pSup]).then(function (r) {
      toast('impl=' + (D.impl || 'WEBVIEW') +
            ' · plugin=' + (D.plugin ? 'ok' : 'AUSENTE') +
            ' · hw=' + (r[1].supported === undefined ? '?' : r[1].supported) +
            ' · status=' + r[0].status +
            ' · etapa=' + D.etapa +
            (D.erro ? ' · erro=' + D.erro : ''));
    });
  }, true);
})();
