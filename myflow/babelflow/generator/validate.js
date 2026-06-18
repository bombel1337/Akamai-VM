/*
 * generator/validate.js — real _abck oracle for our sensor_data, self-contained.
 *
 * Opens the live page in a real browser (real Chrome TLS + cookies), intercepts
 * the script's outgoing {"sensor_data":...} POST, and depending on MODE either
 * lets it through, re-encodes it, mutates it, or replaces it with generate()'d
 * output. Then reports every _abck cookie's 2nd "~"-segment:
 *   -1  -> not validated (rejected / not yet)
 *    0+ -> accepted (valid once requestCount >= that number)
 *
 * Modes (pick one):
 *   (default)        SWAP    — replace body with generate(input from live cookies)
 *   --observe        OBSERVE — let the real script run (baseline)
 *   --passthrough    decode the real body -> re-encode UNCHANGED -> swap.
 *                    Proves our cipher+seed+transport reproduce a real sensor
 *                    in-flow (expect same _abck as observe).
 *   --mutate k=v,... decode real -> set field "k" to v -> re-encode -> swap.
 *                    Isolates which fields carry an integrity dependency.
 *
 * Other flags: --url <pageUrl>  --headless  --n <ticks>
 * Scope: only run against sites you are authorized to test.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { generate } = require('./generate');
const C = require('./cipher');

function arg(name, def) { const i = process.argv.indexOf(name); return i !== -1 ? (process.argv[i + 1] ?? true) : def; }
function readPageUrl() {
    if (arg('--url')) return arg('--url');
    const inp = JSON.parse(fs.readFileSync(path.join(__dirname, 'input.json'), 'utf8'));
    if (inp.PageUrl) return inp.PageUrl;
    throw new Error('no PageUrl in input.json (or pass --url)');
}
const getCookie = (cookies, name) => (cookies.find(c => c.name === name) || {}).value;
const sensorOf = (body) => { try { return JSON.parse(body).sensor_data; } catch { return null; } };

// set "key":value in the decoded plaintext (rough, for mutate experiments)
function applyMutations(plain, spec) {
    for (const pair of String(spec).split(',')) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const k = pair.slice(0, eq), v = pair.slice(eq + 1);
        plain = plain.replace(new RegExp('("' + k + '":)("[^"]*"|[^,}]*)'), '$1' + JSON.stringify(v));
    }
    return plain;
}

async function main() {
    const pageUrl = readPageUrl();
    const headless = process.argv.includes('--headless');
    const N = parseInt(arg('--n', '6'), 10);
    const mutate = arg('--mutate', null);
    const mode = process.argv.includes('--observe') ? 'observe'
        : process.argv.includes('--passthrough') ? 'passthrough'
            : mutate ? 'mutate' : 'swap';

    const browser = await puppeteer.launch({
        headless,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        defaultViewport: { width: 1366, height: 768 },
    });
    const page = await browser.newPage();
    const ua = await browser.userAgent();

    let posts = 0;
    const endpoints = new Set();
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
        try {
            const body = req.method() === 'POST' ? (req.postData() || '') : '';
            const real = body.includes('sensor_data') ? sensorOf(body) : null;
            if (!real) return req.continue();
            endpoints.add(new URL(req.url()).origin);
            if (mode === 'observe') return req.continue();

            let out;
            if (mode === 'swap') {
                const cookies = await page.cookies();
                const bmsz = getCookie(cookies, 'bm_sz');
                if (!bmsz) return req.continue(); // can't seed yet
                out = generate({ ScriptUrl: req.url(), PageUrl: pageUrl, UserAgent: ua, Bmsz: bmsz, AcceptLanguage: 'en-US' });
            } else {
                // passthrough / mutate: work from the REAL decoded body
                const d = C.decodeV3(real);
                if (!d.ok) return req.continue();
                const plain = mode === 'mutate' ? applyMutations(d.plain, mutate) : d.plain;
                out = d.prefix + C.encodeV3({ section0: d.section0, meta: d.meta, seed: d.seed, plain });
                if (mode === 'passthrough' && out !== real) {
                    console.log(`  [passthrough WARNING] re-encode != original (Δ at first diff)`);
                }
            }
            posts++;
            console.log(`  [${mode} #${posts}] -> ${req.url().slice(0, 64)}  (len ${out.length})`);
            req.continue({ postData: JSON.stringify({ sensor_data: out }) });
        } catch (e) { try { req.continue(); } catch (_) {} }
    });

    console.log(`validate: mode=${mode}  ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto:', e.message));

    const client = await page.createCDPSession();
    async function abckReport() {
        const { cookies } = await client.send('Network.getAllCookies');
        const abk = cookies.filter(c => c.name === '_abck');
        return abk.length ? abk.map(c => `${c.domain}=${(c.value.split('~')[1] ?? '?')}`).join('  ') : 'none';
    }

    // richer interaction so the script actually emits sensors and meets the threshold
    for (let i = 0; i < N; i++) {
        await page.mouse.move(120 + i * 60, 100 + (i % 5) * 50, { steps: 6 }).catch(() => {});
        await page.mouse.wheel({ deltaY: 250 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        console.log(`  t+${i}: _abck = ${await abckReport()}  (posts: ${posts})`);
    }

    console.log('\nFINAL _abck =', await abckReport(), '  endpoints:', [...endpoints].join(',') || '(none)');
    console.log('  per cookie: -1 = INVALID; 0+ = accepted (valid once requestCount >= that number)');
    if (!headless) { console.log('(browser stays open 15s)'); await new Promise(r => setTimeout(r, 15000)); }
    await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
