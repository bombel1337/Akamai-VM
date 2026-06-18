/*
 * generator/generate.js — Generate(SensorInput) -> v3 sensor_data, from scratch.
 *
 * Architecture (see FINDINGS.md): the 8 SensorInput fields do NOT contain the
 * device fingerprint, so we use a fixed DEVICE PROFILE captured once (template.json,
 * decoded from a real first-POST sensor) and substitute in the input-derived +
 * dynamic fields, then encrypt with the recovered cipher (cipher.js).
 *
 *   sensor_data = "3;0;1;0;<bmszSeed>;" + encodeV3(section0, meta, encryptSub(plain, seed))
 *
 * Input mapping (recovered): Bmsz->cipher seed, UserAgent->adp/version,
 * PageUrl->url field, ScriptUrl->path token, AcceptLanguage->lang; timestamps
 * are refreshed each call. Abck/IP are not part of the sensor body.
 *
 * Usage:
 *   node generate.js '{"ScriptUrl":"...","PageUrl":"...","UserAgent":"...","Bmsz":"36F5..~3158840~..","AcceptLanguage":"en-US","Abck":"...","IP":"..."}'
 *   node generate.js --selftest      # regenerate the template's own inputs == original
 */
const fs = require('fs');
const path = require('path');
const C = require('./cipher');

const TEMPLATE = JSON.parse(fs.readFileSync(path.join(__dirname, 'template.json'), 'utf8'));

// bm_sz seed = the first numeric `~`-token, e.g. "<hex>~3158840~4605490" -> 3158840.
// (NOT a regex over the whole string: the leading hex contains digit runs.)
function bmszSeed(bmsz) {
    const parts = String(bmsz).split('~');
    const tok = parts.slice(1).find(p => /^\d+$/.test(p)) || (/^\d+$/.test(parts[0]) ? parts[0] : null);
    if (!tok) throw new Error('cannot extract bm_sz seed token from: ' + bmsz);
    return parseInt(tok, 10);
}

// the script-path token used in the sensor (a path segment of ScriptUrl). We map
// by matching the template token's position among ScriptUrl path segments.
function scriptToken(scriptUrl, tmplToken) {
    try {
        const segs = new URL(scriptUrl).pathname.split('/').filter(Boolean);
        // template token length ~18 alnum; pick the segment most similar in shape
        const cand = segs.find(s => s.length >= 12 && /^[A-Za-z0-9_-]+$/.test(s));
        return cand || tmplToken;
    } catch (_) { return tmplToken; }
}

function pageHost(pageUrl) {
    // template stores host+path without scheme (matches how it appears in plain)
    return String(pageUrl).replace(/^https?:\/\//, '');
}

// primary locale from an Accept-Language header: "en-US,en;q=0.9" -> "en-US"
function primaryLocale(acceptLanguage) {
    const m = /^\s*([A-Za-z]{2}(?:-[A-Za-z]{2,})?)/.exec(String(acceptLanguage));
    return m ? m[1] : null;
}

function generate(input, opts = {}) {
    const now = opts.now || Date.now();
    let plain = TEMPLATE.plain;
    const o = TEMPLATE.origInputs;

    // 1) input-derived substitutions (verbatim string replace)
    if (input.UserAgent) plain = plain.split(o.UserAgent).join(input.UserAgent);
    if (input.PageUrl) plain = plain.split(o.PageUrlHost).join(pageHost(input.PageUrl));
    if (input.ScriptUrl) plain = plain.split(o.ScriptToken).join(scriptToken(input.ScriptUrl, o.ScriptToken));
    if (input.AcceptLanguage && o.Locale) {
        const loc = primaryLocale(input.AcceptLanguage);
        if (loc) plain = plain.split(o.Locale).join(loc);
    }

    // 2) refresh dynamic timestamps. Only `sc` is a confirmed ms-epoch field;
    // other time/counter fields (dau, tid, ...) have unknown derivations, so we
    // leave them at the template values for now (refine as they're decoded).
    plain = plain.replace(/sc:(\d{13})/g, 'sc:' + now);

    // 3) seed from Bmsz, assemble + encrypt
    const seed = bmszSeed(input.Bmsz);
    const body = C.encodeV3({ section0: TEMPLATE.section0, meta: TEMPLATE.meta, seed, plain });
    return TEMPLATE.prefixFixed + seed + ';' + body;
}

function selftest() {
    // regenerate with the template's own inputs + frozen timestamp -> must equal
    // the exact body we captured (proves substitution + cipher are faithful).
    const o = TEMPLATE.origInputs;
    const frozen = parseInt(/sc:(\d{13})/.exec(TEMPLATE.plain)[1], 10);
    const sd = generate({
        UserAgent: o.UserAgent, PageUrl: 'https://' + o.PageUrlHost,
        ScriptUrl: 'https://www.zalando.pl/x/y/' + o.ScriptToken + '/z',
        Bmsz: 'X~' + TEMPLATE.seedExample + '~Y',
    }, { now: frozen });
    const expectBody = C.encodeV3({ section0: TEMPLATE.section0, meta: TEMPLATE.meta, seed: TEMPLATE.seedExample, plain: TEMPLATE.plain });
    const expect = TEMPLATE.prefixFixed + TEMPLATE.seedExample + ';' + expectBody;
    const ok = sd === expect;
    console.log('selftest (regenerate template inputs == original):', ok ? 'PASS' : 'FAIL');
    if (!ok) {
        for (let i = 0; i < Math.max(sd.length, expect.length); i++) {
            if (sd[i] !== expect[i]) { console.log('  first diff @', i, JSON.stringify(sd.slice(i - 10, i + 10)), 'vs', JSON.stringify(expect.slice(i - 10, i + 10))); break; }
        }
    }
    // round-trip decode sanity
    const dec = C.decodeV3(sd);
    console.log('round-trip decode ok:', dec.ok && dec.plain.includes('"adp"'));
    process.exit(ok ? 0 : 1);
}

// Resolve the SensorInput JSON from: --file <path> | a path arg | '-' (stdin) |
// an inline JSON string. File/stdin avoid PowerShell quoting headaches.
function readInputArg() {
    const args = process.argv.slice(2).filter(a => a !== '--selftest');
    const fi = args.indexOf('--file');
    if (fi !== -1 && args[fi + 1]) return fs.readFileSync(args[fi + 1], 'utf8');
    const a = args[0];
    if (!a) return null;
    if (a === '-') return fs.readFileSync(0, 'utf8');           // stdin
    if (!a.trim().startsWith('{') && fs.existsSync(a)) return fs.readFileSync(a, 'utf8');
    return a;                                                   // inline JSON
}

if (require.main === module) {
    if (process.argv.includes('--selftest')) { selftest(); }
    else {
        const raw = readInputArg();
        if (!raw) {
            console.error([
                'usage:',
                '  node generate.js --file input.json     # easiest on PowerShell',
                '  Get-Content input.json | node generate.js -',
                "  node generate.js '<inline SensorInput JSON>'",
                '  node generate.js --selftest',
                '',
                'input.json keys: ScriptUrl, PageUrl, UserAgent, Bmsz, AcceptLanguage, Abck, IP, Version',
            ].join('\n'));
            process.exit(1);
        }
        let input;
        try { input = JSON.parse(raw); }
        catch (e) { console.error('input is not valid JSON:', e.message); process.exit(1); }
        if (!input.Bmsz) { console.error('input.Bmsz is required (its first numeric token is the cipher seed).'); process.exit(1); }
        process.stdout.write(generate(input));
    }
}

module.exports = { generate };
