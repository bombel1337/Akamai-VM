/*
 * generator/cipher.js — the v3 sensor_data cipher (recovered, verified bit-exact;
 * see FINDINGS.md) and the decode/encode helpers used by the generator.
 *
 * Scheme: a single substitution over a 92-char alphabet, keyed by an LCG
 * keystream  key = (key*65793 + 4282663) & 0x7FFFFF ;  rZ = (key>>8) & 0xFFFF ;
 * out_idx = (in_idx ± rZ%92). The keystream advances on EVERY char; chars not in
 * the alphabet (" ') pass through unchanged (so JSON structure survives). No
 * shuffle layer. Seed = the first numeric token of bm_sz (prefix field 4).
 */

const ALPHABET = " !#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~";
const N = ALPHABET.length;

const CHAR_INDEX = (() => {
    const t = new Int16Array(256).fill(-1);
    for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
    return t;
})();

// LCG constants — update these in Phase A if a fresh sample doesn't decode.
const LCG = { mul: 65793, add: 4282663, mask: 8388607 };
const advance = (k) => ((k * LCG.mul) + LCG.add) & LCG.mask;

// v3 payload cipher (recovered dynamically, 1384/1384 keystream match):
// substitution over ALPHABET, keystream advances EVERY char, and chars NOT in
// the alphabet (e.g. " ') PASS THROUGH unchanged (the JSON structure survives).
function decryptSub(data, key) {
    let out = '';
    for (let i = 0; i < data.length; i++) {
        const rZ = (key >> 8) & 65535;
        key = advance(key);
        const c = data.charCodeAt(i);
        const idx = c < 256 ? CHAR_INDEX[c] : -1;
        if (idx === -1) { out += data[i]; continue; } // not in alphabet -> pass through
        out += ALPHABET[((idx - (rZ % N)) % N + N) % N];
    }
    return out;
}

function encryptSub(data, key) {
    let out = '';
    for (let i = 0; i < data.length; i++) {
        const rZ = (key >> 8) & 65535;
        key = advance(key);
        const c = data.charCodeAt(i);
        const idx = c < 256 ? CHAR_INDEX[c] : -1;
        if (idx === -1) { out += data[i]; continue; }
        out += ALPHABET[(idx + (rZ % N)) % N];
    }
    return out;
}

// prefix: <ver>;<a>;<b>;<c>;<seed>;  — fields are 0-indexed once split on ';'.
// Recovered: field[4] (the 5th, a bm_sz token) is the substitution-cipher SEED.
// fields a/b/c (e.g. 0/1/0) are NOT cipher keys in this version, and there is NO
// shuffle layer (substitution alone reproduces the payload, 1384/1384).
const PREFIX_RE = /(\d+(;\d+)?;(\d+);(\d+);[\d,]+;)/;
const SEED_FIELD = 4;

// v3 body = <prefix> <section0> ; <metaCsv> ; <encrypted payload (substitution)>
// decodeV3 -> { section0, meta, seed, plain } where plain is readable JSON.
function decodeV3(sensorData) {
    const m = PREFIX_RE.exec(sensorData);
    if (!m) return { ok: false, reason: 'prefix not matched' };
    const fields = m[0].split(';');
    const seed = parseInt(fields[SEED_FIELD], 10);
    const sec = sensorData.slice(m[0].length).split(';');
    const payload = sec.slice(2).join(';');
    const plain = decryptSub(payload, seed);
    return { ok: true, prefix: m[0], section0: sec[0], meta: sec[1], seed, plain };
}

// encodeV3 -> the body string (without prefix): section0;meta;encrypt(plain,seed)
function encodeV3({ section0, meta, seed, plain }) {
    return [section0, meta, encryptSub(plain, seed)].join(';');
}

module.exports = {
    ALPHABET, N, CHAR_INDEX, LCG, advance, PREFIX_RE, SEED_FIELD,
    decryptSub, encryptSub, decodeV3, encodeV3,
};
