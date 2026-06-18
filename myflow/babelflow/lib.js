/*
 * babelflow/lib.js — shared helpers for the staged Babel deobfuscation pipeline.
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');

// Find the input Akamai script. It lives either under `script/` or under the
// auto-generated `script-<rand>/...` served path (the URL it was fetched from).
// Walk babelflow/, skipping the pipeline's own files/dirs, and return the .js.
const SKIP_DIRS = new Set(['out', 'steps', 'node_modules', '.git']);
const SKIP_FILES = new Set(['lib.js', 'run.js']);

function findScript() {
    const stack = [ROOT];
    while (stack.length) {
        const d = stack.pop();
        for (const name of fs.readdirSync(d)) {
            const p = path.join(d, name);
            if (fs.statSync(p).isDirectory()) {
                if (d === ROOT && SKIP_DIRS.has(name)) continue;
                stack.push(p);
            } else if (name.endsWith('.js') &&
                !(d === ROOT && (SKIP_FILES.has(name) || name.endsWith('.final.js')))) {
                return p;
            }
        }
    }
    throw new Error('no input .js found under babelflow/ (place it under babelflow/script/)');
}

const PARSE_OPTS = { sourceType: 'script', errorRecovery: true };
const parse = (src) => parser.parse(src, PARSE_OPTS);

const gen = (ast, extra) =>
    generate(ast, Object.assign(
        { compact: false, comments: true, jsescOption: { quotes: 'single' } },
        extra
    )).code;

function ensureOut() {
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
}

const outPath = (name) => path.join(OUT, name);
const rel = (p) => path.relative(ROOT, p);

module.exports = { ROOT, OUT, findScript, parse, gen, ensureOut, outPath, rel };
