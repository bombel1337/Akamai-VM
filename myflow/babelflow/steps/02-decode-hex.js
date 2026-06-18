/*
 * Step 02 — decode \xNN hex string escapes.
 * Strip `extra` from every StringLiteral so the generator re-emits from `.value`
 * ("\x6c\x65..." -> "length"). Numbers and regex literals are left untouched.
 *
 * Input: out/01-beautified.js   Output: out/02-decoded-hex.js
 */
const fs = require('fs');
const traverse = require('@babel/traverse').default;
const { parse, gen, ensureOut, outPath, rel } = require('../lib');

function main() {
    ensureOut();
    const input = outPath('01-beautified.js');
    const out = outPath('02-decoded-hex.js');
    const ast = parse(fs.readFileSync(input, 'utf8'));
    let n = 0;
    traverse(ast, {
        StringLiteral(p) {
            if (p.node.extra) { delete p.node.extra; n++; }
        },
    });
    const code = gen(ast);
    fs.writeFileSync(out, code);
    return { step: '02 decode-hex', decoded: n, output: rel(out), lines: code.split('\n').length };
}

module.exports = { main };
if (require.main === module) console.log(main());
