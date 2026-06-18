/*
 * generator/capture.js — authentic-context dynamic capture (Phase A).
 *
 * Idea (see FINDINGS.md): the payload cipher + section[0] are wired through the
 * runtime string decoder, so we observe them by letting the REAL Akamai script
 * run on the live page and hooking GLOBAL functions it routes through — never
 * editing script.js, so its self-hash stays valid.
 *
 * Hooks installed before any page script (evaluateOnNewDocument):
 *   - encodeURIComponent : SHA-256 input passes through it (bG -> bLx ->
 *     unescape(encodeURIComponent)). At runtime this yields the *decoded*
 *     plaintext grid (real "-1,2,-94,-NNN," markers). Recorded to window.__caps.
 *   - XHR open/send + fetch : capture the outgoing {"sensor_data":...} POST and
 *     snapshot the caps + cookies at that instant.
 * Native-looking toString is preserved so trivial integrity checks pass.
 *
 * Usage:
 *   node capture.js                 # uses pageurl from script/data.txt, headful
 *   node capture.js --headless
 *   node capture.js --url <pageUrl>
 * Output: generator/capture-out.json  (sensor_data + encodeURIComponent inputs)
 *
 * Scope: run only against sites you are authorized to test.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

function readPageUrl() {
    const i = process.argv.indexOf('--url');
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    const dt = path.join(__dirname, '..', 'script', 'data.txt');
    const txt = fs.readFileSync(dt, 'utf8');
    const m = /pageurl\s*\n\s*(https?:\/\/\S+)/i.exec(txt);
    if (!m) throw new Error('pageurl not found in script/data.txt (or pass --url)');
    return m[1].trim();
}

// Runs in the page before any site script. Keep it self-contained (no closures
// over Node scope) — it is serialized and injected.
function installHooks() {
    window.__caps = [];          // every encodeURIComponent input (capped)
    window.__joins = [];         // Array.join results (assembled plaintext candidates)
    window.__captures = [];      // each outgoing sensor_data POST + snapshot
    const MAXCAPS = 4000;

    // Array.prototype.join — the field-assembly + body-assembly happen here. Record
    // long results (the assembled plaintext is what the stream cipher consumes).
    const nativeJoin = Array.prototype.join;
    Array.prototype.join = function (sep) {
        const r = nativeJoin.apply(this, arguments);
        try {
            if (typeof r === 'string' && r.length > 40 && window.__joins.length < MAXCAPS) {
                window.__joins.push({ sep: sep === undefined ? ',' : String(sep), len: r.length, val: r });
            }
        } catch (e) {}
        return r;
    };
    try { Array.prototype.join.toString = () => 'function join() { [native code] }'; } catch (e) {}

    const nativeEUC = window.encodeURIComponent;
    function hookedEUC(s) {
        try {
            if (typeof s === 'string' && s.length > 8 && window.__caps.length < MAXCAPS) {
                window.__caps.push(s);
            }
        } catch (e) {}
        return nativeEUC.apply(this, arguments);
    }
    try { hookedEUC.toString = () => 'function encodeURIComponent() { [native code] }'; } catch (e) {}
    window.encodeURIComponent = hookedEUC;

    function snapshot(url, body) {
        window.__captures.push({
            url: String(url || ''),
            body: String(body || ''),
            cookie: document.cookie,
            capsLen: window.__caps.length,
            caps: window.__caps.slice(),   // hashed field values
            joins: window.__joins.slice(), // assembled-plaintext candidates
            t: Date.now(),
        });
    }
    function looksLikeSensor(body) {
        return typeof body === 'string' && body.indexOf('sensor_data') !== -1;
    }

    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
        try { if (looksLikeSensor(b)) snapshot(this.__u, b); } catch (e) {}
        return XS.apply(this, arguments);
    };
    const F = window.fetch;
    if (F) {
        window.fetch = function (input, init) {
            try {
                const b = init && init.body;
                if (looksLikeSensor(b)) snapshot(typeof input === 'string' ? input : (input && input.url), b);
            } catch (e) {}
            return F.apply(this, arguments);
        };
    }
}

async function main() {
    const pageUrl = readPageUrl();
    const headless = process.argv.includes('--headless');
    console.log('capture: navigating to', pageUrl, headless ? '(headless)' : '(headful)');

    const browser = await puppeteer.launch({
        headless,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        defaultViewport: { width: 1366, height: 768 },
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(installHooks);

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto:', e.message));

    // Nudge the behavioral collectors so the script generates sensor_data.
    for (let i = 0; i < 12; i++) {
        await page.mouse.move(200 + i * 40, 150 + (i % 5) * 30).catch(() => {});
        await new Promise(r => setTimeout(r, 250));
    }
    await new Promise(r => setTimeout(r, 4000));

    const out = await page.evaluate(() => ({
        captures: window.__captures || [],
        capsTotal: (window.__caps || []).length,
    }));

    const dst = path.join(__dirname, 'capture-out.json');
    fs.writeFileSync(dst, JSON.stringify(out, null, 2));
    console.log(`captured ${out.captures.length} sensor POST(s); ${out.capsTotal} encodeURIComponent inputs.`);
    console.log('written ->', dst);
    if (!headless) { console.log('leaving browser open 20s for manual interaction...'); await new Promise(r => setTimeout(r, 20000)); }
    await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
