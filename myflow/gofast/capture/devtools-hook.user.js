// ==UserScript==
// @name         gofast — Akamai sensor capture (real Chrome)
// @namespace    akamai-myflow-gofast
// @match        https://www.zalando.pl/*
// @match        https://accounts.zalando.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
//
// AUTHORIZED TESTING OF YOUR OWN AKAMAI-PROTECTED SITE ONLY.
// Edit the @match lines above to your domain before installing.
//
// Runs in YOUR real Chrome (Akamai trusts real Chrome, unlike puppeteer), BEFORE
// the Akamai script, and records what it does — this is how we get past the static
// "step-3" wall (the decrypted plaintext is transposed per POST; see WORKFLOW.md
// phase 6). It captures:
//   - every sensor_data POST            (url, body, + STACK = execution order)
//   - encodeURIComponent inputs         (SHA-256 preimages -> includes section0's input)
//   - Array.join results                (the assembled plaintext the cipher consumes)
//   - crypto.subtle.digest in/out       (section0 = SHA-256(...) candidate)
//   - btoa in/out                       (section0 is a 44-char base64 -> produced here)
// Plus probe MODES to test our cipher/acceptance in the real (validated) browser.
//
// HOW TO USE
//   1. Install Tampermonkey, add this script, open YOUR page, browse a bit
//      (move mouse / scroll) so the script emits sensors.
//   2. Check it worked:   __cap.posts.length          (should be > 0)
//   3. Export:            __save()                    (downloads capture-real.json)
//      Put that file in myflow/gofast/capture/ and run:
//        go run . capture-analyze capture/capture-real.json
//   4. Sanity in console: __decoded(0)  -> decoded plaintext of the 1st POST.
//
// MODES (the fastest path to a verdict): set BEFORE the script posts.
//   'capture'           (default) observe only
//   'passthrough'       decode the real body -> re-encode with OUR cipher UNCHANGED
//                       -> send ours. If _abck still validates, our cipher+transport
//                       are perfect (the real verdict puppeteer cannot give).
//   'corrupt:section0'  flip section0  -> if _abck still valid, section0 NOT checked
//   'corrupt:plain'     flip payload   -> is the content checked?
//   'corrupt:meta'      bump meta      -> is meta checked?
//   'mutate:k=v'        decode -> set field "k"=v -> re-encode (isolate one field)
//   'regen'             keep real section0/meta/seed, refresh `sc` timestamps to now,
//                       re-encode -> tests capture-assisted GENERATION (not just replay)
// Apply a mode without incognito:  __run('passthrough')  (sets mode, clears Akamai
// cookies so _abck restarts at -1, reloads).
(function () {
    'use strict';

    // ---- inlined v3 cipher (mirror of ../sensor/cipher.go) ----
    var ALPHABET = " !#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~";
    var N = ALPHABET.length;
    var CI = (function () { var t = new Int16Array(256).fill(-1); for (var i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i; return t; })();
    var adv = function (k) { return ((k * 65793) + 4282663) & 8388607; };
    function subDecrypt(data, key) { var o = ''; for (var i = 0; i < data.length; i++) { var rZ = (key >> 8) & 65535; key = adv(key); var c = data.charCodeAt(i); var idx = c < 256 ? CI[c] : -1; if (idx === -1) { o += data[i]; continue; } o += ALPHABET[((idx - (rZ % N)) % N + N) % N]; } return o; }
    function subEncrypt(data, key) { var o = ''; for (var i = 0; i < data.length; i++) { var rZ = (key >> 8) & 65535; key = adv(key); var c = data.charCodeAt(i); var idx = c < 256 ? CI[c] : -1; if (idx === -1) { o += data[i]; continue; } o += ALPHABET[(idx + (rZ % N)) % N]; } return o; }
    var PREFIX_RE = /(\d+(;\d+)?;(\d+);(\d+);[\d,]+;)/;
    function decodeV3(sd) { var m = PREFIX_RE.exec(sd); if (!m) return null; var f = m[0].split(';'); var seed = parseInt(f[4], 10); var sec = sd.slice(m[0].length).split(';'); return { prefix: m[0], section0: sec[0], meta: sec[1], seed: seed, plain: subDecrypt(sec.slice(2).join(';'), seed) }; }
    function encodeV3(d) { return d.prefix + [d.section0, d.meta, subEncrypt(d.plain, d.seed)].join(';'); }

    // >>> default mode; override live with __run('passthrough') etc.
    var MODE = 'capture';

    // ---- capture store ----
    window.__cap = { posts: [], hashes: [], joins: [], digests: [], randoms: [], b64s: [], ua: navigator.userAgent };
    window.__MODE = window.__MODE || (function () { try { return localStorage.getItem('akMode'); } catch (e) { return null; } })() || MODE;
    window.__mode = function (m) { try { localStorage.setItem('akMode', m); } catch (e) { } console.log('mode set to ' + m + ' — RELOAD to apply'); };

    // clear Akamai cookies so _abck restarts at -1 (no incognito needed)
    function clearAkamai() {
        var names = ['_abck', 'bm_sz', 'ak_bmsc', 'bm_sv', 'bm_so', 'bm_mi'];
        var domains = ['', '.zalando.com', 'accounts.zalando.com', '.zalando.pl', 'www.zalando.pl'];
        names.forEach(function (n) { domains.forEach(function (d) { document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + (d ? '; domain=' + d : ''); }); });
    }
    window.__reset = clearAkamai;
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
        if (mode === 'passthrough') { /* unchanged: tests our cipher+transport */ }
        else if (mode === 'corrupt:section0') { d.section0 = flip1(d.section0); }
        else if (mode === 'corrupt:meta') { d.meta = d.meta.replace(/^\d+/, function (m) { return (+m + 1); }); }
        else if (mode === 'corrupt:plain') { d.plain = flip1(d.plain); }
        else if (mode.indexOf('mutate:') === 0) {
            mode.slice(7).split(',').forEach(function (p) { var e = p.indexOf('='); if (e < 0) return; var k = p.slice(0, e), v = p.slice(e + 1); d.plain = d.plain.replace(new RegExp('("' + k + '":)("[^"]*"|[^,}]*)'), '$1' + JSON.stringify(v)); });
        }
        else if (mode === 'regen') {
            // realistic capture-assisted generation: keep the REAL section0/meta/seed,
            // refresh the ms-epoch timestamp(s) to now, re-encode. We target by VALUE
            // (a 13-digit 1[78]......... epoch) NOT by the `sc:` label — the transposed
            // plaintext de-correlates labels from values. If _abck still validates, we
            // can generate fresh bodies from a capture (not just byte-identical replay).
            var now = String(Date.now()), nrep = 0;
            d.plain = d.plain.replace(/\d+/g, function (run) {
                if (run.length === 13 && run[0] === '1' && (run[1] === '7' || run[1] === '8')) { nrep++; return now; }
                return run;
            });
            console.log('[regen] refreshed ' + nrep + ' timestamp(s)' + (nrep === 0 ? ' — WARNING: no-op (= passthrough)' : ''));
        }
        return encodeV3(d);
    }

    function onSensor(url, body, stack) {
        window.__cap.posts.push({ url: url, body: body, stack: stack, t: Date.now(), cookie: document.cookie });
        console.log('[sensor POST #' + window.__cap.posts.length + ']', url, '\n', stack);
        captureScript(url);
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
    var euc = window.encodeURIComponent;
    var _hseen = Object.create(null), _hn = 0;
    window.encodeURIComponent = function (s) {
        try {
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

    console.log('[gofast-capture] mode=' + window.__MODE + '. Browse, watch [abck] status. __status() / __abck() / __save() / __decoded(0).');
})();
