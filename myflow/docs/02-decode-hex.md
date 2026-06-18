# Step 2 — decode `\xNN` hex string escapes

> Deobfuscation journal for `myflow/`. One step per doc, each small and
> reproducible. This is **step 2**: the first transform that actually reveals
> meaning. Input is `script.beautified.js` (output of step 1); output is
> `script.step2.js`.

## Goal
Turn hidden string literals like `"\x6c\x65\x6e\x67\x74\x68"` into their real
text `"length"`. The obfuscator hex-escapes the bytes of ordinary, meaningful
strings (`length`, `entries`, `create`, `constructor`, …) so you can't read them
at a glance. Decoding them is the first step that makes the code *say what it
does*.

This is still a representation-only change — it does **not** touch control flow,
the string-array indirection, or identifier names. It just stops the strings
from hiding.

Where it fits in the overall arc:

```
[1] beautify
[2] decode \xNN hex string escapes   ← you are here
[3] inline string-array accessor calls (JX()[cz(tQ)] → "length", etc.)
[4] constant-fold / unflatten control flow
[5] rename identifiers
```

## Why an AST tool now (not regex)
Step 1 used `js-beautify` because it only adds whitespace. Step 2 is the first
transform that rewrites the *code*, and a blind find-replace of `\xNN` is unsafe:
the same `\x` byte sequence is meaningful and must be **preserved** inside

- **regex literals** — e.g. a character class `/[\x00-\x1f]/`, where `\x1f` is
  part of the pattern, not a hidden word, and
- **numeric literals** — hex numbers like `0xeefb964` or the SHA-256 constant
  table `0x428a2f98, 0x71374491, …`.

So we parse the file into a Babel AST and only rewrite **string literals**,
leaving `NumericLiteral` and `RegExpLiteral` nodes untouched. This is also the
toolchain we'll lean on for steps 3–5.

## The one trick that makes it work
Babel's parser already decodes the escapes for us. For a string literal node:

- `node.value` holds the **real** string — `"length"`.
- `node.extra.raw` holds the **original source form** — `'"\x6c\x65..."'`.

The code generator prefers `node.extra.raw` when it's present, so by default it
faithfully reprints the escapes. Delete `node.extra`, and the generator is forced
to re-serialize from `node.value` instead — through `jsesc`, which we configure
to keep printable ASCII readable.

We strip `extra` from **every** string literal, not just ones whose source
contains the text `\x`. A handful of strings carry **raw** control bytes directly
in the source (a literal `0x13` byte, not the text `\x13`); a "`\x`-only" filter
would skip those and leave binary bytes sitting in the output file. Regenerating
all strings from `.value` gives one consistent rule:

- printable ASCII (`length`, `entries`, …) → stays readable,
- non-printable bytes (the obfuscator's binary string-pool data) → become clean
  `\xNN` / `\uNNNN` escapes, never raw bytes.

The `.value` never changes, so the rewrite is provably semantics-preserving (see
*Verify* below).

## What to run
From the `myflow/` directory (Babel deps are declared in `package.json`):

```sh
npm install            # once: @babel/core, parser, traverse, generator
node transforms/02-decode-hex.js     # or: npm run step2
```

The script reads `script.beautified.js` and writes `script.step2.js`. The
original is left untouched, as always.

The transform itself is small enough to keep in your head:

```js
const ast = parser.parse(source, { sourceType: 'script', errorRecovery: true });

traverse(ast, {
    StringLiteral(p) {
        if (p.node.extra) { delete p.node.extra; }   // regenerate from .value
    },
    // NumericLiteral + RegExpLiteral deliberately NOT visited → preserved as-is
});

const { code } = generate(ast, {
    jsescOption: { quotes: 'single' },   // printable ASCII passes through readable
});
```

## What to expect / how to verify
Running it prints how many string literals were regenerated:

```
step 2: decoded hex escapes in 2069 string literals
        script.beautified.js -> script.step2.js
```

**Before** (`script.beautified.js`, line 9):

```js
var ZM = function() {
    return ["\x6c\x65\x6e\x67\x74\x68", "\x41\x72\x72\x61\x79", "\x63\x6f\x6e\x73\x74\x72\x75\x63\x74\x6f\x72", "\x6e\x75\x6d\x62\x65\x72"];
};
```

**After** (`script.step2.js`):

```js
var ZM = function () {
  return ['length', 'Array', 'constructor', 'number'];
};
```

Other now-readable landmarks: `[]['entries']()` (was `[]['\x65\x6e...']()`),
`Object['create'](Object['prototype'])`, `'fromCharCode'`, `'charCodeAt'`.

Quick checks:

```sh
node --check script.step2.js          # still valid JS

# meaningful words now appear as plain literals
grep -c "'length'\|'entries'\|'create'\|'constructor'" script.step2.js   # 11

# hex NUMBERS preserved (not turned into decimal, not touched)
grep -c "0x428a2f98\|0xeefb964" script.step2.js                          # 2

# the file is clean text — zero raw control bytes embedded
LC_ALL=C grep -ac '[^[:print:][:space:]]' script.step2.js                # 0
```

### Proving it's representation-only
The strongest check: parse **both** files, collect every string literal's
decoded `.value` in order, and confirm the two lists are byte-for-byte identical.
If they match, we changed only how strings are *written*, never what they *are*:

```
string count A(beautified)= 2069  B(step2)= 2069
PASS: all string values identical (representation-only change)
```

## What this step does NOT do (important)
- **String-array indirection is still opaque.** Calls like `JX()[cz(tQ)](...)`
  still hide which string they resolve to. Decoding the hex escapes exposed the
  *machinery* of that system — `JX()` is `[]['entries']()` (an array iterator),
  `cz(i)` indexes the `wDU()` name table — but resolving a given call to its
  actual string is **step 3**.
- **Control flow is still flattened** (comma sequences, ternary string lookups,
  the big `switch (OI)` VM dispatcher). That's step 4.
- **Identifiers are still meaningless** (`S9`, `Dz`, `OI`, `cr`, …). That's
  step 5.

## Next
**Step 3 — inline string-array accessor calls**
([03-inline-string-accessors.md](03-inline-string-accessors.md)). The next win
would be resolving `JX()[cz(tQ)](...)`-style lookups back to the concrete
string/method they stand for. This turned out to be **much harder than steps 1–2
and is currently blocked**: the strings are produced by per-family *stateful VM
decoders* that only yield correct values in the script's authentic runtime
order/context. See the step-3 doc for the full reverse-engineering write-up, the
infrastructure built, and the realistic ways to finish it.
