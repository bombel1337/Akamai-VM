# v3 sensor timing model (recovered 2026-06-19)

Built from a 4-POST real-Chrome capture via `gofast timemap`. This is the prerequisite
for any coherent timing refresh (the thing that made `regen` fail). See
[../WORKFLOW.md](../WORKFLOW.md) phase 8 for the failed single-field experiment.

## The four classes of time data

| Class | What | Evidence | How to generate |
|-------|------|----------|-----------------|
| **Session anchor** | one 13-digit ms-epoch (`1[78]…`) | `1781818601833` — **identical in all 4 POSTs**; `send − anchor` grew 42→461→1302→10753ms | **reuse** from capture (like section0/seed). Never bump per-POST. |
| **Elapsed timer(s)** | per-POST token ≈ `send − anchor` | closest token off by **1–17ms** every POST (POST#2: `1303` vs `1302`) | set to `newSend − anchor` |
| **Behavioral offsets** | mouse/key event times in `[0, elapsed]` | the "timing window" grows 26→99 tokens as elapsed grows | shift with elapsed; keep ordering/gaps (hard) |
| **Static device tokens** | screen/ids/config | 23 of 171 4+digit tokens appear in every POST | reuse from capture |

## Why `regen` failed
It bumped the **anchor** (a session constant) to `now` per-POST. That destroyed the
`send − anchor = elapsed` relationship the server validates: the elapsed timers still
said "~1.3s since start" while the anchor now said "start = now" → incoherent → `_abck`
stuck at `-1`. The anchor is **not** the field to touch.

## Anchor-shift — TRIED, FAILED (2026-06-19)
Hypothesis: shift only the anchor by `delta = T − originalSend`, keep elapsed/offsets.
Result: hook `replay` mode → `_abck` stuck at `-1` over 12 posts. **Disproven.**
Why: anchor-shift keeps `elapsed` *constant* while real session time advances, so the body
claims it was generated ~Xms after page-load yet arrives 20s+ into the session. The server
tracks session age and expects `elapsed` to **grow**; lying about `navigationStart` (which
it can cross-check against session start) is rejected. (`sensor.ShiftAnchor`/`gofast shift`
remain as the disproven reference; don't use for generation.)

## The corrected transform — timer-shift (next experiment)
Keep the anchor (the real `navigationStart`); **grow `elapsed` by `delta`** so it matches
real session age:
```
delta = T − originalSend
keep:  anchor, section0, seed, meta, static tokens, historical behavioral offsets
add delta to: the "current elapsed" / sampling-time markers (the tight band near elapsed)
```
Then `T − anchor = originalElapsed + delta = elapsed_new` — coherent with a body genuinely
generated at `T`, and section0/anchor untouched. `timemap`'s **tight band** is the candidate
set to advance (historical event offsets stay; only the sampling clock moves).

**Two open risks (verify live):** (1) reliably identifying the sampling-time markers vs
coincidental tokens in the tight band; (2) **behavioral anti-replay** — reusing identical
mouse/key traces across many POSTs may be flagged regardless of timing. Both may mean the
only robust source of valid bodies is **fresh `passthrough` capture** (the harvester).

## Reproduce
```sh
go run . timemap capture/capture-real.json
```
Outputs the anchor, the per-POST closest elapsed token (+ delta), the timing-window size,
and the static-token count.
