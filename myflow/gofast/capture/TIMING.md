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

## The coherent-refresh hypothesis (next experiment)
To replay/age a captured POST at a new send time `T`:
```
delta = T − originalSend           # originalSend = capture's post.t
keep:   anchor, section0, seed, static tokens
shift:  every elapsed timer and behavioral offset by +delta
        (so newElapsed = originalElapsed + delta = T − anchor)
```
This preserves internal ordering/gaps while making overall freshness match `T`. The open
risk: reliably **finding all** timing tokens to shift, given the transposition mixes them
with non-time numbers. `gofast timemap` surfaces the window (`NearElapsed`), but it also
catches non-time values in range — distinguishing them is the remaining work (e.g. shift
candidates, re-encode, test acceptance; binary-search which must move together).

## Reproduce
```sh
go run . timemap capture/capture-real.json
```
Outputs the anchor, the per-POST closest elapsed token (+ delta), the timing-window size,
and the static-token count.
