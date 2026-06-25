# RE handoff — offline Akamai sensor generator (read this to resume)

**Goal:** a no-browser generator: `input.json` (UserAgent, PageUrl, ScriptUrl, …) → a valid
`sensor_data` in ~1s, by reverse-engineering the live akamai script and reimplementing it in
`gofast`. Driven by **ghostwire** (CDP runtime instrumentation) + its `gw_verify` oracle.

This file is the resume point because MCP tools load per-session and a window reload drops the
conversation. New session: read this, confirm the `gw_*` tools are present, continue at M1.

## How to drive ghostwire
- MCP server **`ghostwire`** is registered (local scope, project `Akamai-VM`), health ✓ Connected.
  After a full Claude Code restart, tools `mcp__ghostwire__gw_attach / gw_eval / gw_hook /
  gw_strings / gw_vm / gw_origin / gw_verify / gw_crypto / gw_heapdiff / gw_objects / gw_scripts /
  gw_network / …` are available. **First step each session: confirm one exists (e.g. ToolSearch
  "select:mcp__ghostwire__gw_attach"). If absent, the window wasn't restarted after registration.**
  - **Known gotcha (resolved 2026-06-23):** server is healthy (`python -m ghostwire.mcp_server`,
    v1.28.0; `claude mcp list` → ✓ Connected) but the VSCode-extension session would not load the
    *local*-scope entry (cwd-keyed). Fix: ghostwire is now also registered at **user scope**
    (top-level `mcpServers` in `~/.claude.json`) so it loads in every session. Command is pinned to
    the **absolute python path** (`C:/Users/przyg/AppData/Local/Programs/Python/Python310/python.exe
    -m ghostwire.mcp_server`) — bare `python` failed because the VSCode extension host spawns
    subprocesses with a different PATH than the terminal (remote connectors load, stdio subprocess
    silently doesn't). If `gw_*` is still absent, do a **full quit + relaunch** of VSCode/Claude
    (window reload is not enough), then re-check with ToolSearch.
- Ghostwire lives at `C:\Users\przyg\Desktop\GitHub\ghostwire` (sibling, not in this repo). It was
  **ported to Windows by us**: added a WebSocket/`--remote-debugging-port` transport
  (`ghostwire/cdp.py` `WSConnection`, `ghostwire/browser.py` `_init_ws`, `--remote-allow-origins=*`)
  because the upstream pipe transport is POSIX-only. Editable-installed (`pip install -e .`); deps
  `mcp`, `websocket-client`. All core tools verified PASS on Windows + the real zalando page.
- Batch fallback (no MCP): scripts in `ghostwire/akamai/` (`m1_getscript.py`, `m1_preimage.py`,
  `m1_init.py`) — `python ghostwire/akamai/<x>.py`. Slow (~2 min/run); MCP is ~10x faster.
- Authorized target page (from `script/data.txt`):
  `https://www.zalando.pl/asics-sportstyle-gel-nyc-unisex-sneakersy-niskie-creamcloud-grey-a0h15o08w-a12.html`

## Already solved / known (reuse — don't redo)
- **Cipher** ([sensor/cipher.go](sensor/cipher.go)): substitution over a 92-char alphabet + LCG
  keystream `key=(key*65793+4282663)&0x7FFFFF`, seed = first numeric `bm_sz` token. Bit-exact,
  validated live (passthrough → `_abck ~0~`).
- **Body shape:** `3;0;1;0;<seed>;<section0>;<metaCsv>;<encryptSub(plaintext,seed)>`. Plaintext is a
  `:`-joined list of `{"field":value}` objects, **transposed/permuted per POST** (the static wall).
- **Timing model** ([capture/TIMING.md](capture/TIMING.md)): session **anchor epoch** (= `bmak.startTs`,
  reuse), per-POST **elapsed timers** (`send−anchor`), static device tokens, behavioral offsets.
  Offline edits to a captured body are rejected (timing coupled vs session age) → must generate coherently.
- **Integrity surface:** `section0` is server-checked (corrupt→reject); `meta` not strictly checked;
  1-char payload edits tolerated.
- **bmak runtime facts:** `window.bmak` global; `startTs` = anchor; `get_telemetry()` = SBSD channel;
  sensor builder chain `fZD → VbD → vmq → jCD`.

## M1 — section0 (IN PROGRESS, the GO/NO-GO gate)
- The script's **SHA-256** (`vx`; live IV `6a09e667`) at init hashes only **canvas** (24KB PNG
  data-URL) and **speech-synthesis voices** — captured live via init-time instrumentation
  (`m1_init.py`). These are fingerprint sub-fields.
- **section0 is NOT a SHA-256** of any captured input, and no SHA-256 call fires at sensor-build →
  section0 is built by a **different primitive** (MurmurHash `pYU` / custom, via the `fZD/VbD/jCD`
  chain). Confirms the old static finding.
- **NEXT STEP:** `gw_origin(value=<live section0>, enter=<bmak builder>)` and/or `gw_heapdiff` around a
  sensor build to find the function that produces section0, then capture its exact preimage and
  `gw_verify` a candidate `section0(inputs)` against the live builder. **Verdict:** reproducible from
  client inputs → proceed to M2; depends on server/random/hardware → offline is impossible, keep the
  harvester (`capture/` + `gofast harvest`).
- section0 **rotates** between script versions (saw `78jU…`, `dEKn…`, `D9cw…`) — expected; the
  generator must derive it per current script.

### M1 progress — session 2026-06-23 (ghostwire MCP working in-session)
- **MCP now works in the VSCode extension** after pinning the server cmd to the absolute python path
  + full relaunch. Caveat: `gw_objects`/heap tools **time out** (`HeapProfiler.takeHeapSnapshot`) on
  this heavy page; `gw_attach/gw_eval/gw_network/gw_scripts/gw_hook` work. Batch scripts in
  `ghostwire/akamai/` are still the tool for **init-time breakpoints** (no MCP primitive for that).
  New batch helpers added: `m1_srcprobe.py`, `m1_sec0stability.py`, `m1_sec0heap.py`, `m1_pin.py`,
  `m1_grab.py`, `m1_init2.py`.
- **section0 stability (key for GO/NO-GO):** constant across all POSTs *and* across reload within one
  cookie/bm_sz session; **changes across fresh sessions** (tracks the `bm_sz` seed). So it is
  **deterministic per session, NOT per-POST random** — computed once at init from client-side inputs
  (device fingerprints + session data we receive). Leans **GO**, but preimage not yet confirmed.
- **Producer located (heap retainer, `gw_objects`/batch):** section0 (32 bytes, base64) is cached in a
  **closure context var** (saw `rg9`, `EKs` — name rotates per delivery), assigned **once** by
  `VAR = HASHFN.call(null, Yz, EE, B3({}), B3(B3([])))[<toString method>]( <Base64 encoder> );`
- **It is NOT base64(sha256(single input)).** The `IhaVgB` sensor script's SHA-256 (IV `6a09e667`,
  fn param e.g. `Hq`, body col ~82489) is a **general-purpose hasher** — at init it hashes individual
  sub-fingerprints: speech voices (len 653), `chrome` keys `"loadTimes,csi,app"`, numbers (`101901`,
  `356`). section0's `HASHFN` (`fB()[tr(qM)]`) is a **different/aggregating primitive** (MurmurHash/
  custom per old note), likely combining those sub-hashes + session data.
- **Obfuscation re-randomizes per delivery** (var names, decoder fns) even when section0's value logic
  is stable per session → **name-based breakpoints are fragile**; prefer IV-based breakpoints and
  heap-retainer lookups. Two big zalando scripts both carry the IV: `AXUmFS` (fingerprint collector,
  ~431KB, no `bmak`) and `IhaVgB` (sensor, ~541KB, has `bmak`).
- **NEXT STEP:** break exactly at the section0 producer (`VAR=` RHS) and read `Yz`/`EE` to get the
  preimage, then identify `fB()[tr(qM)]` (the aggregating hash) and trace `Yz`/`EE` to their sources
  (which sub-fingerprint hashes + session fields). Robust arming: derive the cache-var name in-session
  via heap retainer, then set a **location** breakpoint at the `VAR=` column in the freshly-parsed
  `IhaVgB` (do it in ONE session; instrument `beforeScriptExecution` and arm only on the big `bmak`
  script — note instrumentation overhead delays `IhaVgB`, use ~40s). Then `gw_verify` a candidate
  `section0(inputs)` against the live builder.

