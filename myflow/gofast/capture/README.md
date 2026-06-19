# gofast/capture — real-Chrome capture (phase 6 unblock)

> **Authorized testing of your own Akamai-protected site only.**

The static diff can't recover a clean field map because the decrypted plaintext is
**transposed/permuted per POST** (see [../WORKFLOW.md](../WORKFLOW.md) phase 6). This
captures the truth at runtime in real Chrome — which Akamai trusts — to get the clean
data the static path can't.

## What it captures
[devtools-hook.user.js](devtools-hook.user.js) installs at `document-start`, before the
Akamai script, and records into `window.__cap`:

| Field | What | Why it matters |
|-------|------|----------------|
| `posts[]` | every `sensor_data` POST (body + JS stack) | the ground-truth bodies + execution order |
| `joins[]` | `Array.join` results | the **assembled plaintext** the cipher consumes |
| `digests[]` | `crypto.subtle.digest` in/out | **section0 preimage** (SHA-256 input → output) |
| `b64s[]` | `btoa` in/out (44-char) | alt path where **section0** is produced |
| `hashes[]` | `encodeURIComponent` inputs | more SHA-256 preimages |

## Steps
1. **Edit `@match`** at the top of `devtools-hook.user.js` to your domain.
2. Install **Tampermonkey**, add the script, open your page, **browse a bit** (move the
   mouse, scroll, click) so the Akamai script emits sensor POSTs.
3. Console check: `__cap.posts.length` should be `> 0`. Sanity: `__decoded(0)`.
4. Export: run `__save()` → downloads `capture-real.json`. Put it in this folder.
5. Cross-reference it from Go:
   ```sh
   cd myflow/gofast
   go run . capture-analyze capture/capture-real.json
   ```
   This recovers the **section0 preimage** (the digest/btoa input whose output equals
   section0) and confirms the **plaintext assembly point** (the `Array.join` whose value
   equals the decoded plaintext).

## Getting the real verdict (probe modes)
The hook can re-encode the body with **our** cipher and send it, so you learn — in a
browser Akamai trusts — whether our pipeline is accepted. Set a mode then reload:

| `__run('<mode>')` | Tests |
|-------------------|-------|
| `passthrough` | our cipher + transport, body unchanged. If `_abck` validates → cipher/transport are perfect. |
| `corrupt:section0` | is section0 server-checked? (still valid ⇒ not checked) |
| `corrupt:plain` | is the payload content checked? |
| `corrupt:meta` | is `meta` checked? |
| `mutate:k=v` | change one field `k` to `v` (isolate a single field's effect) |

`__run(m)` sets the mode, clears Akamai cookies (so `_abck` restarts at `-1`), and reloads.
Watch the `[abck]` console line: `status=-1` is invalid, `status` becoming `0`/positive is
**ACCEPTED**. (`_abck` may be httpOnly — read it in DevTools → Application → Cookies.)

## Harvesting valid sensors (the working path)
Probing established that **only fresh, unmodified bodies pass** — `passthrough` validates,
but every offline edit (`regen` timestamp, `replay` anchor-shift) is rejected because the
server checks timing against real session age (see [TIMING.md](TIMING.md)). So the reliable
product is a **harvester**, not an offline synthesizer:

1. Run in **capture mode** (default), let the page POST a sensor normally.
2. Console: `__harvest()` → downloads `harvest.json` (freshest body + endpoint + cookies).
3. Turn it into a request:
   ```sh
   go run . harvest capture/harvest.json     # prints a ready-to-POST curl (+ freshness check)
   ```
4. **POST it promptly** — `harvest` warns if the body is already stale (>30s); timing is
   checked against session age.

Caveats: a single body is one sensor in a sequence — Akamai's `_abck` usually validates over
several POSTs, so harvested bodies are most useful POSTed within the **same session** they
came from. For automation that just needs a valid `_abck`, the simplest harvest is to let the
browser session reach `status=0`, then reuse the resulting `_abck`/`bm_sz` cookies directly.

## Safety
- Only run against sites you are authorized to test.
- The cipher in this userscript mirrors [../sensor/cipher.go](../sensor/cipher.go); keep them
  in sync if either changes.
- `capture-real.json` / `harvest.json` contain your session cookies — **never commit them**
  (covered by [.gitignore](.gitignore)).
