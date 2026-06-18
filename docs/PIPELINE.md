# Akamai-VM Decompiler — Behind-the-Scenes Pipeline

This document is a top-to-bottom trace of how the decompiler turns Akamai's
base64 VM bytecode into readable JavaScript. It follows the **real execution
order** and explains the conventions that aren't obvious from a cold read of the
source. If you're a future session picking this up, read this first.

> TL;DR of the whole flow:
> `base64 text` → **decode** → `byte[]` → **graph** → `CFG of Blocks` →
> **structure** → `messy JS string` → **optimize** → `clean JS string` → file.

---

## 0. The one mental model that makes everything click

This project is **not an interpreter**. It never runs the VM's logic. It is a
**symbolic lifter**: it walks the bytecode once, and instead of computing
values, it builds *string expressions* that describe what each instruction would
do.

- The VM's "stack" is just an integer counter (`vm.stack`).
- Each stack slot is a virtual register named `v0`, `v1`, `v2`, …
- "Pushing 5" doesn't push the number 5 — it emits the text `v3 = 5` and bumps
  the counter.
- "Adding the top two values" doesn't add anything — it pops two slot *names*
  and emits `v1 = v2 + v1`.

So the output of the early stages is a flat list of `v# = <expr>` assignment
strings plus control-flow terminators. Everything after that is graph analysis
and text cleanup. Keep this in mind and the rest is straightforward.

---

## 1. Entry point & high-level flow — [decompiler.js](../decompiler.js)

```js
function decompile(bytecode) {
    let vm = new VM(decode(bytecode));          // base64 text -> byte[]
    return optimize(structure(graph(vm, 0)));   // byte[] -> CFG -> JS -> clean JS
}
```

Four stages, four data types flowing between them:

| Stage | Function | Input | Output |
|-------|----------|-------|--------|
| Decode | `decode` ([helper/vm.js](../helper/vm.js)) | base64 string | `byte[]` |
| Lift + CFG | `graph` ([helper/cfg.js](../helper/cfg.js)) | VM over `byte[]` | `CFG` of `Block`s |
| Structure | `structure` ([helper/structure.js](../helper/structure.js)) | `CFG` | JS string (with `v#` slots) |
| Cleanup | `optimize` ([helper/optimize.js](../helper/optimize.js)) | JS string | readable JS string |

The driver reads `script/bytecode.txt`, runs `decompile`, prints the elapsed
time, and writes the result to `output/ak.js`.

---

## 2. The VM model — [helper/vm.js](../helper/vm.js)

### `decode`
```js
function decode(b64) { return [...Buffer.from(b64, 'base64')]; }
```
Base64 → a plain array of byte values. That array is the program the lifter
walks.

### The `VM` class as a symbolic machine
The VM object is a bundle of cursors and bookkeeping, **not** runtime data:

- `ptr` — current byte offset (the instruction pointer).
- `stack` — an integer; the height of the symbolic stack. The next push lands in
  slot `v{stack}`.
- `term` / `exit` — set by terminator opcodes to signal "this block ends here"
  (see §3).
- `self` — pending receiver for the next call (set by member access, consumed by
  the call opcode).
- `argCount` — arity of the function currently being lifted (used by the
  `arguments` opcode).
- `bytes` — a side-table mapping a slot name → its *literal* value. Needed
  because some opcodes (array build, call arg-kinds) must look back at the
  concrete number a slot was loaded with, not its text form.
- `kinds` — tags a slot as a `box` (a resolved property handle); this drives the
  property/memory system in §3.
- `last` — last slot written (used by `return` when the stack is empty).
- `labels` / `jumped` — scratch state reset across nested lifts.

### Reader helpers
- `readByte()` — read one byte, advance `ptr`.
- `readInt()` — read 4 bytes **big-endian** → a signed 32-bit int.
- `readStr()` — read a 2-byte big-endian length, then that many chars, and
  return it **JSON-stringified** (so `hello` comes back as the 7-char text
  `"hello"`, quotes included). This is why string literals already carry their
  quotes through the rest of the pipeline.

