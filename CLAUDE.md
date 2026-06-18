# CLAUDE.md

Orientation for future sessions. For the full behind-the-scenes walkthrough see
**[docs/PIPELINE.md](docs/PIPELINE.md)**.

## What this is
A **static decompiler for Akamai's stack-based antibot VM**. It reads base64 VM
bytecode and emits readable (not runnable) pseudo-JavaScript describing what the
VM does. Educational/research project — no parser, no execution.

## The one mental model
This is **not an interpreter — it's a symbolic lifter**. It never computes
values. `vm.stack` is just an integer counter; each slot is a virtual register
`v0, v1, ...`; "pushing 5" emits the text `v3 = 5`. Everything downstream is
graph analysis + text cleanup over those slot strings.

## Pipeline (run order)
`base64` → `decode` → `byte[]` → `graph` (CFG) → `structure` (CFG→JS) →
`optimize` (cleanup) → write `output/ak.js`.

Driver: [decompiler.js](decompiler.js) reads `script/bytecode.txt`.

## File map
| File | Responsibility |
|------|----------------|
| [decompiler.js](decompiler.js) | Driver: read bytecode, run pipeline, write output |
| [helper/vm.js](helper/vm.js) | `decode` + symbolic `VM` (slots, readers, stack ops) |
| [helper/opcodes.js](helper/opcodes.js) | Per-opcode lifting logic (the instruction set) |
| [helper/cfg.js](helper/cfg.js) | Basic-block + CFG construction (`getBlock`, `graph`) |
| [helper/dominators.js](helper/dominators.js) | RPO, dominators, natural-loop detection |
| [helper/structure.js](helper/structure.js) | CFG → nested `if`/`while` JS |
| [helper/optimize.js](helper/optimize.js) | Regex cleanup passes (inline, rename, name funcs) |

## Conventions worth knowing before editing
- **Slots are named by stack height**, so a block must be lifted with the correct
  `vm.stack`. `Block.input` records it; `graph`'s overlap pass restores it before
  re-lifting. This coupling is load-bearing — don't reorder lifts casually.
- **Boxes / property memory**: `_resolve("name")` + a `kinds` box tag become
  readable `_name` variables (opcodes `103`/`229`/`119`); see PIPELINE §3c.
- **Nested scopes reuse the same VM object**, so function literals (`113`) and
  try/catch (`120`) `snapshot()` then restore VM state around a recursive lift.
- **Cleanup is regex/line-based, not AST-based** — conservative by design; it can
  leave artifacts. The output is for reading, not running.
- `opcodes.js` ↔ `cfg.js` is circular; broken with a lazy
  `require('./cfg.js').graph`.

## Run it
```sh
node decompiler.js   # decompiles script/bytecode.txt -> output/ak.js
```
```
