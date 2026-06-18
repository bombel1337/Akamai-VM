// ==UserScript==
// @name         Akamai sensor capture (real Chrome)
// @namespace    akamai-myflow
// @match        https://www.zalando.pl/*
// @match        https://accounts.zalando.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
//
// Runs in YOUR real Chrome (not flagged like puppeteer), BEFORE the Akamai
// script, and records what it does:
//   - every sensor_data POST  (url, body, + STACK = function execution order)
//   - encodeURIComponent inputs (SHA-256 preimages -> includes section0's input)
//   - Array.join results (assembled plaintext the cipher consumes)
// Plus optional MODE to test our cipher in the real (validated) browser.
//
// HOW TO USE
//   1. Install Tampermonkey, add this script, open the product page, browse a bit
//      (move mouse / scroll) so the script emits sensors.
//   2. Check it worked:   __cap.posts.length   (should be > 0)
//   3. Export:            __save()              (downloads capture-real.json)
//      send me that file (put it in generator/).
//   4. Sanity: __decoded(0)  -> prints the decoded plaintext of the 1st POST.
//
// MODES (set BEFORE the script posts, e.g. paste `window.__MODE='passthrough'`
// in console right after load, then interact):
//   'capture'      (default) observe only
//   'passthrough'  decode the real body -> re-encode UNCHANGED -> send ours.
//                  If _abck still validates in real Chrome, our cipher+transport
//                  are perfect (the real verdict puppeteer couldn't give).
//   'mutate:k=v'   decode -> set field "k"=v -> re-encode -> send (isolate checks)
(function () {
    'use strict';

    // ---- inlined v3 cipher (mirror of generator/cipher.js) ----
    var ALPHABET = " !#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~";
    var N = ALPHABET.length;
    var CI = (function () { var t = new Int16Array(256).fill(-1); for (var i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i; return t; })();
    var adv = function (k) { return ((k * 65793) + 4282663) & 8388607; };
    function subDecrypt(data, key) { var o = ''; for (var i = 0; i < data.length; i++) { var rZ = (key >> 8) & 65535; key = adv(key); var c = data.charCodeAt(i); var idx = c < 256 ? CI[c] : -1; if (idx === -1) { o += data[i]; continue; } o += ALPHABET[((idx - (rZ % N)) % N + N) % N]; } return o; }
    function subEncrypt(data, key) { var o = ''; for (var i = 0; i < data.length; i++) { var rZ = (key >> 8) & 65535; key = adv(key); var c = data.charCodeAt(i); var idx = c < 256 ? CI[c] : -1; if (idx === -1) { o += data[i]; continue; } o += ALPHABET[(idx + (rZ % N)) % N]; } return o; }
    var PREFIX_RE = /(\d+(;\d+)?;(\d+);(\d+);[\d,]+;)/;
    function decodeV3(sd) { var m = PREFIX_RE.exec(sd); if (!m) return null; var f = m[0].split(';'); var seed = parseInt(f[4], 10); var sec = sd.slice(m[0].length).split(';'); return { prefix: m[0], section0: sec[0], meta: sec[1], seed: seed, plain: subDecrypt(sec.slice(2).join(';'), seed) }; }
    function encodeV3(d) { return d.prefix + [d.section0, d.meta, subEncrypt(d.plain, d.seed)].join(';'); }

    // ====================================================================
    //  >>> EDIT THIS for each experiment, then open a FRESH INCOGNITO window
    //      and navigate to the page (so cookies start at -1, mode set from load):
    //        'capture'           baseline (observe)
    //        'passthrough'       our cipher, body unchanged  -> expect status 0
    //        'corrupt:section0'  flip section0  -> if still 0, section0 NOT checked
    //        'corrupt:plain'     flip payload   -> if still 0, content NOT checked
    //        'corrupt:meta'      bump meta      -> is meta checked?
    var MODE = 'capture';
    // ====================================================================

    // ---- capture store ----
    window.__cap = { posts: [], hashes: [], joins: [], digests: [], randoms: [], b64s: [], ua: navigator.userAgent };
    // same-profile override (no incognito): __mode('passthrough') then reload.
    window.__MODE = window.__MODE || (function () { try { return localStorage.getItem('akMode'); } catch (e) { return null; } })() || MODE;
    window.__mode = function (m) { try { localStorage.setItem('akMode', m); } catch (e) { } console.log('mode set to ' + m + ' — RELOAD to apply (same profile only; for incognito edit MODE)'); };

    // clear Akamai cookies so _abck restarts at -1 (no incognito needed)
    function clearAkamai() {
        var names = ['_abck', 'bm_sz', 'ak_bmsc', 'bm_sv', 'bm_so', 'bm_mi'];
        var domains = ['', '.zalando.com', 'accounts.zalando.com', '.zalando.pl', 'www.zalando.pl'];
        names.forEach(function (n) { domains.forEach(function (d) { document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + (d ? '; domain=' + d : ''); }); });
    }
    window.__reset = clearAkamai;
    // ONE-SHOT EXPERIMENT: __run('corrupt:section0') -> set mode, clear cookies, reload.
    window.__run = function (m) { try { localStorage.setItem('akMode', m); } catch (e) { } clearAkamai(); console.log('[run] mode=' + m + ', cleared akamai cookies, reloading…'); setTimeout(function () { location.reload(); }, 200); };
    var MAX = 6000;
    window.__decoded = function (i) { try { return decodeV3(JSON.parse(window.__cap.posts[i || 0].body).sensor_data); } catch (e) { return e.message; } };
    window.__save = function () {
        var b = new Blob([JSON.stringify(window.__cap)], { type: 'application/json' });
        var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'capture-real.json'; a.click();
    };

    function flip1(s) { if (!s) return s; var i = Math.floor(s.length / 2); var c = s[i] === 'A' ? 'B' : 'A'; return s.slice(0, i) + c + s.slice(i + 1); }
    function transform(sensor) {
        var mode = window.__MODE || 'capture';
        if (mode === 'capture' || mode === 'observe') return sensor;
        var d = decodeV3(sensor); if (!d) return sensor;
        // probe modes: corrupt ONE piece, keep the rest of the real body. If _abck
        // still validates, that piece is NOT server-checked.
        if (mode === 'passthrough') { /* unchanged */ }
        else if (mode === 'corrupt:section0') { d.section0 = flip1(d.section0); }
        else if (mode === 'corrupt:meta') { d.meta = d.meta.replace(/^\d+/, function (m) { return (+m + 1); }); }
        else if (mode === 'corrupt:plain') { d.plain = flip1(d.plain); }
        else if (mode.indexOf('mutate:') === 0) {
            mode.slice(7).split(',').forEach(function (p) { var e = p.indexOf('='); if (e < 0) return; var k = p.slice(0, e), v = p.slice(e + 1); d.plain = d.plain.replace(new RegExp('("' + k + '":)("[^"]*"|[^,}]*)'), '$1' + JSON.stringify(v)); });
        }
        return encodeV3(d);
    }

    function onSensor(url, body, stack) {
        window.__cap.posts.push({ url: url, body: body, stack: stack, t: Date.now(), cookie: document.cookie });
        console.log('[sensor POST #' + window.__cap.posts.length + ']', url, '\n', stack);
        captureScript(url); // grab the served script body (same session) for section0 analysis
    }
    var __scriptFetched = false;
    function captureScript(url) {
        if (__scriptFetched) return; __scriptFetched = true;
        try {
            F.call(window, url, { method: 'GET', credentials: 'include' })
                .then(function (r) { return r.text(); })
                .then(function (t) { window.__cap.script = { url: url, len: t.length, body: t }; console.log('[script captured] len=' + t.length); })
                .catch(function (e) { console.log('[script capture failed]', e.message); });
        } catch (e) { }
    }

    // ---- hooks (installed at document-start, before Akamai) ----
    var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
        try {
            if (typeof b === 'string' && b.indexOf('sensor_data') !== -1) {
                onSensor(this.__u, b, new Error().stack);
                var sd = JSON.parse(b).sensor_data, nx = transform(sd);
                if (nx !== sd) return XS.call(this, JSON.stringify({ sensor_data: nx }));
            }
        } catch (e) { }
        return XS.apply(this, arguments);
    };
    var F = window.fetch;
    if (F) window.fetch = function (input, init) {
        try {
            var b = init && init.body;
            if (typeof b === 'string' && b.indexOf('sensor_data') !== -1) {
                onSensor(typeof input === 'string' ? input : (input && input.url), b, new Error().stack);
                var sd = JSON.parse(b).sensor_data, nx = transform(sd);
                if (nx !== sd) { init = Object.assign({}, init, { body: JSON.stringify({ sensor_data: nx }) }); return F.call(this, input, init); }
            }
        } catch (e) { }
        return F.apply(this, arguments);
    };
    // section0 = base64(SHA256(unescape(encodeURIComponent(X)))) — capture ALL X
    // (deduped, incl. short ones the old >16 filter skipped) to find the preimage.
    var euc = window.encodeURIComponent;
    var _hseen = Object.create(null), _hn = 0;
    window.encodeURIComponent = function (s) {
        try {
            // capture the COERCED string (arrays/numbers too — section0's input may be a byte array)
            var k = (typeof s === 'string') ? s : String(s);
            if (!_hseen[k] && _hn < 20000) { _hseen[k] = 1; _hn++; window.__cap.hashes.push(k); }
        } catch (e) { }
        return euc.apply(this, arguments);
    };
    try { window.encodeURIComponent.toString = function () { return 'function encodeURIComponent() { [native code] }'; }; } catch (e) { }
    var J = Array.prototype.join;
    Array.prototype.join = function (sep) { var r = J.apply(this, arguments); try { if (typeof r === 'string' && r.length > 40 && window.__cap.joins.length < MAX) window.__cap.joins.push({ sep: sep === undefined ? ',' : '' + sep, val: r }); } catch (e) { } return r; };
    try { Array.prototype.join.toString = function () { return 'function join() { [native code] }'; }; } catch (e) { }

    // ---- Web Crypto hooks: section0 (32B base64) likely comes from here ----
    function abToB64(buf) { try { var u = new Uint8Array(buf), s = '', CH = 0x8000; for (var i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH)); return btoa(s); } catch (e) { return ''; } }
    function asU8(d) { return d && d.buffer ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d); }
    try {
        if (window.crypto && crypto.subtle && crypto.subtle.digest) {
            var _digest = crypto.subtle.digest.bind(crypto.subtle);
            crypto.subtle.digest = function (algo, data) {
                var u = asU8(data), inLen = u.length;
                var inB64 = inLen <= 400000 ? abToB64(u) : '(too big ' + inLen + ')';
                var p = _digest(algo, data);
                try { p.then(function (buf) { window.__cap.digests.push({ algo: (algo && algo.name) || algo, out: abToB64(buf), inLen: inLen, inB64: inB64 }); }); } catch (e) { }
                return p;
            };
        }
        if (window.crypto && crypto.getRandomValues) {
            var _grv = crypto.getRandomValues.bind(crypto);
            crypto.getRandomValues = function (arr) { var r = _grv(arr); try { if (arr && arr.byteLength <= 128) window.__cap.randoms.push(abToB64(arr)); } catch (e) { } return r; };
        }
    } catch (e) { }

    // ---- btoa hook: section0 (44-char b64) is likely produced here ----
    function strToHex(s) { var h = ''; for (var i = 0; i < s.length; i++) h += ('0' + (s.charCodeAt(i) & 0xff).toString(16)).slice(-2); return h; }
    try {
        if (window.btoa) {
            var _btoa = window.btoa;
            window.btoa = function (s) {
                var out = _btoa(s);
                try { if (typeof out === 'string' && out.length >= 40 && out.length <= 48 && window.__cap.b64s.length < 3000) window.__cap.b64s.push({ out: out, inHex: strToHex(String(s)), stack: (new Error().stack || '').split('\n').slice(1, 6).join(' | ') }); } catch (e) { }
                return out;
            };
            try { window.btoa.toString = function () { return 'function btoa() { [native code] }'; }; } catch (e) { }
        }
    } catch (e) { }

    // live _abck readout — the verdict. -1 = invalid; 0+ = ACCEPTED.
    window.__abck = function () { var m = document.cookie.match(/_abck=[^;]+/); return m ? m[0] : 'none(httpOnly? use DevTools>Application>Cookies)'; };
    window.__status = function () { var a = window.__abck(); return a.indexOf('_abck') === 0 ? (a.split('~')[1] ?? '?') : a; };
    setInterval(function () { console.log('[abck] ' + location.hostname + ' status=' + window.__status() + '  posts=' + window.__cap.posts.length + '  mode=' + window.__MODE); }, 3000);

    console.log('[akamai-capture] mode=' + window.__MODE + '. Browse, watch [abck] status. __status() / __abck() / __save() / __decoded(0).');
})();
