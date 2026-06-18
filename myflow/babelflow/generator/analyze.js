/*
 * generator/analyze.js — decode a captured sensor_data and dump its fields.
 *
 *   node analyze.js <sensor_data.json|raw>   decode (decodeV3) + list field-objects
 *   node analyze.js --selftest               cipher round-trip sanity check
 *
 * Useful for inspecting real captures (the plaintext field set) when refining
 * the generator's device profile / dynamic fields.
 */
const fs = require('fs');
const C = require('./cipher');

function selftest() {
    const samples = ['{"a":"hello world"},{"b":1366}', 'just,some,text', 'A"B"C', ''];
    let pass = 0;
    for (const s of samples) {
        const seed = (Math.random() * C.LCG.mask) | 0;
        const dec = C.decryptSub(C.encryptSub(s, seed), seed);
        const ok = dec === s;
        pass += ok ? 1 : 0;
        console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${JSON.stringify(s)}`);
    }
    console.log(`selftest: ${pass}/${samples.length} substitution round-trips ok`);
    process.exit(pass === samples.length ? 0 : 1);
}

function extractSensorData(raw) {
    raw = raw.trim();
    try { const o = JSON.parse(raw); if (o && o.sensor_data) return o.sensor_data; } catch (_) {}
    return raw;
}

function analyze(path) {
    const sd = extractSensorData(fs.readFileSync(path, 'utf8'));
    const r = C.decodeV3(sd);
    if (!r.ok) { console.log('decode failed:', r.reason); return; }
    console.log(`seed (prefix field ${C.SEED_FIELD}): ${r.seed}`);
    console.log(`section0: ${r.section0}`);
    console.log(`meta: ${r.meta}`);
    // plaintext is a list of {"field":value} objects joined by ':'
    const fields = r.plain.split(/\},?\{/).map(s => s.replace(/^[{,]+|[}]+$/g, ''));
    console.log(`decoded ${fields.length} field-objects:`);
    fields.slice(0, 60).forEach((f, i) => console.log(`  [${i}] ${f.slice(0, 100)}`));
}

const arg = process.argv[2];
if (!arg) { console.log('usage: node analyze.js <sample> | --selftest'); process.exit(1); }
if (arg === '--selftest') selftest();
else analyze(arg);
