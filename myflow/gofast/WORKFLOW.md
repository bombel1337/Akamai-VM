# gofast — workflow toward generating a valid Akamai sensor

> Authorized research only — for testing one's **own** Akamai-protected site
> (`zalando.pl`, see [script/data.txt](script/data.txt)). This is the Go/[go-fAST]
> counterpart to the JS [`../babelflow/`](../babelflow/) pipeline. It does **not** run
> the target script; the static stages are pure AST work.

[go-fAST]: https://github.com/T14Raptor/go-fAST

## Goal
Eventually emit a **valid `sensor_data` body / `x`-token** for a real request, then
confirm acceptance (the `_abck` cookie loses its `~-1~` invalid marker). We are **not**
rushing there — this doc is the map; we build it one stage at a time.

## Mental model
`gofast` is a **static deobfuscator + (future) generator**, not an interpreter. go-fAST
parses the 524 KB `script.js` into an AST, we transform it, and regenerate readable JS.
The cipher/field knowledge already recovered by `babelflow` is the ground truth we port.

## go-fAST API cheat-sheet (module `github.com/t14raptor/go-fast`, needs Go 1.24)
| Need | Call |
|------|------|
| Parse JS → AST | `parser.ParseFile(src string) (*ast.Program, error)` |
| AST → readable JS | `generator.Generate(node)` |
| AST → minified JS | `generator.GenerateMinified(node)` |
| Scope/binding resolution | `resolver.Resolve(p)` (run before rename/inline passes) |
| Walk & rewrite | swc-style visitor — see below |
| Const-eval / node removal | helpers in `ast/ext/` (`value.go`, `expr.go`, `remove.go`) |

**Visitor pattern (swc-style):**
```go
type myPass struct{ ast.NoopVisitor }
func (p *myPass) VisitStringLiteral(n *ast.StringLiteral) {
    // ... rewrite n ...
    n.VisitChildrenWith(p.V) // recurse into children
}
// usage:
p := &myPass{}
p.V = p                  // NoopVisitor.V must point back at the pass
program.VisitWith(p.V)
```

## The 8 phases (S = static / go-fAST owns it, D = dynamic / needs a live run)

| # | Phase | Mode | Definition of done |
|---|-------|------|--------------------|
| 1 | **Inputs & grounding** | have | `script/script.js`, captured `script/sensor_data.json`, `script/data.txt` (UA, page/script URL, `_abck`, `bm_sz`) all present; babelflow findings treated as truth. |
| 2 | **Deobfuscation pipeline** | **S** | The 5 passes below run end-to-end and emit a readable `script.final.js`. **← first thing we build.** |
| 3 | **Locate the machinery** | **S** | In the cleaned source, identify SHA-256 (`vx`), MurmurHash3 (`pYU`), the `dD()[KI(...)]` decoder dispatch, the `;`-join body assembler, and the `IzU` 14-field registry (landmarks: [`../docs/04-sensor-data-pipeline.md`](../docs/04-sensor-data-pipeline.md)). |
| 4 | **Decoder recovery (step 3)** | **D** ⛔ | The per-family string decoders only yield correct strings under authentic runtime state — the known project blocker. Plan: hook `dD()`/the char emitter in a real-Chrome run (cf. `../babelflow/generator/devtools-hook.user.js`) and capture decoded method/field names, endpoints, and the section[0] preimage. |
| 5 | **Cipher** | **S** (port) | Port `../babelflow/generator/cipher.js` `decodeV3`/`encodeV3` to Go: substitution over the 92-char alphabet + LCG keystream `key=(key*65793+4282663)&0x7FFFFF`, `rZ=(key>>8)&0xFFFF`, `idx±(rZ%92)`, advancing every char; chars outside the alphabet pass through. Seed = first numeric token of `bm_sz`. DoD: re-encode of `sensor_data.json` is bit-exact. |
| 6 | **Field modeling** | **D** ⛔ | Reproduce the plaintext grid. **Finding (2026-06-18):** the decrypted plaintext is **transposed/permuted per POST** — the cipher decodes live captures correctly (real GPU/UA/timezone values), but the field name↔value framing is shuffled (e.g. `"brand"` appears 9–11× with unrelated values; permutation keys like `d+c+g+b+a+h+j+e+l+k+i+` live in `fct`/`ajt`). So **static diff cannot recover a clean field map**. Unblock via the runtime hook ([capture/](capture/)): it records the assembled plaintext (`Array.join`) + section0 preimage (`crypto.subtle.digest`/`btoa`) before encryption. Then `gofast capture-analyze` cross-refs them. **Timing model recovered** ([capture/TIMING.md](capture/TIMING.md), via `gofast timemap`): a session-static **anchor epoch** + per-POST **elapsed timers** (`send − anchor`, matched to 1–17ms) + behavioral offsets + static device tokens. Coherent refresh = shift elapsed timers/offsets by `delta`, keep the anchor. |
| 7 | **Generate** | **S** | Assemble `3;0;1;0;<seed>;<section0>;<metaCsv>;<encryptSub(plaintext,seed)>` and round-trip-verify against a captured sample. |
| 8 | **Submit & validate** | **D** | POST/relay against the **authorized** site; success = `_abck` loses `~-1~` and becomes valid. **✅ Verified live (2026-06-18, accounts.zalando.com SSO):** `passthrough` mode re-encoded every POST with our cipher **byte-identical** to the real body and `_abck` advanced `~-1~ → ~0~` (valid) — cipher + transport confirmed end-to-end. **Integrity surface probed (2026-06-18):** `corrupt:section0` → `_abck` stuck `-1` (**section0 IS checked** — but session-stable, so reuse the captured value); `corrupt:meta` → `0` (**meta not strictly checked**); `corrupt:plain` (1-char flip) → `0` (**payload not a byte-exact hash; minor edits tolerated**). ⇒ **capture-assisted generation is viable**: reuse captured `section0`+`seed`, refresh dynamic fields, re-encode. **Caveat (corrected):** the first `regen` attempt keyed on the `sc:` label and matched nothing (transposition de-correlates labels from values) → it was a silent no-op (= passthrough), so it did **not** yet prove field-refresh. Fixed to target the ms-epoch **by value** (`1[78]xxxxxxxxxxx`). **Re-test result (2026-06-19): FAILED** — refreshing that one timestamp → `_abck` stuck at `-1` over 15 posts. The 13-digit epoch is a **base/start time** (~11s before send) that other fields encode elapsed-time against; moving it alone breaks timing coherence. ⇒ **lone-field offline edits don't work; the timing fields are coupled (and transposed, so hard to find/shift together).** The only confirmed way to a valid body is **fresh `passthrough`** (capture a real sensor, send unmodified, immediately). So the reliable product is a **sensor harvester**, not an offline synthesizer — full offline generation stays gated on modeling the coupled timing group. |

