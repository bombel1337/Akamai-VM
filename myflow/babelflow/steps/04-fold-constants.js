/*
 * Step 04 — fold constant expressions.
 * Collapses arithmetic/boolean obfuscation, now including what step 03 re-exposed
 * by unwrapping operator helpers:
 *   +!+[]                    -> 1
 *   !+[] + !+[] + !+[]       -> 3
 *   [+!+[]] + [+[]] - []     -> 10
 *   !([])                    -> false      (from Mp([]) after step 03)
 *   '0x' + 'eefb964'         -> '0xeefb964'
 *
 * Detects *pure constant* subtrees (only array literals, number/string/boolean
 * literals, unary + - ! ~ void typeof, and binary/arithmetic operators — NO
 * identifiers, calls, or member access) and evaluates them directly. Purity
 * guarantees no side effects, so the fold is semantics-preserving.
 *
 * Input: out/03-inlined.js   Output: out/04-folded.js
 */
const fs = require('fs');
const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { parse, gen, ensureOut, outPath, rel } = require('../lib');

const SAFE_UNARY = new Set(['+', '-', '!', '~', 'void', 'typeof']);
const SAFE_BINARY = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>',
    '==', '===', '!=', '!==', '<', '<=', '>', '>=']);

function isPure(node) {
    if (!node) return false;
    switch (node.type) {
        case 'NumericLiteral':
        case 'StringLiteral':
        case 'BooleanLiteral':
            return true;
        case 'ArrayExpression':
            return node.elements.every((e) => e === null || isPure(e));
        case 'UnaryExpression':
            return SAFE_UNARY.has(node.operator) && isPure(node.argument);
        case 'BinaryExpression':
            return SAFE_BINARY.has(node.operator) && isPure(node.left) && isPure(node.right);
        case 'ParenthesizedExpression':
            return isPure(node.expression);
        default:
            return false;
    }
}

function main() {
    ensureOut();
    const input = outPath('03-inlined.js');
    const out = outPath('04-folded.js');
    const ast = parse(fs.readFileSync(input, 'utf8'));
    let n = 0;
    traverse(ast, {
        'ArrayExpression|UnaryExpression|BinaryExpression'(p) {
            if (!isPure(p.node)) return;
            if (p.parentPath && isPure(p.parentPath.node)) return; // fold maximal subtree
            let val;
            try {
                val = new Function('return (' + gen(p.node) + ');')();
            } catch (e) {
                return;
            }
            let node;
            if (typeof val === 'number') {
                if (!Number.isFinite(val)) return;
                node = t.valueToNode(val);
            } else if (typeof val === 'string') {
                if (val.length > 200) return;
                node = t.stringLiteral(val);
            } else if (typeof val === 'boolean') {
                node = t.booleanLiteral(val);
            } else {
                return;
            }
            p.replaceWith(node);
            p.skip();
            n++;
        },
    });
    const code = gen(ast);
    fs.writeFileSync(out, code);
    return { step: '04 fold-constants', folded: n, output: rel(out), lines: code.split('\n').length };
}

module.exports = { main };
if (require.main === module) console.log(main());
