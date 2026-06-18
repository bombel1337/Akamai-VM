/*
 * Step 01 — beautify.
 * Reflow the single minified line into readable, indented code. String literals
 * keep their original (hex-escaped) form here; decoding them is step 02.
 *
 * Input : the served script (auto-located).   Output: out/01-beautified.js
 */
const fs = require('fs');
const { findScript, parse, gen, ensureOut, outPath, rel } = require('../lib');

function main() {
    ensureOut();
    const input = findScript();
    const out = outPath('01-beautified.js');
    const ast = parse(fs.readFileSync(input, 'utf8'));
    const code = gen(ast); // generator reflows; string `extra.raw` keeps hex escapes
    fs.writeFileSync(out, code);
    return { step: '01 beautify', input: rel(input), output: rel(out), lines: code.split('\n').length };
}

module.exports = { main };
if (require.main === module) console.log(main());