### `push` / `pop` / `peek`
```js
push(v, t) {
    let slot = `v${this.stack}`;
    delete this.kinds[slot];
    this.last = slot;
    if (t) this.bytes[slot] = v;     // remember literal value when t is truthy
    return `v${this.stack++} = ${v}`; // emit assignment text, bump counter
}
peek() { return `v${this.stack - 1}`; }      // name of top slot (no pop)
pop()  { let v = this.peek(); this.stack--; return v; } // name + shrink
pop_peek(x) { return x ? this.peek() : this.pop(); }    // conditional pop
```
`push` returns the **statement string**; callers either return it (to emit it)
or use it for its side effect. The `t` flag means "this is a literal — also store
it in `bytes` so later opcodes can read the raw value."

`getSelf()` returns and clears `self` — the receiver is single-use per call.

---

## 3. Opcode semantics — [helper/opcodes.js](../helper/opcodes.js)

### How a handler is invoked
The CFG builder does:
```js
let res = handler.call(vm);   // `this` === vm
if (res) block.output.push(res);
```
So an opcode handler:
- **returns a string** → that string becomes a statement in the block.
- **returns nothing** → it only mutated VM state (a pure stack effect), no line
  emitted.

### 3a. Terminators (set `vm.term` + `vm.exit`, ending the current block)

| Op | Meaning | Notes |
|----|---------|-------|
| `6` | `return` | Value = top slot, else `last`, else `undefined`. This is the README's "non-existent call to exit" trick — the VM's main loop wraps opcode dispatch in a `try/catch` and op `6` is the deliberate way out. |
| `135` | `goto target` | `target = readInt()`. |
| `14` | `branch` | Conditional: `cond` from `pop_peek(keep)`, true→`target`, false→fallthrough `ptr`. |
| `36` | negated `branch` | Same as `14` but `cond` is wrapped `!(...)`. |
| `147` | `eof` | Hard end; resets `stack` and jumps `ptr` to end of bytecode. |

`keep` (a byte operand on `14`/`36`) decides whether the condition value stays on
the stack (`peek`) or is consumed (`pop`).

### 3b. Value/stack producers

| Op | Emits | Notes |
|----|-------|-------|
| `53` | `v# = {}` | empty object |
| `112` | `v# = "..."` | string literal via `readStr` |
| `230` | `v# = <byte>` | 1-byte int literal, stored in `bytes` |
| `173` | `v# = <int>` | 4-byte int literal, stored in `bytes` |
| `158` | `v# = undefined` | |
| `71` | — | pop/discard top (no emit) |
| `139` | `v# = [...]` | array build; reads a count, and for each element looks up the **arg-kind** in `bytes` (`0` = normal element, `1` = `...spread`) |

### 3c. Property / memory system (the headline feature)

This is the part the README calls out. Akamai's VM stores named values it can
fetch later by walking the stack for a matching property. The lifter models it
with **boxes**:

- **`103` — resolve**: emits `v# = _resolve("name")` and tags that slot in
  `kinds` as `{ type: 'box', name }`. A "box" is a handle to a named slot.
- **`229` — store**: pops `key` and `value`. If `key` is a box, it emits
  `_<name> = <rhs>` (a clean named assignment); if the value is *also* a box, it
  uses that box's name as the rhs. A `wrap` operand optionally parenthesizes the
  expression so it can be used inline. If `key` isn't a box, it falls back to a
  raw `v#[key] = value` store.
- **`119` — member access**: pops `key` and `obj`, emits `v# = obj[key]`. When
  it's not a "super" access it records `obj` as `this.proxy` (the receiver), so a
  following call knows what `self` to use.

End to end: `_resolve("Op")` creates box `Op`; later a store against that box
becomes `_Op = ...`; later cleanup (`renameResolves`) turns any remaining
`_resolve("Op")` reads into `_Op`. That's how the symbolic `v#` soup acquires
readable named variables.

