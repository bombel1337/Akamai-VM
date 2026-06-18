/*
 * babelflow/run.js — run the full staged Babel deobfuscation pipeline.
 *
 * Steps (each also runnable on its own: `node steps/0N-*.js`):
 *   01 beautify         -> out/01-beautified.js
 *   02 decode-hex       -> out/02-decoded-hex.js
 *   03 inline-operators -> out/03-inlined.js
 *   04 fold-constants   -> out/04-folded.js
 *   05 simplify-members -> out/05-simplified.js
 * Final: copy of step 05 -> script.final.js
 */
const fs = require('fs');
const path = require('path');
const { ROOT, outPath } = require('./lib');

const STEPS = ['01-beautify', '02-decode-hex', '03-inline-operators', '04-fold-constants', '05-simplify-members'];

console.log('babelflow — staged deobfuscation\n');
for (const s of STEPS) {
    const t0 = Date.now();
    const r = require('./steps/' + s).main();
    const ms = Date.now() - t0;
    const detail = Object.entries(r)
        .filter(([k]) => k !== 'step')
        .map(([k, v]) => `${k}=${v}`)
        .join('  ');
    console.log(`  ✓ ${r.step.padEnd(20)} ${detail}  (${ms}ms)`);
}

const finalSrc = fs.readFileSync(outPath('05-simplified.js'), 'utf8');
const finalPath = path.join(ROOT, 'script.final.js');
fs.writeFileSync(finalPath, finalSrc);
console.log(`\nfinal → script.final.js (${finalSrc.split('\n').length} lines)`);