### M1 deep-dive — session 2 (2026-06-23): GO on determinism, BLOCKED on a CFF VM
- **Tooling built** (`ghostwire/akamai/`): `m1_compose.py` (static arg trace), `m1_pre.py`/
  `m1_final.py` (value-matched producer enumeration — robust to per-delivery name rotation),
  `m1_deep.py` (recursive forwarding-chain resolver). Approach that works: instrument
  `beforeScriptExecution`, on the big `bmak` script set breakpoints at every assignment matching the
  producer skeleton `VAR=<id>()[<id>(...)].call(null,…)[m](e)`, evaluate each RHS in-frame, and match
  the one whose value == live section0 (don't rely on the rotating var name).
- **Strong GO signal:** the script calls **no** entropy/time APIs — `Math.random`, `Date.now`,
  `getRandomValues`, `crypto`, `performance.now` all count **0**. So section0 cannot embed client
  randomness/time → it is deterministic from fingerprint/static inputs (consistent with: session-
  stable, varies only with `bm_sz`; the script's SHA-256 hashes device sub-fingerprints — voices,
  canvas, `chrome` keys, small numbers).
- **The blocker (why it's hard, not impossible):** section0's value is wrapped in layers of
  obfuscation and ultimately produced **inside a control-flow-flattened VM**. Resolved chain for one
  delivery: `rg9 ← ''.concat(getter) ← getter returns wq9 ← wq9 = Nj(...)` where
  `Nj = function(a,b,c,d){return KQ9.apply(this,[q9,arguments]);}` — i.e. a dispatch into the flattened
  interpreter `KQ9` with case tag `q9`. The real inputs live in the inner VM frame (sibling scopes,
  not reachable from the producer frame). Byte-exact reproduction needs **lifting the VM** (the repo
  root decompiler is the right tool) or capturing the preimage at the deepest compute point — not a
  few more breakpoints.
- **Verdict:** GO-feasible in principle (deterministic), but M1 is a **VM-lifting effort**, not a
  quick capture. Pragmatic product remains the **harvester** (this file's "Honest scope" + 
  `capture/README.md`) until the VM lift lands. Offline acceptance also still faces the timing/
  session-age rejection the project already observed.

### M1 crypto primitives pinned (session 2, `m1_prims.py`)
- bmak sensor script (IhaVgB, ~541KB) contains **standard SHA-256** (IV `0x6a09e667…` + K-table
  `0x428a2f98…` at col ~220643; the digest fn is `nmw=function(PEw){var tlw=[K...];…}`) and
  **MurmurHash3** (`cc9e2d51`/`1b873593`). No std base64 charset / btoa / CryptoJS / crypto.subtle
  → base64 alphabet is obfuscated/dynamic. section0 is 32 bytes ⇒ **SHA-256**, not Murmur (Murmur =
  4-byte field hashes).
- The SHA-256 fn, hooked at init (`m1_init.py`/`m1_init2.py`), fires for **leaf sub-fingerprints**
  only — speech voices (len 653), canvas data-URL (~24KB), `chrome` keys `"loadTimes,csi,app"`,
  small numbers (`101901`,`356`). **None** base64s to section0 ⇒ section0 = `base64(SHA-256(
  AGGREGATION))` where the aggregation (concatenation of leaf digests/fields) is assembled **inside
  the KQ9 CFF VM** and is NOT one of the leaf calls.
- **Concrete next step (no full VM lift required):** capture the **aggregation** — either (a) widen
  the SHA-256 hook to capture array/WordArray inputs and dump EVERY call's input *and* output (digest
  bytes) so the call whose `base64(output)==section0` is found and its input = the preimage; or (b)
  hook the obfuscated base64 encoder (find the fn that returns the 44-char section0 string; its input
  is the 32-byte digest) and walk one frame up to the SHA-256 finalize. Then map the preimage
  composition to `input.json`/device-profile fields, reimplement `sensor/section0.go`
  (`crypto/sha256` + the custom base64 alphabet), and `gw_verify` bit-exact.

### M1 SHA-256 confirmed STANDARD + section0 model (session 2, `m1_hashret.py`)
- **Captured the SHA-256 return** by breakpointing the digest fn's `return [H0>>24&0xff,…]` site
  (returns 32 big-endian bytes). For every captured leaf, **`hashlib.sha256(input) == digest`
  exactly** → the script uses **textbook SHA-256** (no modified IV/constants). section0 base64-decodes
  to 32 clean bytes ⇒ **standard base64** alphabet. So both primitives are trivially reproducible in
  Go (`crypto/sha256` + `encoding/base64`).
- **Model (high confidence):** `section0 = base64( SHA256( AGGREGATION ) )`. Leaf inputs hashed at
  init = device sub-fingerprints (speech voices ~653 chars, canvas data-URL ~24KB in the AXUmFS
  script, `chrome` keys `"loadTimes,csi,app"`) + **session-varying numbers** (`73508`,`101901`,`356`
  — change per load, the source of section0's per-session variation). `section0` is NOT any single
  leaf digest, nor a simple concat/xor/join of the 2–4 leaves captured so far.
- **The one remaining unknown = the AGGREGATION formula** (order + which leaves/fields + separators),
  computed inside the `KQ9` CFF VM. To get it: capture **every** SHA-256 (input→digest) across BOTH
  akamai scripts in one session (widen window + interaction; note the digest fn rotates location per
  delivery — find it via the `6a09e667` IV each run), plus the final aggregation call; then the
  call whose `base64(digest)==section0` yields the exact preimage bytes → map to fields → implement
  `sensor/section0.go` → `gw_verify`. This is the precise, bounded continuation (not a full VM lift).

### M1 aggregation narrowed (session 2, `m1_allhash.py`) — still the open piece
- Comprehensive capture (both scripts, all SHA-256 finalizes via the `6a09e667` IV, ~60s + mouse):
  exactly **4 leaf SHA-256 calls** fire at init — voices(653), canvas data-URL(~24KB),
  `chrome` keys `"loadTimes,csi,app"`(17), and **one per-session number** (`35247`/`28241`/… varies).
  All verified `hashlib.sha256(input)==digest`.
- **section0 is NOT** any leaf digest, and NOT a match for brute-tested combines of the 4 digests
  (xor of every subset; concat permutations `[:32]`/`[-32:]`; `sha256(concat)`, `sha256(concat hex)`,
  `sha256(concat b64)`; add-mod-256). So the combine is something else (8-bytes-per-digest splice,
  interleave, Murmur mix, or includes non-hashed fields like UA/screen/bm_sz) **or** there is a 5th
  aggregate hash whose finalize my `return`-site bp missed (it only breaks at body-depth-0 returns;
  a return nested in a block is skipped — FIX: capture at function ENTRY and compute the digest in
  Python, since SHA-256 is standard, to enumerate ALL calls reliably).
- **Strong new constraint:** section0 stayed byte-identical (`X6s0ROTa…`) across runs where the
  per-session number changed → **the number digest is NOT in section0**; section0 is built from the
  **stable** fingerprints (voices+canvas+chrome-keys), so it is device-stable, not session-keyed as
  earlier thought (earlier cross-run variation was likely different bm_sz/canvas in non-headless).
  This is GOOD for offline: a fixed device profile → fixed section0.
- **Best next move:** hook the **base64 encoder** (the fn returning the 44-char section0 string; no
  std charset literal, so locate it by the value — at init, breakpoint candidates returning a string
  `==` the eventual section0, or search source for 6-bit `>>`/`&63` arithmetic) to grab the **raw 32
  pre-encode bytes**, then identify which fingerprint-digest operation yields exactly those bytes.
  That collapses the VM aggregation to a concrete byte recipe.

### Session 2 — assembler closure located (`m1_consumer.py`): stepOut from sha256 → consumer
- Stepping out of the SHA-256 fn lands in the **sensor assembler closure**. Dumping its scope reveals
  (names rotate per delivery; values from one run):
  - section0 sits there as a closure string var (e.g. `FvJ = 'zX6W6S7oc/…KcNo='`, 44-char). It is
    **already computed and forwarded** here (the VM produced it upstream) — so this frame consumes,
    doesn't compute it.
  - **`MJT = 'C98BE3D766BC149BA1EDD4AE0C58DBEE'`** — a 32-hex (16-byte) value (device-ID/abck-like).
    Tested: section0 ≠ base64(sha256(MJT)) in any form, and MJT ≠ either half of section0_raw. Separate
    field, not section0's preimage.
  - **M3 WIN — the field permutation key is here:** `gfJ` grows `'h+g+b+i+c+l+j+k+a+'` →
    `'h+g+b+i+c+l+j+k+a+f+e+'` as fields are appended. This is the `ajt/fct` transposition order
    (RE_STATE M3) captured live — the order to lay out the `name→value` field grid.
  - Other carriers in-scope: `n6J='EY7ibLpDiaDXXQS5S7'` (script path token), event-name constants
    (`PAGE_FOCUS`/`PAGE_BLUR`/`aj12_lock`), field arrays (`Array(127)`, `Array(24)`, `Array(7)`),
    and `KJT` locals like `'do_en,dm_en,t_en'` (feature flags).
- **section0 status:** device-stable, computed inside the `KQ9` CFF VM, forwarded to the assembler.
  Cracking its exact byte recipe still needs VM tracing (hook the `KQ9` dispatcher, filter returns ==
  the 44-char section0 / its 32-byte array, capture that invocation's args), OR accept **capture-per-
  script-version** (section0 is stable for a given device+script, so harvest it once per rotation and
  reuse offline). The latter sidesteps the VM lift.
- **⚠ Overriding strategic caveat (already in this repo):** `capture/README.md` records that probing
  proved **only fresh unmodified browser bodies pass; every offline edit is rejected on timing-vs-
  session-age**. A fully-coherent from-scratch synthesis was never testable (RE incomplete), so offline
  acceptance remains unproven and the evidence leans against it. Cracking section0 + M2–M5 does NOT
  guarantee a passing offline sensor until the timing model is solved and verified live.

### Session 2 FINAL — section0 is computed inside a register-VM (the real blocker), `m1_inspect.py`
- **section0 is SESSION-VARIABLE** (saw `X6s0…`, `zX6W…`, `pKIEbH…` across runs) — earlier "device-
  stable" was a 2-run collision. So it embeds a per-session input; for offline it must be one we
  receive (`bm_sz`/`_abck`). ⇒ it cannot be "captured once and reused"; it must be COMPUTED.
- **Decisive structural finding:** the script is a **register-based state-machine VM**. Every
  primitive step is a tiny method that mutates `this` and sets the next state: e.g. MurmurHash3 steps
  `function wb(){this.c=(this.c&0xffff)*0xcc9e2d51+(((this.c>>>16)*0xcc9e2d51&0xffff)<<16)&0xffffffff;
  this.WG=<next>;}` (and the `0x1b873593` step). `this.c` = hash accumulator, `this.WG` = state
  pointer. The `Nj→KQ9.apply(this,[tag,arguments])` forwarders are the dispatcher. So section0 is a
  **sequence of VM state transitions**, NOT a hookable function — which is why every hook lands on a
  forwarder/getter, and why no single sha256/combine reproduces it.
- **Confirmed reusable for the Go port:** primitives are standard — **SHA-256** (textbook, hashlib-
  exact), **MurmurHash3 x86-32** (`cc9e2d51`/`1b873593`, stateful `this.c`), **standard base64**.
  Implementing these in Go is trivial; the unknown is purely the VM's orchestration of them.
- **Realistic path (no quick hook exists):** lift the VM. Either (a) use the repo-root **static
  decompiler** (it exists precisely for "Akamai's stack-based antibot VM"; check whether the
  `KQ9/WG` register-VM matches its opcode model, feed it the captured script), or (b) systematically
  trace the `KQ9` dispatcher: log `(tag → state transitions → this.c / outputs)` for the section0
  build path. Both are multi-session VM-RE efforts.
- **Concrete progress banked this session (reusable regardless):** M3 permutation key captured
  (`gfJ='h+g+b+i+c+l+j+k+a+f+e+…'`); assembler closure + 16-byte device-ID (`MJT`) located; primitives
  pinned; robust capture tooling in `ghostwire/akamai/m1_*.py`.
- **Bottom line:** a pure-offline section0 (hence a fully-offline accepted sensor) is a **VM-lift
  project**, not completable by ad-hoc hooking, and still gated by the timing-rejection wall even
  after. Honest recommendation unchanged: the **harvester** is the only path that yields valid
  sensors today; offline requires the VM lift + solving timing, with material risk it still fails.

### Session 2 — VM-lift tooling scoping (decisive: two separate obfuscation layers)
- **The repo-root decompiler ([decompiler.js]) targets a DIFFERENT field, not section0.** Its input
  `script/bytecode.txt` decompiles (`output/ak.js`) to routine `_Lq`: a per-session token built from
  `navigator.userAgent` + `bmak.startTs` via a **DJB2** hash (`5381; h*33^c`) and a char-select
  alphabet `"a3cd9efghiYjklm7opqrs1uvwQxyBz2"`. That is a stack-VM bytecode program. **section0 uses
  native SHA-256** (not DJB2) ⇒ section0 is NOT this stack-VM program.
- **Two layers exist:** (1) a **stack-VM** (base64 bytecode → the decompiler handles it; produces the
  `_Lq` token), and (2) the **native-JS CFF** state machine (`KQ9/WG`, native SHA-256+Murmur) where
  section0 is computed. The decompiler only addresses layer (1).
- **Bytecode is NOT statically embedded** (no ≥200-char base64 literal in `script.js`) and **not via
  `window.atob`** (live `gw_hook` on atob → 0 calls) — the VM uses a **custom base64 decoder**. So
  extracting any new stack-VM program needs hooking that custom decoder (closure-scoped, obfuscated)
  or a network capture; how the prior session obtained `bytecode.txt` is undocumented.
- **Therefore section0's lift = de-flattening the native CFF (layer 2), the harder path.** The gofast
  **deobfuscation pipeline** (`myflow/gofast/pipeline/`, mirrors `babelflow/steps/`) is the intended
  tool but is **incomplete** — only step01 (beautify) is real; steps 02–05 (decode-hex, inline-ops,
  fold-constants, simplify-members) are stubs/partial (`pipeline.go` comment). Completing those
  passes to de-flatten `KQ9/WG` and make the SHA-256 orchestration readable is the concrete (large)
  next effort. Then map section0's preimage → fields → `sensor/section0.go` → `gw_verify`.
- **Realistic effort:** multi-session. section0 alone needs either a working CFF de-flattener (extend
  the gofast pipeline) or a runtime taint/VM-state trace of the `KQ9` dispatcher. Both are projects.
  The timing-rejection wall still gates the end result regardless.

### Session 2 — CONCLUSIVE: the needed de-flattener does not exist yet
- Checked every deobfuscation asset: root `decompiler.js` = the *other* stack-VM; `myflow/babelflow/
  steps/01-05` (the JS reference the gofast Go pipeline mirrors) implement only **surface passes**
  (beautify, decode-hex, inline-operators, fold-constants, simplify-members). A repo-wide grep for
  flatten/dispatcher/state-machine de-flattening passes returns **nothing**. `out/05-simplified.js`
  (=`script.final.js`, 14k lines) is still control-flow-flattened.
- ⇒ To read section0's orchestration (the `KQ9/WG` native CFF), someone must **write a control-flow-
  unflattening pass** (resolve the `WG` state-transition graph back into structured control flow).
  This is the genuine, novel, large piece — not present in babelflow or gofast, and the real cost of
  "option 1: full VM lift." Estimated multi-week research/eng effort; still gated by timing afterward.
- Practical fork recorded for the next session: (A) commit to building the CFF unflattener (big), or
  (B) accept the harvester (works today). Pure-offline = (A) + solving timing.

### Session 2 — path A chosen; grounded by babelflow's prior analysis (KEY context)
- **Cross-referenced `myflow/docs/03-inline-string-accessors.md`, `docs/04-sensor-data-pipeline.md`,
  `myflow/babelflow/generator/FINDINGS.md`** — the babelflow team already mapped this script deeply:
  - section0 = **base64 of 32 bytes = SHA-256 digest of CLIENT-SIDE inputs, no server secret**
    (FINDINGS). Primitives: SHA-256 `vx` (~line 1785), MurmurHash3 `pYU` (~6103), std base64. The VM
    dispatcher is `S9/Dz switch(OI)` with `return S9.apply(this,[CASE,arguments])` wrappers = the live
    `KQ9`. All matches my session-2 findings.
  - **The binding blocker = per-family string decoders** (`vCU/UmU/Ct/IC`), seeded by a reversed
    self-hash `B()=122783220 − murmur3(self_source,875960)`. They only decode correctly **in
    authentic runtime order with a live Akamai challenge**; local harnesses reach ~29/5127 sites
    (coverage). **We have authentic-runtime capture (ghostwire) the babelflow team lacked.**
  - ⚠ The babelflow-analyzed script is described as the **SBSD/x-token orchestrator**, while our
    section0 lives in the **classic sensor_data POST** script — verify they're the same delivery or
    sibling before trusting line numbers; the *mechanisms* (decoders, vx, pYU, S9) are common.
- **Approved plan = `~/.claude/plans/clever-sparking-grove.md` Part B:** B1 authentic-runtime decoder
  dump → B2 read section0 recipe (+ GO/NO-GO) → B3 reimplement `sensor/section0.go` + `gw_verify`.
- **B1 finding (this session):** decoder emits **one char at a time via `String.fromCharCode`**
  (12,485 single-arg calls; 0 multi-arg) → a global `fromCharCode` hook is too noisy. Correct capture
  = hook each per-family **decoder return / cache-write** (`BASE()[key]=()=>str`) by **location
  breakpoint** (BASE objects are closure-scoped, not global). Decoded strings are also readable as
  **closure variables** in the assembler/dispatcher frames (the `m1_consumer.py` step-out approach
  already surfaced `PAGE_FOCUS`/`aj12_lock`/the `gfJ` permutation key/`do_en,dm_en,t_en`). Next:
  build `ghostwire/akamai/decoder_dump.py` = step-out/scope-dump across dispatcher cases to harvest
  the decoded string table in authentic order, map to sites by ordinal.
- **B1 v1 done (`decoder_dump.py`):** heap-snapshot the authentic runtime after the sensor flow and
  dump all readable string nodes → `ghostwire/akamai/decoded_strings.txt` (**188,740** unique
  strings). Confirms real akamai decodes are present: `get_telemetry`, `startTs`, `/.well-known/sbsd`,
  `cookey._abck`, `cookey.bm_sz`, `/akam/13/pixel_`, `getTelemetryHeaderForAutopost`,
  `extractAbckHeartbeatTimestamp`. **Limitation:** it's the WHOLE-page heap (zalando app +
  OpenTelemetry + akamai), so akamai's VM field-names are buried in ~180k unrelated strings.
  **Next refinement:** filter to strings whose `retaining_path` roots in the akamai script's closures
  (use `Snapshot.retainers`/`retaining_path`), or snapshot a blank control page vs the akamai page and
  diff, to isolate the ~hundreds of akamai-decoded strings (field registry `IzU`, property reads).
- **Honest scope reminder:** the string table is one half; reading section0's *byte recipe* also needs
  the **de-flattened control flow** (which fields → SHA-256, order, Murmur mixing). That CFF
  de-flattening pass is still unbuilt. section0 remains a multi-session VM-lift; B1 string-harvest
  pipeline is proven and is the foundation.
- **B1 v2 done — scope-isolated dump (`decoder_scope.py`):** anchor on section0's heap node, BFS the
  graph restricted to Context/closure nodes (the lexical scope chain) → **866** akamai-scope strings
  (vs 188k whole-heap) → `ghostwire/akamai/decoded_akamai_scope.txt`. Clean akamai artifacts surfaced:
  - **Field permutation key (M3): `f+d+a+l+i+h+j+e+c+b+k+`** (the transposition order; matches the
    WORKFLOW `d+c+g+…` `ajt/fct` form — captured live and clean).
  - SBSD challenge endpoint `/_sec/sbsd/challenge/challenge.html`; cookies `_abck`,`bm_sz`; methods
    `get_referrer`,`get_url`,`sendPixel`; **351 two-char decoder keys** (the doc-03 key space).
  - Only one 44-char base64 in scope = section0 itself → its leaf-digest inputs are NOT retained in
    the assembler scope (consumed transiently upstream in the VM), confirming the byte recipe needs
    control-flow recovery, not just string harvest. (BFS hit the 60k node cap → minor GTM/consent
    leakage; tighten depth/cap to reduce, but akamai signal is clear.)
- **Net B1 state:** decoded-string harvesting is solved (whole-heap + scope-isolated).

### Session 2 — B2 RE-FRAMED: section0 logic is VM BYTECODE; the existing decompiler applies
- **Major correction:** the `switch(this[Qd].pop())` in `out/05` is the **bytecode VM interpreter's
  operand stack**, NOT the sensor control flow. The sensor logic (incl. section0) is the **bytecode
  program** this engine executes. ⇒ **No from-scratch CFF de-flattener needed** — the repo-root
  `decompiler.js` already decompiles THIS VM's bytecode (it produced the readable `_Lq` from
  `script/bytecode.txt`).
- **VM instruction fetch identified:** `out/05:9604` `return this[Kn][this[Td][AH.e]++]`; in RAW
  `script.js` it's the **unique** `]++]` → `this[v0][this[kU][JV.x]++]`. So **`this[v0]` = the bytecode
  byte-array**, `this[kU][JV.x]` = the instruction pointer. (Slot names rotate per delivery; locate by
  the unique `]++]` each run.)
- **B2 plan (concrete):** `ghostwire/akamai/dump_bytecode.py` — instrument, find the `]++]` readByte in
  the live `bmak` script, breakpoint it, on first hit dump `this[<bytecodeSlot>]` as a byte array →
  base64 → run root `decompiler.js` on it → readable pseudo-JS of the whole VM program. Then locate
  section0's function (the one calling native SHA-256 `vx`/Murmur `pYU` over fingerprint data) and
  read its exact preimage recipe. Risk: current opcode set may differ from the decompiler's 35–39
  opcodes (bytecode.txt era) → may need opcode-table updates in `helper/opcodes.js`.
- Native crypto confirmed in `out/05`: SHA-256 schedule/padding (`<<24|…`, `fromCharCode(0x80)` @1287)
  and Murmur fmix multipliers (`0x85ebca6b`,`0xc2b2ae35`,`0x1b873593`,`0xcc9e2d51`) — the bytecode
  calls these natively.

### Session 2 — B2 bytecode extraction WORKS; decompiler opcode table is version-stale (the gate)
- **`ghostwire/akamai/dump_bytecode.py` works:** instruments, finds the unique `]++]` readByte,
  breakpoints it, dumps `this[<slot>]` = the bytecode byte-array. Captured **2101 bytes** →
  `ghostwire/akamai/bytecode_live.txt` (base64). (Slot/script path rotate per delivery; this run:
  slot `p3`, script `…/SrPVdo/lv/mf/rYj-/FK0p`.) **Re-runnable** to grab current bytecode anytime.
- **Decompiler runs but yields EMPTY on live bytecode.** Diagnosis: live entry opcode = **84**, which
  is **absent from `helper/opcodes.js`** (that table is the OLD version: 135/6/14/36/147/120/53/112/
  230/… + binops). Old `bytecode.txt` starts with 135 (handled) → decompiles to `_Lq` fine. ⇒ Akamai
  **remaps/extends the VM opcode numbers per script version** (the table is version-specific).
- **THE remaining task to read section0 (well-defined, sizeable):** re-derive the CURRENT opcode
  table from the CURRENT VM interpreter and update `helper/opcodes.js`, then decompile
  `bytecode_live.txt`. The interpreter is already de-obfuscated — it's the `S9/Dz` dispatcher in
  `myflow/babelflow/out/05-simplified.js` (operand stack `this[Qd]`, readByte at :9604). Map each
  `case <n>:` body → operation (push/pop/binop/call/jump/return/member/…) to rebuild the table.
  Then `node decompiler.js` → readable program → find section0's function (calls native SHA-256
  `vx`/Murmur `pYU` over fingerprint fields) → its preimage recipe → `sensor/section0.go` + gw_verify.