### 3d. Binary operators
A factory builds them all:
```js
function binop(operator) {
    return function () {
        let a = this.pop();
        let b = this.pop();
        return this.push(`${a} ${operator} ${b}`);
    };
}
```
Operator table (op → operator): `10` `*`, `34` `<`, `58` `<<`, `72` `-`,
`82` `!==`, `97` `+`, `108` `/`, `116` `^`, `128` `in`, `156` `===`, `179` `>>`,
`181` `%`, `189` `|`, `201` `>>>`.

Note the pop order: `a` is the **top** of the stack, `b` is below it, and the
emitted text is `a op b`.

### 3e. Calls, functions, and friends

- **`11` — call/apply**: reads a result flag, an arg count, and the arg kinds
  (`0` normal, `1` `...spread.reverse()`). Pops the callee and args, then
  consumes `self` via `getSelf()`. If there's a real receiver it emits
  `fn.apply(self, [args])`; otherwise `fn(args)`. The result flag decides whether
  the call is pushed as a value or emitted as a bare statement.
- **`113` — function literal**: reads arity and an entry pointer, then
  **recursively lifts a whole new function body**: it snapshots the VM state,
  resets stack/bookkeeping, pushes placeholder params, and calls
  `structure(graph()(this, entry))` to lift the nested CFG. Then it restores the
  saved state and pushes `v# = function(v.., v..) { <body> }`. The
  `graph = () => require('./cfg.js').graph` lazy-require breaks the circular
  dependency between `opcodes` and `cfg`.
- **`218` — arguments object**: emits `v#["arguments"] = [ ... ]` from the
  current frame's argument slots (using `argCount`).
- **`94` — increment**: `target++` or `++target` depending on the operand.
- **`64` — negate**: `v# = -1 * <x>`.

### 3f. try / catch / finally — `120`
The most involved opcode. It pops three pointers (try/catch/finally entries from
`bytes`) and lifts each as an independent sub-CFG via a local `lift()` helper:
```js
let body = structure(graph()(this, entry));
```
Each sub-lift **snapshots** the relevant VM fields, resets them to a clean state,
lifts the region, then **restores** the snapshot. The catch body is lifted with
`err` pre-pushed so the catch parameter resolves. The opcode returns a fully
assembled `try { ... } catch (err) { ... } finally { ... }` string.

### 3g. `snapshot()` and why save/restore exists
```js
function snapshot(vm, fields) { /* shallow-copy named fields */ }
```
Function literals (`113`) and try/catch (`120`) lift **nested scopes reusing the
same VM object**. Without snapshot/restore, the inner lift would clobber the
outer scope's `ptr`, `stack`, `bytes`, etc. Snapshot before recursing, restore
after — this is the backbone of nested decompilation.

---

## 4. CFG construction — [helper/cfg.js](../helper/cfg.js)

### `Block` and `CFG`
- `Block { start, end, output[], term, input }` — `output` is the list of
  emitted statement strings; `term` is the terminator; `input` records the
  `vm.stack` height at block entry.
- `CFG { entry, blocks: Map, predsCache }`.
  - `succs(block)` — derived from `term`: `goto` → `[target]`, `branch` →
    `[t, f]`, otherwise `[]`.
  - `preds(start)` — computed lazily and cached (`getPreds` inverts all succ
    edges); `nullify()` clears the cache when the graph changes.

### `getBlock(vm, start, end, leaders)`
Lifts a single basic block by linear sweep from `start`:
- Records `block.input = vm.stack`.
- Reads opcodes one at a time, pushing returned strings into `block.output`.
- Stops when an opcode set `vm.term` (a real terminator), **or** when it reaches
  a byte offset that's a known *leader* (start of another block) — in that case
  it synthesizes a `goto` to split the fallthrough.
- Unknown opcodes emit a `/* unknown op N */` marker and stop.
- If it falls off the end with no terminator, it gets a synthetic `goto end` (or
  `eof` when leaders are tracked).

### `graph(vm, entry)`
1. Worklist starting from `entry`: for each leader not yet built, call
   `getBlock`, then enqueue its successors as new leaders.
