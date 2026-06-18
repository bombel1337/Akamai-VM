/*
 * Step 03 — inline operator-alias helpers.
 * The script hides every JS operator behind a tiny pure helper, called thousands
 * of times:  Mp = a => !a,  HE = (a,b) => a + b,  BI = (a,b) => a - b,
 * SI = (a,b) => a > b,  M0 = a => ~a,  Qx = (a,b) => a ^ b,  ...
 * We detect those helpers and rewrite their call sites back to real operators:
 *   Mp(x)      -> !(x)
 *   BI(x, y)   -> (x) - (y)
 * This is semantics-preserving (helpers are pure, args evaluated once, same
 * order) and re-exposes constant subtrees for the fold step that follows.
 *
 * Scope-aware: a call is only rewritten if its callee Identifier *resolves* (via
 * Babel scope bindings) to the detected helper's own declaration — so shadowed
 * names (e.g. an unrelated nested `function Mp(){...}`) are left untouched.
 *
 * Input: out/02-decoded-hex.js   Output: out/03-inlined.js
 */
const fs = require('fs');
const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { parse, gen, ensureOut, outPath, rel } = require('../lib');

const UNARY = new Set(['!', '~', '-', '+']);
const BINARY = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>',
    '==', '===', '!=', '!==', '<', '<=', '>', '>=', '&&', '||', 'in', 'instanceof']);

// Inspect a function node; return { arity, operator, kind, order } if it is a
// trivial operator alias, else null. `order` maps call-arg index -> operand slot.
function classify(fn) {
    if (!fn || !fn.params.every((p) => t.isIdentifier(p))) return null;
    const body = fn.body;
    if (!t.isBlockStatement(body) || body.body.length !== 1) return null;
    const ret = body.body[0];
    if (!t.isReturnStatement(ret) || !ret.argument) return null;
    const names = fn.params.map((p) => p.name);
    const arg = ret.argument;

    // identity: function (a) { return a; }
    if (fn.params.length === 1 && t.isIdentifier(arg) && arg.name === names[0]) {
        return { arity: 1, kind: 'identity' };
    }
    // unary: function (a) { return OP a; }
    if (fn.params.length === 1 && t.isUnaryExpression(arg) && arg.prefix &&
        UNARY.has(arg.operator) && t.isIdentifier(arg.argument) && arg.argument.name === names[0]) {
        return { arity: 1, kind: 'unary', operator: arg.operator };
    }
    // binary/logical: function (a, b) { return a OP b; }  (operands are the params, any order)
    if (fn.params.length === 2 && (t.isBinaryExpression(arg) || t.isLogicalExpression(arg)) &&
        BINARY.has(arg.operator) && t.isIdentifier(arg.left) && t.isIdentifier(arg.right)) {
        const li = names.indexOf(arg.left.name);
        const ri = names.indexOf(arg.right.name);
        if (li !== -1 && ri !== -1 && li !== ri) {
            return { arity: 2, kind: 'binary', operator: arg.operator, left: li, right: ri };
        }
    }
    return null;
}

function main() {
    ensureOut();
    const input = outPath('02-decoded-hex.js');
    const out = outPath('03-inlined.js');
    const ast = parse(fs.readFileSync(input, 'utf8'));

    // Pass 1: find helper declarations and remember the exact node that declares them.
    // helpers: Map<declNode, info>  (keyed by the function node for identity checks)
    const helperByDecl = new Map(); // VariableDeclarator | FunctionDeclaration node -> info
    traverse(ast, {
        VariableDeclarator(p) {
            if (t.isFunctionExpression(p.node.init) || t.isArrowFunctionExpression(p.node.init)) {
                const info = classify(p.node.init);
                if (info && t.isIdentifier(p.node.id)) helperByDecl.set(p.node, info);
            }
        },
        FunctionDeclaration(p) {
            const info = classify(p.node);
            if (info && p.node.id) helperByDecl.set(p.node, info);
        },
    });

    let detected = helperByDecl.size;
    let inlined = 0;

    // Pass 2: rewrite calls whose callee binding resolves to a detected helper.
    traverse(ast, {
        CallExpression(p) {
            const callee = p.node.callee;
            if (!t.isIdentifier(callee)) return;
            const binding = p.scope.getBinding(callee.name);
            if (!binding) return;
            // The binding path points at the VariableDeclarator or FunctionDeclaration.
            const info = helperByDecl.get(binding.path.node);
            if (!info) return;

            const args = p.node.arguments;
            if (args.length !== info.arity) return;
            if (args.some((a) => t.isSpreadElement(a))) return;

            let repl;
            if (info.kind === 'identity') {
                repl = args[0];
            } else if (info.kind === 'unary') {
                repl = t.unaryExpression(info.operator, args[0], true);
            } else {
                const op = info.operator;
                const left = args[info.left];
                const right = args[info.right];
                repl = (op === '&&' || op === '||')
                    ? t.logicalExpression(op, left, right)
                    : t.binaryExpression(op, left, right);
            }
            p.replaceWith(repl);
            inlined++;
        },
    });

    const code = gen(ast);
    fs.writeFileSync(out, code);
    return { step: '03 inline-operators', helpers: detected, inlined, output: rel(out), lines: code.split('\n').length };
}

module.exports = { main };
if (require.main === module) console.log(main());