- **Maintenance reality:** because opcodes remap per version, the table (and captured bytecode) must
  be refreshed whenever the script rotates — an ongoing cost for a pure-offline generator.
- **Full path now mapped end-to-end:** capture bytecode ✅ → re-derive opcodes (next) → decompile →
  read section0 recipe → reimplement in Go → gw_verify → integrate. Still multi-session; no fakes.

### Session 2 — B2b started: matched capture + interpreter beautified; opcode map is the long pole
- **Matched-version capture (same live session):** `dump_bytecode.py` now also saves the script
  source. Artifacts (sibling repo `ghostwire/akamai/`): `bytecode_live.txt` (2101 B, entry opcode 84)
  + `script_live.js` (436 KB raw) + `script_live.beautified.js` (11,625 lines, via gofast `go run .`
  step01). Bytecode + interpreter are the SAME version → opcode semantics derivable from this source.
- **Bytecode loader found** (beautified `out/01-beautified.js:7070`): `vC = atob(qn); Yc[M]=
  vC.charCodeAt(i); gc=EU(gc,byte); … return Yc` = base64-decode `qn` → byte array + checksum `EU`
  (anti-tamper). readByte at `:7088` `return this[p3][this[qZ][cE.d]++]` (bytecode slot `p3`). (NB:
  the live `atob` hook earlier showed 0 calls — `atob` here is likely a local/aliased or pre-hook.)
- **The long pole (honest):** the current opcode numbers differ from `helper/opcodes.js` (entry 84
  unhandled). To re-derive, read this version's opcode-dispatch cases in
  `script_live.beautified.js` — but method/property names there are STILL decoder-hidden
  (`dD()[KI(x)]`, `this[PU]`), so it needs B1's decoded string table cross-referenced per case. That
  is a painstaking multi-day map of ~35-40 opcodes, and must be redone each script rotation.
- **Decision for next session:** either (a) push the opcode map (large, brittle to rotation), or
  (b) reconsider whether a *dynamic* lift (trace the VM executing the section0 path and log
  operand-stack effects) is cheaper than a full static opcode table. Both are real projects; section0
  remains gated on one of them. Artifacts above let the next session resume without re-capturing.

### Session 2 — B2b BREAKTHROUGH (dynamic): full opcode table dumped in one hit
- **Execute loop** (beautified `:7736`): `while(pc<bytecode.length){var op=this[readByte]();this[op](this);}`
  — **the opcode IS the method key on the VM**. So one breakpoint at the `this[op](this)` dispatch
  (where `this`=VM) + enumerate this's numeric-keyed methods = the whole table. Tool:
  `ghostwire/akamai/dump_opcodes.py` → **`opcodes_live.json` (53 handlers, full source)**. Version-
  proof: re-run per rotation. (Dispatch self-located via regex; raw offset 350193 this delivery.)
- **Operator aliases resolved** (`dump_helpers.py` → `helpers_live.json`, via `String(fn)` at the
  dispatch frame): `C`=`<<`, `ws`=`|`, `W`=`<`, `Ls`=`+`, `Ms`=`-`, `PJ`=`*`, `Ob`=`%`, `DC`=`>`,
  `Fb`=`>=`, `MJ`=`<=`, `lR`=`===`, `DI`=`!==`, `AV`=`!=`, `Hb`=`in`.
- **Opcode semantics (this version) now known**, e.g.: stack=`this[PC]`, popVal=`this[ZZ]()`,
  readByteOperand=`this[m5]()`, regs=`this[tl]`. op6 push(a<<b); op22 push(a===b); op28 push(typeof a);
  op51 push(a<=b); op61 push(a!==b); op72 push(a&&b); op81 push(a in b); op87 push(a>b); op117 push(a%b);
  op123 readStr; op131 build-array; op140 readByte; op146 nested-block-dispatch; op161 readInt(4-BE);
  op162 push(a+b); op183 build-object; op200 push(a*b); op219 push(a<b); op228 push(a-b); op234 push(a>=b);
  op97 getReg; op103 setReg; op10/118/226 box getter/setter cells; op237 throw; op1 atob-load.
- **Remaining (now well-defined IMPLEMENTATION, not discovery):** translate `opcodes_live.json` →
  a version-specific `helper/opcodes.js` (map each opcode number to the decompiler's symbolic lift)
  → `node decompiler.js` on `bytecode_live.txt` → readable program → find section0's function (calls
  native SHA-256/Murmur over fingerprint regs) → `sensor/section0.go` + `gw_verify`. The multi-day
  "unknown opcode map" risk is GONE — the table is captured; this is straightforward porting now.

### Session 2 — full opcode→operation decode (from `opcodes_live.json`) — port reference
- **Architecture:** numeric-keyed methods = either *program opcodes* (dispatched via `this[op](this)`)
  or *VM-internal methods* aliased by 2-char vars. Internal: `m5`=readByte(`op140`), `ZZ`=pop-resolve
  (`op111`), `dB`=readInt(`op161`), `tl`=registers (array), `Hp`=setReg/PC(`op103`), `PC`=operand
  stack, `Sp`/`10`/`226`=box-cell `{get u/set u}`, `118`/`DG`=member-box, `54`=unbox(`vJ`),
  `WS`=block-exec(`op146` `while(op!=K){this[op](this)}`), `op1`=atob bytecode loader (+`EU` checksum).
- **Program opcodes (decoded):** ctrl: `220`=goto(PC=readInt), `2`=branch(if cond PC=tgt),
  `247`=branch(if !cond), `173`=eof/halt(PC=[],ptr=end), `14`=call(byte res,self,argc; pop fn; build
  args; `fn.apply(LV.u,args)`), `11`=try/catch/finally(pop try/catch/fin ptrs), `245`=function-literal
  (closure over a block ptr), `237`=inc/dec(Proxy ++/--). leaf/stack: `6`<<, `22`===, `25`bool,
  `28`typeof, `31`*(coerce num), `34`push-read, `51`<=, `59`coerce, `61`!==, `72`&&, `81`in, `87`>,
  `117`%, `123`readStr, `131`build-array, `162`+, `165`push box(undef), `183`build-object, `184`
  push-global(this[G](name)), `200`*, `206`push-byte, `213`push-int, `219`<, `228`-, `234`>=, `239`
  push(this[T8]()), `242`get-member→box, `124`set-member(`bV`).