2. **Overlap-resolution pass**: after all blocks exist, sort starts and look for
   any block whose `[start, end)` range overlaps a *later* leader. When found, it
   **re-lifts** that block bounded at the overlap — and critically resets
   `vm.stack = block.input` first, so the symbolic stack height is correct for
   the re-lift.

### The `input` ↔ `vm.stack` coupling (important)
Because slots are named purely by stack height, a block can only be lifted with
the **same `vm.stack`** it would have at runtime entry. That's why blocks store
`input` and the re-lift restores it. It's also why you can't lift blocks in
arbitrary order without care — the coupling between graph shape and stack height
is load-bearing.

---

## 5. Dominators & loop detection — [helper/dominators.js](../helper/dominators.js)

- **`revPostOrder(cfg)`** — DFS post-order from entry, reversed. Produces the RPO
  used to index every node.
- **`getDominators(cfg, rpo)`** — the Cooper-Harvey-Kennedy iterative dominator
  algorithm. Maps each node to an RPO index, then repeatedly recomputes each
  node's immediate dominator as the `intersect` of its predecessors' dominators
  until nothing changes. Returns `{ doms, idx, rpo }`.
- **`intersect(doms, a, b)`** — the classic "walk the higher index down its dom
  chain until they meet" routine.
- **`dominates(dom, a, b)`** — does `a` dominate `b`? Walk `b`'s dom chain up to
  the root looking for `a`.
- **`getLoops(cfg, dom)`** — finds natural loops by back-edges: an edge
  `block → succ` is a back-edge when `succ` dominates `block`. The loop body is
  collected by walking predecessors from the back-edge source up to the header.
  Returns a `Map<header, Set<bodyNodes>>`.

---

## 6. Structuring (CFG → JS) — [helper/structure.js](../helper/structure.js)

This stage turns the graph back into nested `if`/`while` JavaScript.

### `structure(cfg)`
Builds RPO → dominators → loops, then a `ctx` carrying `{ cfg, dom, loops,
emitted, loopStack }` and calls `emit(ctx, cfg.entry, null)`.

### `emit(ctx, start, stopAt)`
Linear walk from `start`, stopping at `stopAt`:
- First checks `loopStack`: if the current node is a tracked loop's `header` or
  `exit`, emit `continue;`/`break;` (only when it's the innermost loop) and stop.
- If the node is a loop header (`ctx.loops.has(ptr)`), hand off to `emitLoop`.
- Otherwise append `block.output`, then dispatch on `term`:
  - `eof` → stop.
  - `return` → append `return <value>;` and stop.
  - `goto` → continue from `target`.
  - `branch` → hand off to `emitBranch`, continue from its merge point.

### `emitLoop(ctx, header, block, lines)`
Determines the loop's `exit` and shape:
- If the header's terminator is a branch with exactly one edge inside the body,
  it's a **`while (cond)`** loop (the other edge is the exit, condition negated
  if needed).
- Otherwise it falls back to a **labeled `L<header>: while (true) { ... }`** with
  the branch/goto rendered inside and explicit `break`/`continue`.
- Pushes `{ header, exit, label }` onto `loopStack` while emitting the body, pops
  it after, and returns the `exit` node so the caller keeps going.

### `emitBranch(ctx, ptr, term, lines)` + `getMP`
- `getMP` computes the **merge point**: from the true and false targets it
  gathers all nodes reachable while staying at a higher RPO index than the
  branch, intersects the two reachable sets, and picks the lowest-RPO common
  node. That's where the two arms rejoin.
- Depending on which arm equals the merge, it emits one of:
  - `if (cond) { <t> }` (false arm is the merge),
  - `if (!(cond)) { <f> }` (true arm is the merge),
  - `if (cond) { <t> } else { <f> }` (neither — a real diamond).
- Returns the merge so `emit` continues after the join.

### `indent(text, width=4)`
Left-pads each non-empty line. Used everywhere bodies are nested.

---

## 7. Cleanup passes — [helper/optimize.js](../helper/optimize.js)

Up to here the output is correct but ugly: hundreds of `v# = ...` single-use
temporaries. `optimize` runs **six passes in a fixed order**:

