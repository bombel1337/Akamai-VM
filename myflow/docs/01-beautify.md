# Step 1 — Beautify `script.js`

> Deobfuscation journal for `myflow/`. One step per doc, each small and
> reproducible. This is **step 1**: pure formatting, no deobfuscation yet.

## Goal
Turn the raw Akamai script — a single, unreadable 411 KB line — into indented,
multi-line code we can actually navigate. This does **not** remove obfuscation;
it just gives the obfuscation a readable *shape* so later steps have something to
work on.

Where it fits in the overall arc:

```
[1] beautify  ← you are here
[2] decode \xNN hex string escapes
[3] inline string-array accessor calls (JX()[cz(tQ)] → "length", etc.)
[4] constant-fold / unflatten control flow
[5] rename identifiers
```

## What `script.js` is
- **Size:** ~411 KB, **1 line** (`wc -l script.js` → `1`).
- **Obfuscation traits observed:**
  - **String-array obfuscation** — strings are fetched through accessor calls
    like `JX()[cz(tQ)](...)` instead of appearing as literals.
  - **Hex string escapes** — e.g. `"\x6c\x65\x6e\x67\x74\x68"` is really
    `"length"`.
  - **Opcode VM** — there's a stack-based virtual machine. Its dispatcher is the
    big `switch` inside `var S9 = function Dz(OI, z7) { switch (OI) { ... } }`.
  - **Comma-sequenced statements** and ternary-wrapped string lookups everywhere
    (control-flow / expression flattening).

## What to run
From the `myflow/` directory:

```sh
npx --yes js-beautify@latest script.js -o script.beautified.js
```

- We use **js-beautify** (not Prettier) on purpose: it only adds whitespace and
  line breaks, so it won't choke on or rewrite weird obfuscated code. Prettier
  reformats aggressively and can struggle with a 411 KB obfuscated blob.
- `--yes` lets `npx` fetch the package without an install prompt. No
  `package.json` is needed for this one-off. (We'll add one later when we bring in
  a real AST toolchain like Babel.)
- The **original `script.js` is left untouched** — output goes to a new file,
  `script.beautified.js`, so we always have the pristine source to fall back to.

## What to expect / how to verify
- Line count explodes from 1 to ~12k:
  ```sh
  wc -l script.beautified.js     # ~12302
  ```
- The VM dispatcher is now on its own indented lines — find it with:
  ```sh
  grep -n "function Dz(OI, z7)" script.beautified.js     # → line ~11
  grep -c "switch (" script.beautified.js                # ~59 switch blocks
  ```
- Open `script.beautified.js` and skim the top ~40 lines: you should see the IIFE
  `(function LbwjJwXllM() {`, helper `JnU` (a `charCodeAt` wrapper), the string
  array in `ZM`, and the `S9`/`Dz` dispatcher with `case X5:`, `case N7:`, …

## What this step does NOT do (important)
Beautify is **cosmetic only**. After this step the code is still obfuscated:

- `\x6c\x65\x6e...` hex escapes are still hex escapes.
- `JX()[cz(tQ)](...)` string lookups still hide which string they return.
- Identifiers are still meaningless (`S9`, `Dz`, `OI`, `z7`, `cr`, …).

That's expected. Readability of *structure* is the only win here.

## Next
**Step 2 — decode `\xNN` hex string escapes** ([02-decode-hex.md](02-decode-hex.md)),
so literals like `"\x6c\x65\x6e\x67\x74\x68"` become `"length"`. That's the first
transform that actually reveals meaning, and the first one that uses an AST tool
(Babel) rather than a formatter.