- **NB the new VM has a richer model than the old decompiler** (reference *boxes* via getter/setter
  cells + `unbox`; `op146` nested block-exec; `op245` function literals). Porting likely needs small
  `helper/cfg.js`/`structure.js` tweaks for boxes + block-exec, not just `opcodes.js`. This is the
  remaining engineering (iterative: write opcodes.js → decompile → fix model mismatches → repeat).
  Everything needed is captured in `opcodes_live.json`/`helpers_live.json`/`bytecode_live.txt`.

### Session 2 — DISCOVERY COMPLETE: all VM port inputs captured (`dump_consts.py`)
- **Constants captured** (`consts_live.json`): `js.Q`=156 (PC register index), **`js.K`=152 (block
  terminator / end-of-block opcode** — the `op146` block-exec runs `while(op!=152){this[op](this)}`),
  `js.j`=99, readInt shifts `z8/pG/c5`=24/16/8, `jV`=0, `Ql`=256. (Minor `c8`=0, `ql`/`HI` were out of
  that frame's scope — infer `c8`=0.) `TD`=[156,99,152,1022,1023] (reg indices).
- **All VM-port inputs now on disk in `ghostwire/akamai/`:** `bytecode_live.txt` (program, 2101 B),
  `opcodes_live.json` (53 handlers), `helpers_live.json` (operator aliases), `consts_live.json`
  (constants), `script_live.beautified.js` (interpreter for cross-ref). **No further browser capture
  needed for the port.**
- **Remaining = pure offline engineering (iterative):** author a version-specific `helper/opcodes.js`
  from the decode (operand byte-counts: e.g. goto`220`=4B int, branch`2`/`247`=1B kind+4B int+pop,
  call`14`=3B, push-byte`206`=1B, push-int`213`=4B, readStr`123`=2B len+chars; terminator opcode 152
  ends function/blocks; binops/leaf ops = 0 operand bytes) + likely small `cfg.js`/`structure.js`
  tweaks for the box (getter/setter cell) model and `op146` block-exec → `node decompiler.js` on
  `bytecode_live.txt` → readable program → locate section0 (native SHA-256/Murmur over fingerprint
  regs) → `sensor/section0.go` + `gw_verify`. Iterative: decompile → fix desyncs (wrong operand
  counts desync the pointer) → repeat until clean.
- **Status:** the hard RE (what the VM does) is fully cracked and on disk; what remains is writing
  the lifter and reading the result — bounded engineering, no more unknowns, no more browser needed.

### Session 2 — B2c iter: MATCHED single-capture solved; opcode numbers rotate → need a GENERATOR
- **Critical:** entry opcode went 135→84→79 across captures — **opcode numbers AND helper-alias names
  AND bytecode all rotate together every delivery.** So a hand-written `opcodes.js` is stale the next
  capture; bytecode + opcode-table MUST come from ONE matched capture, and the table must be
  generated, not hand-mapped.
- **`ghostwire/akamai/dump_vm.py`** = the matched-capture tool: breaks at the dispatch, and when the
  CURRENT VM instance's bytecode (slot parsed from `while(...this[SLOT].length)`) is large (>1000 =
  the sensor VM, not the small sub-VMs), captures in ONE hit: `this[SLOT]` (bytecode) + all numeric
  handler sources. Verified matched: **bytecode 2017 B, entry opcode 79, and 79 IS in the table.**
  Overwrites `bytecode_live.txt` + `opcodes_live.json` as a consistent pair.
- **First hand-written `helper/opcodes.js` attempt FAILED** because it used numbers from an earlier
  *unmatched* dump (entry 84) vs the bytecode (entry 79) — confirming the rotation-coupling. Original
  `opcodes.js` restored.
- **THE next step (B2c, well-scoped): write an automated generator** `opcodes_from_dump.js` that reads
  the matched `opcodes_live.json` (+ resolves operator aliases + VM-method aliases + consts, all
  captured in the SAME hit — extend `dump_vm.py` to also grab `helpers_live.json`/`consts_live.json`
  matched) and EMITS `helper/opcodes.js` by pattern-matching each handler body (`push(OP(pop,pop))`→
  binop; `Hp(Q,readInt)`→goto; `if(cond)Hp(Q,int)`→branch; `PC=[];ptr=end`→eof; sentinel 152→return;
  readByte/Int/Str; call/try/function). Then `node decompiler.js` on the matched `bytecode_live.txt`
  → readable program → section0. The generator makes the whole flow re-runnable per rotation.
- **Net:** discovery 100% done + matched-capture tool working; remaining = build the generator
  (parse 53 handler patterns) → decompile → read section0 → Go. Bounded, offline, iterative.

### Session 2 — `vm_bundle.py`: complete matched bundle captured (generator input ready)
- **`ghostwire/akamai/vm_bundle.py`** → `vm_bundle.json`: ONE matched sensor-VM capture =
  bytecode_b64 (1994 B, entry op 79) + all 53 opcode handler sources + 47 resolved symbols.
  **Operators fully resolved** (this delivery's names): `Jr`<<, `gf`+, `hA`-, `XU`*, `rC`%, `cD`<,
  `Jv`>, `LU`<=, `Tr`>=, `hw`===, `Or`!==, `GV`==, `Qq`!=, `Vn`^, `Nw`|, `Xt`in, `bF`!(unary),
  `jD`-(unary); `Wf`/`cA`/`hO`/`kC`=`cN()[x]` string-decoder accessors.
- **Remaining gap before the generator:** the ~18 `this[X]` VM-method slots (readByte/pop/stack/
  setReg/readInt/readStr) resolved to `undefined` — their slot *vars* are in the VM-construction
  closure, not the dispatch frame. Fix: in `vm_bundle.py` phase 2, `Debugger.stepInto` a handler and
  eval the slot vars there (in scope), OR identify each by body pattern (the `.push/.pop` slot =
  operand stack; the `return this[B][this[P][k]++]` op = readByte; etc.). Then ALL symbols matched.
- **Then build `opcodes_from_dump.js`** (offline): consume `vm_bundle.json`, pattern-match each
  handler body (binops via resolved operators; goto/branch/eof via the setReg-PC pattern; readByte/
  Int/Str; call/try/function/member/array) → emit `helper/opcodes.js` → `node decompiler.js` on the
  matched `bytecode_live.txt` → readable program → section0. Re-runnable per rotation.
- **Honest state:** all RE discovery done + complete matched bundle on disk (operators resolved);
  remaining = resolve the method-slots (1 small capture tweak) → write generator → decompile + debug
  (box/block-exec model) → read section0 → Go reimpl → then M2–M5 + timing. Bounded engineering.

### Session 2 — `vm_bundle.py` v2: method-slots RESOLVED → matched bundle 100% complete
- Added a phase-3 `Debugger.stepInto` into a handler so the VM-construction closure vars are in
  scope; resolving slot-vars as bare names yields their numeric keys. **All slots resolved** (names
  rotate per delivery; one capture's mapping): `sr`=readByte (`this[t][this[q2][PC]++]` ⇒ `t`=bytecode
  array slot, `q2`=registers array slot), `Kr`=readInt (OR of shifted bytes), `p0`=readStr,
  `h2`=setReg(`this[q2][i]=v`), `J2`=pop-resolve, `Q2`=unbox, `AD`=block-exec(`while(op!=K1.W)
  this[op](this)`), `q1`/`mn`=box getter/setter cells, `bY`=set-member, `r1`=atob loader.
- ⇒ **`vm_bundle.json` is the COMPLETE, matched generator input**: bytecode_b64 + 54 opcode bodies +
  operators + method-slot meanings + consts, all one version. NO more browser capture needed to build
  the decompiler for this version (re-run `vm_bundle.py` per rotation to refresh).
- **THE next build = `opcodes_from_dump.js`** (pure offline): consume `vm_bundle.json`; for each
  opcode body, substitute slot/operator meanings and pattern-match → emit `helper/opcodes.js`:
  stack slot = the `.push/.pop` slot; `push(OP(pop,pop))`→binop; readByte/readInt/readStr→push lits;
  setReg-PC writes→goto/branch; block terminator (K1.W)→return; call/try/function/member/array. Then
  `node decompiler.js` on matched `bytecode_live.txt` → readable program → section0 fn (native
  SHA-256/Murmur over fingerprint regs) → `sensor/section0.go` + `gw_verify`. Iterate on box/
  block-exec model in `cfg.js`/`structure.js` as needed.
- **Bottom line:** discovery is DONE end-to-end; the matched VM bundle is fully captured and resolved.
  Remaining is the generator + decompile-debug + section0 read + Go port (then M2–M5 + timing) —
  all offline engineering, no unknowns left in the VM itself.

### Session 2 — `opcodes_from_dump.js` generator: pipeline works end-to-end; iterative refine left
- **`Akamai-VM/opcodes_from_dump.js`** (offline, re-runnable): reads `vm_bundle.json`, derives the
  per-version meanings (STACK=most `.push` slot; operators from symbol fn bodies; readByte/readInt/
  readStr/setReg/pop slots by op-body pattern; PC index from readByte body), then emits
  `helper/opcodes.js`. **Robustness rule:** each opcode emits the exact operand-byte reads its body
  performs so the pointer stays synced.
- **Verified end-to-end:** generator runs (derived STACK=HD, readByte=sr, readInt=Kr, readStr=p0,
  setReg=h2, operators all mapped), writes 54-opcode `opcodes.js`, `node decompiler.js` executes on
  the matched `bytecode_live.txt` and entry op79 lifts correctly as `goto readInt → offset 411`.
- **Current gap = coverage:** the first generator classifies only ~10 opcode patterns (binops,
  push-byte/int/str, goto, branch, eof); the other ~44 emit placeholders whose best-effort operand
  counts are sometimes wrong → desync + unreadable output. **Next = extend the generator to lift ALL
  54 opcodes** with exact operand encodings (member/box get+set, call, function-literal `op245`-style,
  array `op131`, object `op183`, register load/store, the block-terminator → return). All 54 bodies +
  meanings are in `vm_bundle.json`; this is a bounded iterative loop: extend generator → decompile →
  fix the next desync/placeholder → repeat until the program reads cleanly, then locate section0.
- **Honest status:** full pipeline now exists (capture→bundle→generator→decompiler runs). Remaining
  is iterative generator refinement to a clean decompile, then read section0 → Go → M2–M5 + timing.
  Repo `helper/opcodes.js`/`bytecode.txt` restored to originals; generator + `vm_bundle.json` are the
  live B2c artifacts (regenerate `opcodes.js` on demand).

### Session 2 — DECOMPILER WORKS: clean readable VM JS out of the live bytecode 🎯
- `opcodes_from_dump.js` extended to lift all the real opcode classes (binops incl unary/typeof/&&/||,
  push byte/int/str, goto, branch (1B keep + 4B int), eof, get-member box, set-member, call (3B
  res/self/argc), build-array, build-object, function-literal (recursive lift), try/catch/finally,
  and **block-exec op61 = no-op so its inline body lifts sequentially**; block terminator shows as a
  harmless `unknown op` that ends the block). Run: `node opcodes_from_dump.js && node decompiler.js`.
- **Result (`output/ak.js`, ~195 lines, near-zero placeholders):** clean structured JS with DECODED
  globals/props. The decompiled program is the **device-fingerprint / automation-detection collector**:
  `navigator.plugins` enumeration (enabledPlugin/refresh bot-tells), `SharedArrayBuffer`/
  `crossOriginIsolated`, `Object.getOwnPropertyDescriptors(navigator)` keys joined, `document.location`
  host/origin checks, `Math.random` probes. `g("x")` = decoded global/property access.
- **So the toolchain is proven**: live akamai VM bytecode → readable JS, offline, re-runnable per
  rotation (re-run `vm_bundle.py` then the two node steps). Remaining placeholders to tidy: op50
  (terminator → map as return for cleanliness), op65/op110/op230 (rare; classify).
- **Next for section0:** THIS program collects fingerprint signals but does NOT assemble section0
  (no SHA-256/concat here). Find section0's code path — either (a) decompile the OTHER VM programs
  (capture each VM instance's bytecode via `dump_vm.py` gated on different sizes / multiple hits) and
  find the one calling native SHA-256 (`vx`) + base64 over the collected signals, or (b) the assembly
  is native (the `rg9`/`wq9` producer chain) fed by these VM signals. Then read the recipe →
  `sensor/section0.go` + `gw_verify`.
- **Milestone:** went from "is offline feasible?" → a WORKING offline decompiler of the current
  akamai VM. section0 recipe is now a matter of pointing this tool at the right program/path.

### Session 2 — `vm_all.py`: 16 VM programs captured + decompiled; section0 assembly NOT among them
- **`vm_all.py`** captures every distinct VM bytecode program in one session (all share one opcode
  table) → `prog_NN_lenL_eE.txt` (16 programs, 214–1986 B) + matched `vm_bundle.json`. Driver:
  regenerate `opcodes.js`, loop `node decompiler.js` over each → `Akamai-VM/out_progs/*.js`.
- **All 16 decompile cleanly to fingerprint/BOT-DETECTION signal collectors** (each stores a result
  into a `signals` object): navigator.plugins behavior, `Document.prototype.hasPrivateToken`,
  `File.prototype` "path" + `() { [native code] }` native-code tamper check, `HTMLIFrameElement`
  loading descriptor, `Object.getOwnPropertyDescriptors(navigator)`, location host/origin,
  SharedArrayBuffer/crossOriginIsolated, KeyboardEvent/MouseEvent presence. `prog_03` (entry 89) is a
  per-signal rolling hash `h = (h*31) % 1234567 + char`.
- **section0's assembly is NOT in these 16** (no SHA-256/base64/`;`-join aggregation). They are the
  *inputs*; section0 (= base64(SHA-256(aggregate))) is built either by an **init-time orchestrator
  program I missed** (ran before/around dispatch-bp arm) or by **native code** (`vx` + base64) reading
  the `signals` object. Next hunt: (a) capture programs from the very first dispatch hits (arm ASAP,
  no dedup-drop of early ones), or hook the moment section0's known value materializes; (b) if native,
  decompile is moot — read the native `vx`/assembly via the beautified script + the decoded `signals`.
- **Honest big-picture:** delivered a working offline VM decompiler + mapped the bot-detection
  surface (real RE value). But section0 itself is still uncracked, and beyond it M2–M5 + the timing
  wall remain — a fully-accepted offline sensor is still substantial multi-session work. The decompiler
  is the force-multiplier that makes the rest tractable.

### Session 2 — hunt CONCLUSION: section0 is JS-CFF-assembled, not bytecode-VM, not a simple hash
- Re-ran the comprehensive SHA-256 boundary capture (`m1_allhash.py`) with full context: **5 leaf
  sha256 calls** fire (speech voices, canvas data-URL, `chrome` keys `"loadTimes,csi,app"`, two
  per-session numbers). **section0 is NOT any of those digests, NOT base64(sha256(single input)), and
  NOT a brute-tested combine** (xor of subsets / concat perms `[:32]`/`[-32:]` / sha256(concat|hex|b64)
  / add-mod) of the 5 leaf digests. Confirmed across sessions.
- **Conclusion (the wall, precisely located):** the bytecode VM only *collects* signals (16 programs,
  all decompiled = fingerprint/bot tests). section0 is assembled in the **JS control-flow-flattened
  layer** (`S9`/`KQ9` dispatcher) by a non-trivial combination of the leaf hashes + `signals` +
  per-session data, calling native SHA-256/base64. That JS-CFF layer is the ORIGINAL hard blocker.
- **Cheaper paths are now exhausted:** direct sha256-boundary capture (done, no match), simple-combine
  brute force (done, no match), bytecode-VM decompile (done, it's just collectors). What remains to get
  section0's exact byte recipe is the expensive option: **(a) build a JS-CFF de-flattener** for the
  `S9` dispatcher (large — this is the from-scratch unflattener the project never had), or **(b) a deep
  targeted dynamic trace** of the exact `rg9`/`wq9` producer path stepping through the CFF VM and
  logging each state's effect on the value (also large; `m1_deep.py` showed it bottoms out in
  `S9.apply(this,[tag,args])` dispatch).
- **Net honest status:** the VM bytecode is fully cracked (decompiler works) but section0's specific
  assembly sits in the JS-CFF layer that requires the big de-flattener or a deep producer trace — the
  same hard problem flagged at session start, now precisely scoped and with the bytecode-VM and
  crypto-boundary avenues definitively ruled out.

### Session 2 — JS-CFF de-flattener (chosen path) SCOPED
- The CFF is **30 flattened dispatcher loops** in `script_live.beautified.js` of shape
  `while(ss) switch(STATE[next]=STATE[cur]){ case LABEL: ...; break; }`. **The state slots, case
  LABELs, and next-state values are all decoder-hidden** (`Vr()[D(NN)]`, `ff()[VA(Y5)]`, `N3(Es)`),
  so the state-machine's labels AND transitions are obfuscated. No `X.apply(this,[CASE,arguments])`
  forwarders this delivery — dispatch is inlined per-function.
- **A static de-flattener therefore needs ALL of:** (1) the matched decoder string/value table fully
  solved (B1, same session) to resolve state keys + case labels; (2) opaque-predicate evaluation
  (`xK(typeof X, Lr(...))?:` ternaries, `NH/Lr/N3` wrappers) to pick branches; (3) per-loop CFG
  reconstruction from the resolved state transitions; (4) re-emit structured control flow. Times 30
  loops, rotation-coupled. This is a genuine **multi-week research build**.
- **More tractable variant for section0 specifically (recommended):** a **dynamic producer-trace** —
  run live, breakpoint the ONE flattened loop that produces section0 (the `rg9`/`wq9` assignment's
  enclosing function), and log the state-transition sequence + each case's effect on the value, so
  section0's specific computation is reconstructed from a real run (no need to de-flatten all 30 or
  fully solve the decoder). Leverages the working live-capture tooling.
- **Honest verdict:** committing to offline section0 = committing to one of these (static de-flattener
  ~weeks, or a focused dynamic producer-trace ~still substantial), then M2–M5 + the timing wall. The
  bytecode-VM decompiler delivered this session is reusable foundation, but section0's CFF assembly is
  the project's hardest remaining piece and is not close. Recommend the dynamic producer-trace next.

### Session 2 — producer-trace step 1 (`producer_trace.py`): section0 INGREDIENTS identified 🎯
- Heap-snapshot → find section0's node → BFS its Context/closure scope chain → dump all string/number
  vars = **the section0 producer's lexical scope (the sensor assembler)**. ~150 vars. Confirmed
  section0 sits there (e.g. vars `mI`==`n72`==section0 this run = `OVe7/zst…`).
- **section0's candidate ingredients (all in scope):** a **16-byte device-ID** (`sA2`, e.g.
  `41B66E7A55CEB4D5C2C3F0197F2BC74D`); the **voices SHA-256 digest in hex** (`l42`=`3f38b25f…c343`);
  a likely **salt/key constant** `OKK`=`d3ijd93jkij9idw3khuw`; memory/timing numbers
  `xQ2`=`4395630592,107465513,69189973,50,24`; the **92-char cipher alphabet** (`zv2`); **both
  permutation keys** (`Lj2`/`Mk1` = `l+e+i+g+h+j+d+f+k+b+a+c+`); behavioral CSVs (`XX2`,`Uf2`,`jY2`,
  `mKK`,`wX2`); cookie names (`bm_sz`,`_abck`,`TAB_ID`,`ak_a`/`ak_ax`,`bmint_`); script+page URLs;
  version `10.00`; session ids (`gm2`=`mqsap3lprq0f0`).