```js
code = inlineSlots(code);
code = rename(code);
code = renameResolves(code);
code = inlineSlots(code);   // again, after renames open new opportunities
code = inlineCond(code);
code = nameFuncs(code);
```

### `inlineSlots` — the workhorse
For each `v# = expr`, it finds the next use within the **same indentation scope**
via `getNext`, which counts reads but bails at control-flow keywords, braces,
function boundaries, or a competing reassignment.
- **Used exactly once** → substitute the expression into that use and delete the
  assignment (`paranthises()` decides whether to wrap it in parens to preserve
  precedence; `isPure()` recognizes safe literal-ish expressions that never need
  wrapping).
- **Used zero times and pure** → drop the dead assignment entirely.
It loops until a fixpoint (with a guard), then does a final `!(!(x))` →
double-negation cleanup.

### `rename`
`v#["prop"] = v#` → `_prop = v#`. Promotes bracket-property stores to readable
named assignments.

### `renameResolves`
`_resolve("x")` → `_x`. Collapses leftover resolve calls into bare names.

### `inlineCond`
Folds `v# = expr` into an immediately-following `if (v#) {` / `while (v#) {`
**only when** the slot isn't read or reassigned inside the block or in trailing
same-scope lines (a careful safety scan using `getEnding` to find the block's
matching brace). Result: `if (expr) { ... }`.

### `nameFuncs`
Turns
```js
v3 = function(...) { ... }
_LU = v3
```
into a proper named declaration `function _LU(...) { ... }`, after verifying the
slot isn't used elsewhere in scope.

### Worked example — the `_ht` hash function ([output/ak.js](../output/ak.js))
After all passes, raw slot soup becomes:
```js
function _ht(v0) {
    { } ["arguments"] = [v0]
    _G = v0
    _Jr = undefined
    _Jr = 5381
    _IF = 0
    while (_IF < _G["length"]) {
        _Jr = ((_Jr * 33) ^ (_G["charCodeAt"](_IF)))
        _IF++
    }
    v0 = _Jr >>> 0
    return v0;
}
```
You can see the fingerprints of every stage: the `_resolve`-derived names
(`_G`, `_Jr`, `_IF`), the binop nesting from §3d, the `while` from §6, and the
`function` naming from `nameFuncs`.

---

## 8. Known rough edges (honest notes for future chats)

- **The output is readable pseudo-JS, not runnable.** Examples: the
  `{ } ["arguments"] = [...]` line from opcode `218`, and the `v#[key] = value`
  fallback store in `229`. The goal is comprehension, not re-execution.
- **Cleanup is regex/line-based, not AST-based.** That makes it conservative and
  occasionally leaves artifacts (stray temporaries, odd parenthesization). This
  is intentional — per the README this is a *static* decompiler with "no
  parsing." If you need bulletproof transforms, that's where an AST pass would
  go, but it's explicitly out of scope.
- **`decode` expects base64.** There is no tokenizer/parser for raw VM source;
  the input contract is exactly "a base64 string of VM bytecode" in
  `script/bytecode.txt`.
- **Circular dependency** between `opcodes.js` and `cfg.js` is handled with a
  lazy `require` (`graph = () => require('./cfg.js').graph`). Keep that pattern
  if you add more cross-module recursion.

---

## Quick reference — file map

| File | Responsibility |
|------|----------------|
| [decompiler.js](../decompiler.js) | Driver: read bytecode, run pipeline, write `output/ak.js` |
| [helper/vm.js](../helper/vm.js) | `decode` + symbolic `VM` (slots, readers, stack ops) |
| [helper/opcodes.js](../helper/opcodes.js) | Per-opcode lifting logic (the instruction set) |
| [helper/cfg.js](../helper/cfg.js) | Basic-block + CFG construction (`getBlock`, `graph`) |
| [helper/dominators.js](../helper/dominators.js) | RPO, dominators, natural-loop detection |
| [helper/structure.js](../helper/structure.js) | CFG → nested `if`/`while` JS (`emit`, merge points) |
| [helper/optimize.js](../helper/optimize.js) | Regex cleanup passes (inline, rename, name funcs) |
