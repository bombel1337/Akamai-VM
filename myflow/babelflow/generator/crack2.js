/* crack2.js — recover the payload keystream from capture #0 (plain↔cipher 1:1). */
const fs = require('fs');
const C = require('./cipher');

const { captures } = JSON.parse(fs.readFileSync(__dirname + '/capture-out.json', 'utf8'));
const cap = captures[0];
const sd = JSON.parse(cap.body).sensor_data;
const m = /(\d+(;\d+)?;(\d+);(\d+);[\d,]+;)/.exec(sd);
const sec = sd.slice(m[0].length).split(';');
const cipher = sec.slice(2).join(';');
// the assembled plaintext: the join whose length equals the payload length
const plain = (cap.joins || []).map(j => j.val).find(v => v.length === cipher.length);
if (!plain) { console.log('no length-matched join in capture #0'); process.exit(1); }

console.log('prefix:', m[0], 'len:', cipher.length);
console.log('plain :', JSON.stringify(plain.slice(0, 60)));
console.log('cipher:', JSON.stringify(cipher.slice(0, 60)));

// Pass-through check for non-alphabet chars (", ', etc.) and keystream over alphabet chars.
let passOK = 0, passBad = 0;
const ksAll = [];   // keystream index assuming it advances EVERY char
const ksAlpha = []; // keystream index assuming it advances only on alphabet chars
for (let i = 0; i < cipher.length; i++) {
    const pc = plain.charCodeAt(i), cc = cipher.charCodeAt(i);
    const pi = C.CHAR_INDEX[pc], ci = C.CHAR_INDEX[cc];
    if (pi === -1) {           // non-alphabet plaintext char
        (cc === pc ? passOK++ : passBad++);
        ksAll.push(null);
        continue;
    }
    const k = ((ci - pi) % C.N + C.N) % C.N;
    ksAll.push(k);
    ksAlpha.push(k);
}
console.log(`non-alphabet chars: pass-through ok=${passOK} bad=${passBad}`);
console.log('keystream(idx, advance-every-char) [0..40]:', ksAll.slice(0, 40).map(x => x === null ? '.' : x).join(','));
console.log('keystream(idx, advance-on-alphabet)[0..40]:', ksAlpha.slice(0, 40).join(','));

// Try to match against the known LCG with candidate seeds.
function lcgKeystream(seed, len, mask = C.LCG.mask) {
    let key = seed >>> 0, out = [];
    for (let i = 0; i < len; i++) { const rZ = (key >> 8) & 65535; key = ((key * C.LCG.mul) + C.LCG.add) & mask; out.push(rZ % C.N); }
    return out;
}
const k1 = parseInt(m[3], 10), k2 = parseInt(m[4], 10), seed5 = parseInt(/;(\d+);$/.exec(m[0]) ? m[0].split(';')[4] : '0', 10);
const seeds = [k1, k2, seed5, parseInt(m[0].split(';')[4], 10)];
for (const model of [{ name: 'every', ks: ksAll.map(x => x ?? -1) }, { name: 'alpha', ks: ksAlpha }]) {
    for (const s of new Set(seeds)) {
        const gen = lcgKeystream(s, model.ks.length);
        let match = 0, comp = 0;
        for (let i = 0; i < model.ks.length; i++) { if (model.ks[i] === -1) continue; comp++; if (gen[i] === model.ks[i]) match++; }
        if (comp && match / comp > 0.5) console.log(`LCG seed=${s} model=${model.name}: ${match}/${comp} match`);
    }
}
console.log('\nIf no LCG match: the keystream array above is the truth — paste it and I fit the recurrence.');