- **Transform is NON-standard:** brute-forced sha256 over single/pair/triple combos (string + bytes,
  seps, with `OKK` salt) of the obvious device fields → **no match**; and `m1_allhash` proved
  section0 is not among the 5 captured `vx` SHA-256 outputs. ⇒ section0 uses a different/custom hash
  or an alphabet-based transform inside the producer function (which has the cipher alphabet in scope).
- **Next (targeted producer-trace):** breakpoint exactly where section0's var (`mI`/`n72`-equiv) is
  ASSIGNED in the CFF producer and capture the precise preimage + transform — that one function is the
  whole recipe (no need to de-flatten all 30 loops). Find the var via heap in-session, then arm a
  location breakpoint at its assignment (instrument `beforeScriptExecution`; section0 builds once at
  init). This is the concrete next move; the ingredient set above bounds what the preimage can contain.

### Session 2 — producer-trace step 2: section0 transform CONFIRMED inside the CFF dispatch
- The section0-holder var names from the heap (`mI`/`n72`/`Gn1`) do NOT all exist in the saved
  `script_live.beautified.js` even though the URL path is the same `SrPVdo` — **the per-delivery
  obfuscation (var names) rotated** between saving the beautified source and the runtime captures.
  So the beautified source is stale vs the live runtime: any source-based trace must be a FRESH
  matched single-session capture (re-beautify the live source the same run).
- **Confirmed (consistent with `m1_deep`):** section0's var resolves through forwarders to
  `wq9 = Nj(...) = S9.apply(this,[tag,arguments])` — i.e. **section0's actual transform is a CASE
  inside the CFF dispatch**, not a plain assignment. So reading it = de-flattening that one dispatch
  case (the targeted de-flattener), OR a dynamic step-trace through the dispatch logging the value's
  evolution. The transform is custom (NOT the `vx` SHA-256; no simple combo of the device ingredients).
- **Definitive state of the hunt:** section0's complete INGREDIENT set is identified (device-ID,
  voices digest, salt const, alphabet, perm keys, behavioral/timing, URLs, cookies) and its transform
  is localized to a single CFF-dispatch case — but extracting the exact transform requires the
  de-flattener / deep dispatch-trace (the multi-week piece), which remains the gate. Easy avenues
  (sha256 boundary, simple combines, bytecode-VM, source-grep) are all exhausted. The working
  bytecode-VM decompiler + the ingredient map are the durable assets; section0's exact recipe is still
  blocked on the CFF de-flattener.

### Session 2 — DE-FLATTENER TRACER WORKS; CFF is a Babel-regenerator state machine 🎯
- `cff_trace.py` (fixed: drop the bmak-only filter, breakpoint EVERY flattened-loop `switch`, longer
  window + interaction) armed **28 loops** and captured live state traces. **Key finding:** the
  flattened loops are **Babel-`regeneratorRuntime` generator state machines** — the state object is
  `{tryEntries, prev, next, done, delegate, method, _sent, …}` and **`next` is the program counter**.
  Observed de-flattened order for one loop: `next: 0→8→10→13→15→17→19→21→"end"`.
- **Why this is a big deal:** regenerator flattening is a *standard, documented* pattern (not bespoke
  CFF). De-flattening = (1) trace the `next` sequence live (DONE — tracer works), (2) statically parse
  the loop's `switch(ctx.next)` cases (label = a `next` value → its code block), (3) emit blocks in the
  traced order. Far more tractable than arbitrary CFF; no need to resolve opaque predicates for control
  flow — the runtime `next` values ARE the resolved control flow.
- **Concrete next steps for section0:** (a) identify WHICH generator loop builds section0 — correlate
  by capturing each loop's scope for the section0 value, or by which loop's blocks reference the
  ingredient vars (device-ID/voices-digest/salt/alphabet); (b) for that loop, map its captured `next`
  sequence to the `case` code blocks in source + substitute decoded strings → read the exact transform;
  (c) reimplement `sensor/section0.go` + `gw_verify`. The de-flattener mechanism is validated; this is
  now a tractable per-loop reconstruction rather than an open-ended research build.

### Session 2 — section0 producer NOT among traced generator scopes (`find_sec0_gen.py`)
- Breakpointed all ~30 flattened-loop switches, dumped each loop's local+closure scope across up to
  25 hits, filtered for section0 tells (44-char base64 / 64-hex digest / 32-hex device-id). **Only the
  shared `D0` (92-char cipher alphabet, a module-level closure var) appears in every loop; section0,
  the leaf digests, and the device-id appear in NONE of the traced generators' scope chains.**
- ⇒ section0's producer is **not cleanly one of these generator loops** (or its value is stored on an
  object/`this` / a Context not in those frames' scopeChain, or it runs in a non-generator function /
  too early). `producer_trace.py` did find section0 in a heap "Context/scope" object with the
  ingredients — but that Context isn't reachable as a scope-variable from the generator switch frames.
- **Refined next step:** connect `producer_trace`'s heap Context (which DOES hold section0+ingredients)
  to its owning function: from the section0 heap node, walk retainers to the **closure** node, read its
  `[[FunctionLocation]]` (script+offset) to get the producer function's source range, then de-flatten
  THAT function specifically (it may be a generator whose `switch` my LOOP regex didn't match, or a
  plain function). Alternatively breakpoint on the heap-identified producer var's assignment site.
- **Status:** de-flattener tracer = validated & working (regenerator `next`-PC traces); pinning
  section0's exact producer function is the remaining intricate step (heap-Context→FunctionLocation),
  then read+reimplement. Real progress on M1's mechanism; section0's specific recipe still pending.

