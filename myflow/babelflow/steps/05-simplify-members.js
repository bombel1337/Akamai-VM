/*
 * Step 05 — simplify member access.
 * Turn computed string-key access into dot notation when the key is a valid
 * identifier:  OY['window']['XMLHttpRequest'] -> OY.window.XMLHttpRequest.
 * Leaves decoder-driven computed keys (BASE()[IDX(k)]) and numeric keys alone.
 *
 * Input: out/04-folded.js   Output: out/05-simplified.js
 */
const fs = require('fs');
const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { parse, gen, ensureOut, outPath, rel } = require('../lib');

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function main() {
    ensureOut();
    const input = outPath('04-folded.js');
    const out = outPath('05-simplified.js');
    const ast = parse(fs.readFileSync(input, 'utf8'));
    let n = 0;
    traverse(ast, {
        MemberExpression(p) {
            const prop = p.node.property;
            if (p.node.computed && t.isStringLiteral(prop) && IDENT.test(prop.value)) {
                p.node.property = t.identifier(prop.value);
                p.node.computed = false;
                n++;
            }
        },
    });
    const code = gen(ast);
    fs.writeFileSync(out, code);
    return { step: '05 simplify-members', simplified: n, output: rel(out), lines: code.split('\n').length };
}

module.exports = { main };
if (require.main === module) console.log(main());