**Honesty note:** go-fAST owns phases 2, 3, 5, 7. Phases 4 and 8 are dynamic and cannot be
done by static AST work alone — they need the script executed in a real browser context.

## Phase 2 — the deobfuscation pipeline (mirrors `../babelflow/steps/`)
Each pass is one file in [`pipeline/`](pipeline/). Today step 01 is real; 02–05 are
pass-through stubs with the design noted, so the whole pipeline already runs.

| Pass | File | What it will do (from babelflow) |
|------|------|----------------------------------|
| 01 beautify | `pipeline/step01_beautify.go` | parse → `generator.Generate` (reflow the single minified line). **Working.** |
| 02 decode-hex | `pipeline/step02_decode_hex.go` | re-emit string literals from their value so `\xNN` escapes resolve (`"\x6c\x65..."` → `length`). |
| 03 inline-operators | `pipeline/step03_inline_operators.go` | detect pure operator-alias helpers (`Mp=a=>!a`, `HE=(a,b)=>a+b`, …) and rewrite call sites back to real operators (scope-aware). |
| 04 fold-constants | `pipeline/step04_fold_constants.go` | collapse pure constant subtrees re-exposed by 03 (`!+[]+!+[]` → `2`, `'0x'+'eefb964'` → `'0xeefb964'`). |
| 05 simplify-members | `pipeline/step05_simplify_members.go` | computed string-key access → dot notation when the key is a valid identifier; leave decoder-driven `BASE()[IDX(k)]` and numeric keys alone. |

Driver [`main.go`](main.go) runs them in order, writing `out/0N-*.js` and a final
`script.final.js` — same shape as `../babelflow/run.js`.

## Run it
```sh
cd myflow/gofast
go mod tidy
go run .                                  # deobfuscate: script/script.js -> out/ + script.final.js
go run . generate                         # script/input.json -> a v3 sensor_data body
go run . selftest                         # cipher/generator bit-exact check
go run . analyze script/sensor_data.json  # decode a capture + dump field grid
go run . diff script/cap1.json cap2.json  # classify fields static vs dynamic
go run . capture-analyze capture/capture-real.json  # cross-ref a real-Chrome capture (phase 6)
```
For phase 6 (the field-modeling unblock) see [capture/README.md](capture/README.md).

## Deferred decisions (revisit when we reach them)
- Phase 4/8 (dynamic): port the capture harness to Go, or keep it in JS and have `gofast`
  shell out to the existing babelflow tooling.
- Exact AST transforms for passes 02–05 (hex-escape handling, operator-helper detection,
  member-simplification rules) — designed when each stub is implemented.