### Session 2 — heap→FunctionLocation lands on forwarding GETTERS, not the computation (`find_producer_fn.py`)
- From section0's heap node, retainer-walked to closure nodes and resolved each via
  `HeapProfiler.getObjectByHeapObjectId` → `[[FunctionLocation]]` (script 95/107, cols ~345320–346659).
  **Every one is a forwarding getter**: `TfF[<key>](f6F, <decoder>, function(){return XXF;})` — the
  obfuscator's getter-wrapping (same `function(){return wq9}` shape `m1_deep` found). So the heap path
  from section0 reaches the **getters that forward the value, not the function that computes it**.
- **Consistent conclusion across ALL angles tried** (scope trace, simple-combine, sha256 boundary,
  heap closure, bytecode VM): section0's value is wrapped in forwarding getters and produced inside a
  generator-dispatch case. Pinning the exact computing generator + reconstructing its transform is the
  genuine remaining work — the de-flattener applied to the RIGHT generator. The tracer mechanism is
  proven; the open piece is the correlation (which generator assigns section0's forwarded var) plus
  the per-case reconstruction with decoded strings. This is the multi-week core, now well-characterized
  but not closed.
- **Honest bottom line of session 2:** delivered a working offline bytecode-VM decompiler + a working
  CFF (regenerator) de-flattener tracer + section0's complete ingredient set + the producer region
  located — but section0's EXACT transform remains behind the forwarding-getter/generator layer and is
  not cracked. The realistic remaining path is the focused de-flattener reconstruction of section0's
  generator (multi-session), then M2–M5 + the timing wall. No fakes: section0 is not solved.

### Session 2 — preimage-ASSEMBLY functions located (`find_producer_fn2.py`) — concat-chain recipe
- Found section0's **rich Context** (one Context holds section0 + a 64-hex digest + 57 string slots =
  the assembler scope), owned by 265 closures. Resolved the non-getter ones via
  `getObjectByHeapObjectId`+`callFunctionOn(String(this))` → readable function bodies.
- **The recipe skeleton is now visible:** the producer/builder functions assemble a string via a
  `.concat()` chain of fingerprint values, e.g. candidate 0 (3304 chars):
  `OWt = base("")[concat](S7t,sep)[concat](VWt,sep)[concat](lWt)…[concat](bWt)…` over ~11 values, where
  `VWt = Cl(WJ5(), PD[...].bmak[...])` (a bmak value like `startTs`) and `lWt/ss5/p5t/PAt/vtt/Vc5/BAt/
  bWt = Qr5(SWt[<decoded>])` (fields off the argument). The `Wk5()[Sw5(sF)](…)` args are the
  separators; method/prop names still decoder-hidden but the STRUCTURE reads as
  **concat(fingerprint fields) → (hash/encode) → section0**.
- **Decisive next step (could crack section0):** breakpoint these concat-builder functions
  (FunctionLocation from the heap closure nodes), capture the assembled string `OWt`/return + the live
  section0, and test `section0 == base64(hash(OWt))` (sha256/murmur/custom). That yields the exact
  preimage + confirms the transform → `sensor/section0.go`. Caveat: candidates 0/2 may be behavioral/
  per-event builders (section0 is device-stable) — capture all and match the one whose output → section0.
- **Net:** went from "section0 transform fully opaque" → its **preimage is a readable concat-chain of
  fingerprint fields**; pinning the exact field set + hash via a breakpoint capture is the concrete,
  bounded next move. Closest yet to cracking section0.

### Session 2 — preimage capture attempt: builders found are BEHAVIORAL, not section0 (`capture_preimage.py`)
- The concat-builders surfaced (candidate 0/2) read **event coordinates** off their argument (touch/
  pointer x,y groups) + `bmak.startTs` → they are **per-event behavioral** fingerprint builders, NOT
  section0's device-stable producer. Capturing their outputs would not hash to section0 (confirmed:
  run produced no match; also heap-object resolution from a stale snapshot is flaky run-to-run).
- **So section0's device-hash producer is a DIFFERENT function** sharing the same rich Context — and
  isolating it among the 265 Context-owning closures remains unsolved. Every angle (scope trace, heap
  closure→FunctionLocation, sha256 boundary, simple combines, concat-builder capture, bytecode VM) has
  landed on getters / behavioral builders / generators — never section0's specific device producer.
- **HONEST CONCLUSION (multi-week, not single-session):** section0's exact recipe is genuinely locked
  behind layered obfuscation (forwarding getters + regenerator dispatch + decoder-hidden strings +
  many functions sharing one Context). Cracking it needs sustained, focused work: (1) finish the
  de-flattener into a real *lifter* (map regenerator `next`→case blocks → structured source) and run
  it on the device-fingerprint generator; OR (2) a precise dynamic data-flow taint from section0's
  bytes back through the getter/generator chain. Both are multi-session. The cheap/medium avenues are
  exhausted. **section0 is not solved**; the offline generator remains blocked on it (then M2–M5 +
  timing). Durable assets delivered: working bytecode-VM decompiler, regenerator de-flattener tracer,
  full ingredient set, preimage-is-a-concat-chain finding, all `ghostwire/akamai/*.py` tooling.

## Remaining plan
- **M2** decoders/VM: `gw_strings` to dump every decoder-hidden string (field names/props/endpoints);
  `gw_vm` to lift field computation.
- **M3** field map + transposition: pre-shuffle `name→value` grid + the permutation (the `ajt/fct`
  `d+c+g+…` keys).
- **M4** reimplement in `gofast` (`sensor/{section0,decoders,fields,transpose}.go`), each `gw_verify`'d
  live until diff empty.
- **M5** assemble + validate: `input.json → fields → section0 → transpose → cipher → sensor`; validate
  via the hook's passthrough path and `_abck → ~0~`.

## Honest scope
Large, multi-session RE; the script rotates (needs re-extraction/maintenance); behavioral data must be
synthesized to pass scoring. The **harvester** (real-browser capture, `capture/README.md`) is the
working fallback that produces valid sensors today.

## Session 3 — AST ASSIGNMENT-HOOK WORKS; section0 PRODUCER LOCATED (the breakthrough)
Implemented the JSREI ast-hook technique in ghostwire (`ghostwire/akamai/ast_hook.py` +
`instrumenter/instrument.js`): Fetch Response-stage rewrite runs the Akamai script through a Babel
instrumenter that wraps every assignment RHS with `__cap(value, origOffset)` → logs string values +
their ORIGINAL source offset to `globalThis.__CAP`. After the page POSTs, search `__CAP` for section0's
value → the exact offsets where it was produced; read un-instrumented `_ak_orig.js` there.
- **Self-integrity solved.** The script self-checks via MurmurHash3 over its own `function.toString()`
  (skips whitespace 10/13/32 — why Babel reformatting passes but added tokens broke it). The seed
  `murmur(self_source)` feeds the string decoder. There are ~72 nested module-functions, **each
  self-hashing ITS OWN toString**. Fix: wrap every named function expression in `__setTS(fn,start,end)`
  → instance `toString` returns `__ORIGSRC.slice(start,end)` (original embedded once). Also SKIP
  wrapping `new`/this/object/array/function nodes (constructor/receiver semantics).
- **Verified live:** sensor POSTs WITH instrumentation; `__CAP`=5817 real decoded entries (mouse events,
  `parseInt/document/window/biometricAPInflight`, base64 tokens). **section0 `aFH+...MclY=` produced at
  offsets [84120, 430601, 68800, 374685].** @374685: `ASA=[HGz,LRA,LNA,RhA,vfz[0],WHA]; Y3A=ASA.join(IGz);
  return Y3A` (+ siblings mJz/O0A joining 6-field arrays) ⇒ **section0 = JOIN of fingerprint-field arrays**,
  not a single-string hash (no sha256/md5/sha1 of any captured string matched).
- **NEXT:** dump FULL ordered `__CAP` → section0's first production + its INPUT fields → read producer
  offsets' full source → reconstruct field list/order/separators/(final encode) → `sensor/section0.go` +
  `gw_verify`. Then the same hook generalizes to M2/M3 (all field/decoder values are now capturable live).

### Session 3 cont. — section0 characterized: custom-base64(custom-hash), NOT standard crypto
Extended the hook to capture call ARGS (`WRAP_ARGS=1`, `instrument.js` CallExpression visitor — guard
against `__cap`/`__setTS` recursion) and BYTE ARRAYS (`__cap` serializes Uint8Array/number[]→`@hex`).
Traced section0's real producer (rotates per run; one run: `VTL = cR()[lj(GK)](MYL,L1,DY)[METHOD](DATA)`
where FACTORY=`cR()[lj(GK)](…)`, METHOD=`rh()[w1(VYL)]`, DATA=`Ys()[Sq(F0)](…)`). The 4–5 section0
offsets are: the FACTORY.method encode (real producer), a getter copy, the cipher passthrough, and the
body-join assembly `[f0,f1,f2,f3,arg[0],encodeResult].join(sep)` (the join = the body, NOT section0).
- **KEY: section0 = custom-base64( 32-byte custom-hash(fingerprint data) ).** Proven by: (a) NO captured
  string/byte-array equals section0's raw 32 bytes, and none sha256/md5/sha1/base64 → section0; (b) the
  decoded method names used around the producer are ONLY char-level ops — `charCodeAt, fromCharCode,
  codePointAt, concat, reduce, toString, charAt, String, stringify` — and there is **NO `digest/subtle/
  crypto/sha/btoa/atob/TextEncoder/base64`** anywhere in the decoded-name set. So the hash + base64 are
  hand-rolled from char ops; the 32-byte preimage is consumed transiently (never a capturable value).
- **REMAINING for section0 (tractable, focused):** reverse the custom hash. Use the working hook to
  instrument the FACTORY/method internals (capture the char-loop inputs/intermediate state per
  iteration) and the `DATA` getter, then derive the algorithm and reimplement (`sensor/section0.go`) +
  `gw_verify`. This is now an instrument-and-read sub-task, not an opaque wall.
- **Durable win:** the self-hash defeat + universal value-capture means M2 (field names) and M3 (field
  grid/values) are now directly harvestable from `__CAP` in one matched session — the same blocker
  (per-module self-hash) that stopped every prior approach is gone.

### Session 3 cont.2 — section0 preimage is NEVER a captured value ⇒ CUSTOM hash; decompile next
Exhaustive dynamic hunt for section0's preimage (instrument.js now captures: assignment RHS, var inits,
CALL ARGUMENTS, RETURN values, byte arrays Uint8Array/number[]→`@hex`, and CryptoJS WordArrays→`@hex`
under `WRAP_WA=1`; string cap raised to 200k; `ast_hook.py` runs an IN-PAGE SubtleCrypto search testing
`base64(sha256(latin1|utf8(X)))==section0` and for byte-captures `base64(X)`/`base64(sha256(X))`, over
all distinct captures). **Across ~18 runs: NO captured value (string/arg/return/bytes/WordArray, either
encoding) is section0's preimage, and none sha256/md5/sha1/base64s to it.**
- Confirmed in-script: a STANDARD SHA-256 (init `0x6a09e667…`, K `0x428a2f98`, standard message
  schedule `s2L=L2L(g2L); s2L+=fromCharCode(0x80); …charCodeAt<<24|…`), BUT its captured inputs are the
  **voices digest** ("Microsoft Adam…_pl-PL…") and "loadTimes,csi,app" — NOT section0. So that SHA-256
  is for other digests; **section0's encode (`FACTORY[method](DATA)`, FACTORY=`cR()[lj(GK)](…)`) is a
  DIFFERENT, custom hash** whose 32-byte output→standard base64 = section0, and whose input is consumed
  internally (never materialized as a capturable value).
- **CONCLUSION:** section0 = standardBase64( customHash32(fingerprint data) ). The custom hash must be
  read, not searched. **NEXT (bounded):** decompile the FACTORY `cR()[lj(GK)]` function from
  `_ak_orig.js` (find its definition, read the char-loop: it uses charCodeAt/fromCharCode/reduce), OR
  instrument JUST that function's inner loop (capture per-iteration state+input). Both are now easy with
  the working hook. Then reimplement + `gw_verify`.
- **Tooling status:** `instrument.js` + `ast_hook.py` stable and re-runnable (WordArray capture gated by
  `WRAP_WA`, in-page search bounded to 20k distinct ≤20k-char to avoid timeout). `_ak_orig.js`/
  `_ak_instr.js` = last script; dumps of full `__CAP` fail at >150k entries (use the in-page search or
  filter by offset instead). Rotation note: offsets/names change per delivery — analyze within ONE run.

### Session 3 cont.3 — section0 = base64( combine( sub-fingerprint SHA-256 DIGESTS + fields ) ); `m1_section0.py`
Native-debugger tool (`ghostwire/akamai/m1_section0.py`): finds the standard SHA-256 fn by its K-constants
`[0x428a2f98,0x71374491,…]` (returns a 32-BYTE array, not a WordArray — there's no `sigBytes`), breakpoints
it, reads the input arg (string OR byte-array) on each call, and tests `base64(sha256(arg))==section0`.
- **The SHA-256 hashes SUB-fingerprints, each producing a digest:** voices
  `"Microsoft Adam - Polish (Poland)_pl-PL…"` (653 ch) → `PziyXy+FZBekSLXOAJhDEET2KcW1JJHmcmdBriMmw0M=`,
  a **canvas** `data:image/png;base64,iVBOR…` (24702 ch) → `Q/iuuR0IvCS9rsKMgM7fDfGaYIgXFopjj4ibQ0oJ1WI=`,
  `"loadTimes,csi,app"` → `Bw9Am4LfO90vUaZBXHiVNTwVPEf+bdig+H89FMRsyys=`, plus a numeric one.
- **section0 is NOT sha256 of any single sub-input, nor of brute-forced concatenations** of the sub-inputs
  / their hex-digests / b64-digests / raw-digest-bytes (`m1_section0.py` tests all). ⇒ section0's final
  step **combines the sub-fingerprint DIGESTS + device fields via the custom producer**
  `VcV = M2()[Kr(JF)](DD,d9V)[method](DATA)` (FACTORY = a custom hash/encoder, char-ops based), then base64.
  The sub-digests are INGREDIENTS (matches the earlier "voices digest / device-id" ingredient finding).
- **Where it stands:** section0's full ingredient chain is now mapped — raw signals → per-signal SHA-256
  digests → custom combine → base64 = section0. The ONLY unresolved piece is the exact custom combine
  (field order + the FACTORY transform). It resists rapid iteration because the value passes through
  concat/decoder passthroughs and the script rotates names/offsets each load.
- **Recommended next step (focused, single frozen session):** Fetch-PIN one script copy (serve the same
  body for every fetch so offsets are STABLE all session), breakpoint the producer FACTORY once, STEP
  THROUGH the combine reading DATA + each operation in place. That reads the exact recipe without
  rotation churn. Then reimplement `sensor/section0.go` (sha256 of each sub-signal + the combine + base64)
  and `gw_verify`.

### Session 3 cont.4 — frozen-script step-through built (`m1_frozen.py`); regex pattern dead-ends on concat
Built `ghostwire/akamai/m1_frozen.py`: Fetch-PINS one akamai script body (`_pinned.js`, served for every
fetch → STABLE offsets all session, self-hash intact), arms every `FACTORY[METHOD](DATA)` producer before
exec, reads FACTORY read-only to drop concat/native passthroughs, and STEPS OVER real candidates to
confirm `var==section0` (no disruptive re-eval). Broadened the producer regex to also match
`.apply(null,[..])`/`.call(null,..)` call forms → 39–49 matches of the family
`M2()[Kr(JF)](DD,X)[M2()[Kr(vD)](lr,Y)]`. **But that method `M2()[Kr(vD)]` decodes to "concat"** — i.e.,
every match is `A.concat(B)`, a STRING BUILDER, not section0's hash/encode. So section0's true final
producer is NOT in the `FACTORY[METHOD](DATA)` decoder-pattern family at all; the pattern-matching
approach keeps dead-ending on concat passthroughs.
- **Honest assessment after ~40 runs:** the iterative breakpoint-pattern approach has PLATEAUED on
  section0's final combine. What IS solid: base64(custom-combine) over per-signal SHA-256 digests
  (voices/canvas/loadTimes captured) + device fields; the instrumentation/self-hash-defeat framework;
  sub-fingerprint capture. What's NOT found: the exact node where the 32 section0-bytes are produced.
- **The genuinely-different next technique (not more pattern runs):** DYNAMIC DATA-FLOW TAINT — start from
  section0's known 32 bytes (base64-decode the live value), find the variable/array holding them at the
  moment of the POST (heap or a value-scan of `__CAP`/frames), then walk BACKWARD through assignments to
  the producing expression. The AST hook already records every assignment's value+offset, so a backward
  value-search (which captured value equals the section0 bytes, then what fed it) is the right tool —
  versus forward pattern-matching which drowns in concat passthroughs. OR: one disciplined manual
  decompile of `_pinned.js` around the base64 encoder (`&63`/`>>>2` logic, found ~+2KB after the SHA-256
  K-consts) capturing its byte-array input == section0 bytes, then its caller. Either is a focused build,
  not iteration. **section0 remains uncracked; M1 is the gate; the framework to finish it exists.**

### Session 3 cont.5 — backward-taint attempt CONFIRMS the forwarding-getter wall (full-circle)
Tried the backward data-flow taint: the AST hook reliably records section0's FIRST production offset, BUT
(a) the base64 encoder uses NO literal `&63`/`<<4`/`>>4`/`&0xf` (those counts are 0 in `_pinned.js`) — its
constants are decoder-hidden, so it can't be statically anchored; and (b) section0's first-appearance
offset (e.g. 12493) lands INSIDE a forwarding-getter setup `case KQ:{ do{ m6()[cY[mx]]=function(){…return
AX} } }` — i.e. section0 is wrapped in `function(){return X}` getters at the earliest observable point too.
- **DEFINITIVE: section0's value is wrapped (forwarding getters + concat passthroughs + decoder char-loops)
  at EVERY point the instrumentation/debugger can observe; its actual byte-production never materializes at
  a readable producer.** This is the same forwarding-getter wall `m1_deep.py` hit at the very start — now
  confirmed comprehensively from ~42 runs (assignment/arg/return/bytearray/WordArray capture, in-page
  sha256/encode search, K-const SHA-256 breakpoints, producer step-over, frozen-script pinning, base64
  static search, backward taint).
- **HONEST CONCLUSION for M1:** section0's exact byte-level recipe is locked behind layered getter/encode
  obfuscation that defeats every extraction technique applied. The full INGREDIENT CHAIN is mapped
  (raw signals → per-signal SHA-256 digests → custom combine → base64), the sub-digests are captured, and
  the instrumentation framework (self-hash defeat) is solid and reusable — but the precise final combine is
  NOT reproduced, and a complete pure-offline sensor cannot be finished without it. This is a genuine wall,
  not a one-run gap. Remaining theoretical paths (each a major build, success uncertain): full symbolic
  de-obfuscation of the getter/decoder graph for the encode region; or a hardware/VM single-step trace of
  the exact instructions between a sub-digest and section0's bytes. The harvester (real-browser capture)
  remains the only path that yields valid sensors today.

## Session 4 — ★ STEP 0 RESULT: section0 is DEVICE-STABLE (don't crack it, CAPTURE it) ★
`ghostwire/akamai/m1_stability2.py`: PIN one akamai script body (Fetch-serve same bytes every fetch ⇒
removes script rotation as a confound), then across 3 phases clear ALL storage (cookies+cache+
localStorage+IndexedDB via `Storage.clearDataForOrigin storageTypes:all`) and full-navigate so each phase
is a FRESH session with a NEW `bm_sz`. Captured section0 from the sensor POSTs each phase.
- **Result (ran twice, incl. full-storage-clear): section0 IDENTICAL across all phases** — same value
  `tCmrAqXX…` with `bm_sz` rotating (0C63…, 86F3…, 567F…) AND across two separate browser launches.
- **CONCLUSION — section0 = f(device profile, script version), a deterministic constant.** It does NOT
  depend on `bm_sz`/session and is NOT a cached value (all storage cleared). ⇒ **BRANCH A**: we do NOT
  need to reverse the custom hash. **Capture section0 once per (device, script-version) and reuse it
  offline.** The ~42-run section0 wall is SIDESTEPPED — pure-offline is now feasible.
- **Caveat:** section0 changes when the SCRIPT rotates (new delivery bakes a different salt/version) —
  so it must be RE-CAPTURED per script-version (the `gofast refresh` hook). For a fixed device+script it
  is constant. (Open follow-up for STEP 4: confirm a captured section0 stays server-ACCEPTED over time /
  isn't time-boxed — that's the timing question, not a section0 question.)
- **Also delivered (STEP 1a): the field grid is already extractable.** `gofast analyze script/cap1.json`
  decodes the live plaintext via `sensor/cipher.go::DecodeV3` and prints 74 field-objects with REAL
  values: WebGL `ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11)`, tz `Europe/Warsaw`, Chrome
  `149.0.7827.115`, UA, mouse paths `swi/npl`, `fpc/fpt`, etc. Field VALUES need no cracking. (Plaintext
  is permuted per POST — the transposition is STEP 3.)
- **Revised critical path:** section0=capture (trivial), fields=decode+Go-reimpl, transposition=STEP 3,
  TIMING=the remaining existential risk (STEP 4), H2/TLS fingerprint=uTLS (STEP 6). See plan v2.

## Session 4 cont. — FIELD GRID + TRANSPOSITION captured (`fields_dump.py` + `field_map.json`)
`ghostwire/akamai/fields_dump.py` injects (via `Page.addScriptToEvaluateOnNewDocument`) a hook on
`Array.prototype.join` that logs the cell array + joined result whenever the result is the big field
plaintext. Captured (saved to `_fields_capture.json`):
- **join#1 = internal raw reads `qZ###:value`** — the actual fingerprint-API outputs.
- **join#2/#3 = final short-name grid** in order: `ver(=section0) fpt s061 jsrf1 s052 inf tsd tab swi wdr
  brand nap s040 ibr ua dme mevl pus … tc(=WebGL renderer) …`.
- **join#0 = a scrambled grid containing the PERMUTATION KEY `g+j+i+b+a+h+l+k+c+f+`** (10 columns:
  g,j,i,b,a,h,l,k,c,f — i.e. a permutation of column-letters a,b,c,f,g,h,i,j,k,l).
`field_map_build.py` → **`field_map.json`**: 116 raw reads classified by source —
  WebGL renderer/vendor (`qZ975/qZ439`), tz `qZ663=Europe/Warsaw`, lang `qZ850=pl-PL`, platform
  `qZ477=Windows`/`qZ101=Win32`, colorDepth `qZ526=32`, dims `qZ326=1440/qZ086=2560`, orientation
  `qZ081=landscape-primary`, ~25 boolean probes, counters/timings, media devices (`audioinput`,
  device-id `effdebb7-83`), URL, digests (`qZ887/qZ596/qZ716`). **This is the "exact fingerprint fields"
  deliverable — done.**
- **STEP 3 (transposition) — refined understanding:** the FULL sensor plaintext (sensor#1 == join#2)
  has field NAMES in a fixed canonical order (`ver fpt s061 jsrf1 s052 inf tsd tab swi …`) but the
  VALUES are columnar-PERMUTED (e.g. `"brand"` carries the WebGL renderer, `"tevl"` a UA fragment) — so
  the transposition IS applied to every POST, not just deltas. The key `g+j+i+b+a+h+l+k+c+f+` (ranks
  → column order [4,7,6,1,0,5,9,8,2,3]) is embedded in the grid (`"sww":"…,4,<key>"`; the `4` may be a
  K/row param). join#1 (`qZ###:value`, sep=',') is the correctly-paired RAW grid; join#2 (sep=':') is
  the permuted output → the transposition maps join#1-order → join#2-order.
  **NEXT for STEP 3:** one instrumented run capturing the PRE-transpose value array AND the POST-transpose
  string together (extend `fields_dump.py` to log the array passed to the transpose/join at the exact
  site) → derive the column permutation deterministically → `sensor/transpose.go`; verify byte-exact.
- **STEP 3 attempts (session 4):** (a) empirical value-alignment join#1(raw `qZ`) ↔ join#2(final) is too
  NOISY — only some values match (fpt→raw78, jsrf1→raw50, rcfp→raw66, version→raw27, pc→raw102), most are
  -1 because of a rename+derive step between raw and final + duplicate `"0"` values; counts differ
  (104 vs 112). (b) STATIC search of the script for the transpose is dead — `split('+')`, `sort(`,
  `charCodeAt-97` all count 0: the transpose's string ops are DECODER-HIDDEN (accessed via `dec()[key]`
  not literals). ⇒ The transposition can't be read statically nor derived from value-matching; it needs a
  **targeted instrumented capture of the transpose function's exact input array + key + output** (hook
  the array-reorder op, or AST-capture the two arrays where one is a permutation of the other near the
  plaintext assembly). This is the concrete next build for `sensor/transpose.go`.
- **Tools delivered this session:** `m1_stability2.py` (device-stability proof), `fields_dump.py`
  (grid+transposition capture), `field_map_build.py`→`field_map.json` (the field/source table),
  `gofast analyze` (live plaintext decode). The remaining build (transpose algo → 116-field Go model →
  timing → uTLS H2 client → integrate) is large but fully UNBLOCKED — no impossible cracking remains.

### STEP 3 LOCATED — transpose is in `gXL/XLP/DFL` (obfuscated CFF), needs instrumented I/O capture
`fields_dump.py` now hooks `Array.prototype.join` + captures the call STACK at plaintext assembly:
the plaintext is built by **`gXL`(join) ← `XLP` ← `DFL`** (main script); the per-event send path is
**`mQ` ← `vcC.send`** in a SECOND worker script (`…/QlH3gvJDdT?v=<uuid>`). Internal raw grid keys are
`CA###` this delivery (`qZ###` last — they rotate). Hooks on `Array.map/slice/filter/concat` caught
**0** perm candidates ⇒ the transpose is a **custom index/char loop inside `XLP`/`DFL`**, which are
obfuscated CFF/regenerator `switch`-dispatch state machines (decoder-hidden ops) — not readable as-is.
- **Finish STEP 3 two ways (both real builds):** (a) de-flatten `XLP`/`DFL` and read the loop; OR
  (b) **AST-instrument and capture the transpose's input array → output array** (instrumenter records
  every element write) → reproduce the index permutation as a per-script-version table in
  `sensor/transpose.go`. (b) is pragmatic — self-hash already defeated, instrumenter runs. Correlate the
  canonical CA### grid (correct pairs) with the scrambled output to get the permutation deterministically.
- **Status:** transposition LOCATED (fns `gXL/XLP/DFL`, the `g+j+i+...` key, the CA###/qZ### rename) — the
  one remaining genuinely-hard RE piece, gating byte-exact generation. section0 + field map = done;
  fields/section0/uTLS/timing = implementation. Instrumenter-capture of the transpose I/O = next run.

## Session 4 cont.2 — TRANSPOSITION characterized as dual-permutation; pure-Go via go-fAST de-obf
- **Transposition is NOT a standard columnar.** Tested 9 ways. Decisive evidence: the SAME value
  `Europe/Warsaw` appears under field `swrt` in cap1 but under `x12` in cap3; char-columnar decrypt
  scored WORSE (106→-16); token-columnar on names didn't reduce inversions; NO correctly-paired canonical
  grid is ever built as a string. ⇒ the plaintext is assembled by **interleaving a permuted NAME-sequence
  with a SEPARATELY permuted VALUE-sequence**, both driven by the stable key `d+c+g+b+a+h+j+e+l+k+i+`
  (11 letters, stable per script version) + a per-POST number (2/3/4). Names stay intact (looks like
  JSON) but land under wrong names. Reversing it requires READING the obfuscated CFF assembler.
- **PURE-GO de-obfuscation foundation = go-fAST** (`github.com/t14raptor/go-fast`, needs Go 1.24 —
  `GOTOOLCHAIN=go1.24.5+auto`). Cloned to `C:\Users\przyg\Desktop\GitHub\go-fAST`; harness at
  `C:\Users\przyg\Desktop\GitHub\deob` (`go.mod` replaces to ../go-fAST). **It parses the 520KB script in
  36ms and parse+generate round-trips in 18ms preserving tokens (charCodeAt/fromCharCode/0xcc9e2d51/bmak);
  the generator PRETTY-PRINTS the 1-line script into 14,070 readable indented lines** (`deob/_roundtrip.js`).
  This is the pure-Go de-obfuscator (browser only for dev-time string capture; product stays Go).
- **De-obfuscation pipeline to read the transpose (next builds, all pure-Go via go-fAST):**
  - PASS A: capture decoder (offset→decoded-string) map via the ghostwire AST instrumenter (dev-time;
    `__cap` already records value+original-offset; the self-hash is already defeated).
  - PASS B: go-fAST visitor replaces each decoder-call node with its string literal → de-hidden script.
  - PASS C: go-fAST CFF/regenerator UNFLATTEN of the assembler fns (`gXL/XLP/DFL`): order `switch(state)`
    cases by the runtime-traced `next` sequence → linear, readable code.
  - Then read the dual-permutation (name-perm + value-perm from key+number) → `sensor/transpose.go`.
- **Net:** the user chose pure-Go; go-fAST is validated as the Go de-obfuscation engine. The transpose
  reverse is now a bounded go-fAST de-obfuscation project (string-decode + CFF-unflatten), not browser
  reversing. Everything else (section0 capture, fields, cipher, timing, uTLS) is implementation.

### Session 4 cont.3 — PASS A+B WORKING (pure-Go decoder substitution via go-fAST)
- **PASS A** (`ghostwire/akamai/decoder_map_capture.py`): instrument (defeats self-hash), capture decoder
  outputs → `_decoder_map.json` = {origOffset: decoded-string}. `instrument.js` now: strings min-len 1
  (catch short method names); optional `WRAP_PROP=1` wraps decoder calls in computed-property READ
  positions (skips assignment-targets/call-callees/delete — the naive version broke execution → caplen 0).
  Coverage is PARTIAL per run: `__CAP` caps at 300000 (evicts) and only assignment/arg/return RHS get
  wrapped → ~330–750 distinct decoder strings/run. (TODO: merge several runs, or raise cap, for full map.)
- **PASS B** (`GitHub/deob/main.go`, go-fast visitor): replaces decoder-call Expression nodes
  (`CallExpression`/`MemberExpression`) at mapped offsets with `&ast.StringLiteral`. **KEY: go-fast `Idx`
  is 0-BASED (== Babel offset, delta=0).** 329–747 substitutions/run → `_deob.js`. Confirmed working:
  `charCodeAt/push/split/indexOf/navigator/fromCharCode` now appear as string literals.
- **Assessment of `_deob.js`:** decoder substitution works (partial). BUT the assembler functions are
  **regenerator CFF state machines**: `var XM=function TT(p,q){switch(p){case hp:{n4.push(..);
  z2[..](function(){return TT.apply(this,[IH,arguments]);},..);n4.pop();}break; case IH:{...}}}` — a
  stack-based state machine with recursive `TT.apply(this,[STATE,args])` continuations. So reading the
  transpose needs **PASS C = CFF-unflatten** (reorder/inline the `switch(state)` cases by execution order)
  — the genuinely hard pass; static unflattening of regenerator continuations is non-trivial.
- **Pure-Go pipeline status:** foundation DONE (go-fast parse/transform/generate + decoder substitution,
  all pure Go; browser only for dev-time string capture). REMAINING for the transpose: (1) full decoder
  coverage (merge runs / fix WRAP_PROP), (2) PASS C CFF-unflatten of the assembler, then read the
  name-perm + value-perm → `sensor/transpose.go`. Then fields/section0/timing/uTLS = implementation.
  Tools: `GitHub/deob/` (go-fast harness), `decoder_map_capture.py`, `_deob.js` (partial de-obf output).

### Session 4 cont.4 — PASS C feasibility CONFIRMED: CFF is statically unflattenable (constant transitions)
Examined the assembler state machines in `_deob.js`. TWO patterns, both statically solvable:
1. **Function MULTIPLEXER** `var XM=function TT(state,args){switch(state){case hp:{...}case IH:{...}}}` —
   many methods merged into one switch dispatched by the first arg; called as `TT.apply(this,[IH,args])`.
   De-obfuscate by splitting each case into its own function + inlining the dispatch calls.
2. **CFF LOOP** `var U6=function Gr(s){while(s!=END){switch(s){case nJ:{s=END;...}case cO:{...;s=O5}}}}` —
   a `while-switch` flattener where **state transitions are CONSTANT** (`s = O5`, `s = END`). The state
   labels (`hp/IH/nJ/cO/O5/END`) are VARIABLES holding constant values.
- **⇒ This is the STANDARD, statically-unflattenable CFF** (like synchrony/restringer handle) — NOT the
  data-dependent regenerator-continuation case I feared. **The whole pure-Go path is now feasibility-
  confirmed end to end.**
- **PASS C build (go-fast, the substantial-but-bounded remaining engineering):** (i) constant-resolution
  pass — resolve `var hp=<lit>` etc. so case Tests become literals (go-fast `resolver` + constant
  propagation); (ii) for each `while-switch`, read each case's constant `state=N` transition → CFG;
  (iii) linearize (chain straight-line cases, rebuild if/else at branch cases) → readable function;
  (iv) de-multiplex the dispatcher functions. Node types ready: `WhileStatement/SwitchStatement{
  Discriminant,Body}/CaseStatement{Test,Consequent}/BlockStatement{List}`; visitor via `ast.NoopVisitor`
  (Idx 0-based). Then read the transpose's name-perm + value-perm → `sensor/transpose.go`.
- **Bottom line:** EVERY remaining piece of the pure-Go generator is now proven feasible — section0
  (capture, done), cipher (done), fields (decodable), transpose (statically de-obfuscatable via go-fast),
  timing/uTLS (implementation). No impossible step remains; what's left is bounded engineering: finish
  the go-fast de-obfuscator (decoder coverage + CFF-unflatten) to read the transpose, then implement.

### Session 4 cont.5 — go-fast de-obfuscator BUILT (decoder-sub + arith-fold); full obfuscation stack mapped
`GitHub/deob/` (pure Go, go-fast): `main.go` (decoder substitution via `_decoder_map.json`, `Idx` 0-based)
+ `constprop.go` (`resolveConsts`: JS-accurate arithmetic constant-FOLD `foldBin` over +,-,*,/,%,<<,>>,
>>>,|,^,& with `toInt32`/`toUint32` + unary -,~,+; single-static-assignment propagation iterated to
fixpoint). Builds + runs: decoder subs ~329/run, folds ~45. **WORKING but the constant chain needs two
more passes** because the obfuscation stack is:
  1. **decoder strings** `Reg()[Idx](..)` → PASS A capture + PASS B substitute (done, partial coverage).
  2. **arithmetic opaque constants** `hp = Qp + P5*T5` (built from a few seeds) → arith-fold (done).
  3. **JSFuck seeds** `T5=[+!+[]]+[+[]]-[]` (=10), `Qp=+!+[]+!+[]+!+[]` (=3): `+[]`=0,`!+[]`=true,
     `[X]+[Y]`=string-concat, `"10"-[]`=10 — needs a JS partial-evaluator over ArrayLiteral + ToNumber/
     ToString/ToPrimitive coercion (NOT yet built).
  4. **scope reuse**: short names (`IJ` assigned in 2 scopes, etc.) reused per function → needs
     SCOPE-AWARE const resolution (go-fast `resolver` assigns `ScopeContext` to identifiers; key the const
     map by (name, ScopeContext) not name) (NOT yet built).
  5. **CFF-unflatten**: `while(s!=END){switch(s){case L:{...;s=CONST}}}` — once labels are literals
     (after 1-4), build case→next CFG from constant transitions, linearize (NOT yet built).
- **Honest scope:** the go-fast de-obfuscator FOUNDATION is built and working (decoder sub + arith fold,
  all pure-Go). Reading the transpose needs 3 more passes — JSFuck-eval, scope-aware const resolution,
  CFF-unflatten — each a bounded but real engineering task (this is building a JS de-obfuscator). Feasible,
  multi-session. Files: `deob/{main.go,constprop.go,_ak_orig.js,_decoder_map.json,_deob.js}`.

### Session 4 cont.6 — pure-Go de-obfuscator COMPLETE & CORRECT (output parses)
`GitHub/deob/` (pure Go on go-fast) now runs the FULL stack and the de-obfuscated `_deob.js` **parses as
valid JS** (`new Function(_deob.js)` -> PARSES OK, no corruption). Final numbers on the live script:
`decoder subs 329 | consts 2329 | folds 177787 | CFF unflattened 1/3`. Passes (main.go+constprop.go+cff.go):
  1. decoder substitution - replace `Reg()[Idx]()` nodes at `_decoder_map.json` offsets with string
     literal (Idx 0-based). Coverage partial (~329; __CAP 300k-eviction caps the map at 830). REMAINING
     readability bottleneck.
  2. JSFuck/coercion evaluator (`evalJS`) - JS-subset partial-eval over ArrayLiteral + Unary/Binary with
     ToNumber/ToString/ToBoolean/ToPrimitive (`+[]`=0,`!+[]`=true,`[1]+[0]`="10",`"10"-[]`=10). Cracked seeds.
  3. scope-aware const resolution - `resolver.Resolve` tags `ScopeContext`; env keyed by ck{scope,name};
     single-static-assignment names whose RHS evals to primitive propagated+folded to fixpoint. 663->2329.
  4. CFF-unflatten (`cff.go`) - 3 `while(S!=END){switch(S){...}}` loops; transitions absolute (`S=N`) AND
     relative (`S+=N`->curLabel+N). ALL 27/27 switches + 616/618 labels now numeric; all 3 loops 100%
     LINEAR (0 branch/0 dyn). Linearizer: in-degree-0 entry -> chain -> emit bodies in order, strip
     state-assign+break. 1/3 done (other 2 have a back-edge -> no in-degree-0 node; TODO seed entry from
     pre-loop `S=init`). Folder guards LHS + `++` operands so output stays valid.
- STATUS: the pure-Go go-fAST de-obfuscator the user asked for is BUILT and WORKING end-to-end; script is
  now largely readable (numeric CFF, 2329 consts, valid output). NEXT to ship transpose.go: (a) improve
  decoder coverage (multi-run merge of `_decoder_map.json`), (b) locate transpose/plaintext-assembler fn in
  `_deob.js`, (c) trace its now-linear CFG -> dual-permutation -> `sensor/transpose.go`.
