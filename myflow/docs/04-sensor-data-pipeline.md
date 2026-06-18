# Step 4 — The sensor-data generation pipeline (map)

> Research documentation for `myflow/`, for **authorized testing of one's own
> Akamai-protected site**. This maps *how* the script collects, encodes, and
> submits its telemetry, with `script.step2.js` line references. Where the
> per-family string decoder (see [03](03-inline-string-accessors.md)) hides
> meaning, that is **marked explicitly** rather than guessed; those gaps are best
> filled by a real captured sample from your own site (see *Grounding* at the end).

## 0. Headline finding — what this script actually is
This is **not** the classic Akamai `bmak` script that POSTs a big `sensor_data`
blob. It is the **SBSD / CPR bootstrap-and-rotate orchestrator**:

- It reads **its own `<script>` URL** and query params, picks an endpoint, and
  runs a **heartbeat** that polls a small JSON config from the server.
- Telemetry/proof is carried in an **`x` query parameter** (SBSD style), not a
  POST body. The server response chain-loads the **next** script version.
- It also implements the **CPR interstitial challenge** (the `sec-cpr-overlay`
  iframe) by watching page traffic for HTTP `429`.

So "generate sensor_data" here means: produce the **`x` token** and drive the
poll/rotate/challenge lifecycle. The heavy fingerprint/behavioral *values* are
computed through the obfuscated VM and remain decoder-hidden in static form.

## 1. Network lifecycle (statically recovered)

```
 page loads script  (URL carries ?ch=<config>&x=<token>)
        │
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ BOOTSTRAP  (dispatcher case @ ~6040)                         │
 │  dHU  = own <script> src            (6067-6068)              │
 │  NcU  = dHU.indexOf('/.well-known/sbsd') > -1   (6069)       │
 │  zzU  = NcU ? j9U(SBSD) : wNU(standard)         (6047,6070)  │
 │  LAU  = param 'ch' from dHU ; kQU = param 'x'   (6071-6072)  │
 │  PR.init(dHU, LAU, …)   ← CPR manager           (6073)       │
 │  xZ(null, kQU, LAU)     ← seed token hQ = x-param(6075,2446) │
 │  addEventListener focus/blur → wQU              (6079-6080)  │
 │  setInterval(ETU, mbU)  ← heartbeat             (6083)       │
 └─────────────────────────────────────────────────────────────┘
        │  heartbeat / focus
        ▼
 ETU (5873)  throttle → setTimeout(GsU, 0)
        │
        ▼
 GsU (3128)  XHR  GET  zzU + '?s=true'  ;  send()        (3133-3137)
        │  onreadystatechange: readyState>3 && status==200
        ▼
 qUU (5883)  JSON.parse(response)
        │  response[jNU] = next script URL (JFU)?
        ├── yes → <script src = JFU + '&x=' + SCU()> ; teardown   (5890-5906)
        │         SCU() (5318) = hQ  ← the carried token
        └── no  → re-arm: xZ(null, SCU(), LAU)                    (5907-5911)

 CPR CHALLENGE (parallel):
 lzU (3013) hooks XMLHttpRequest.prototype.open ; k5U (3040) hooks fetch
   → on response status 429 → jrU (3075)
        → build overlay iframe #sec-cpr-overlay, attr challenge =
          btoa(JSON.stringify(resp)), src = resp.url            (3093-3119)
```

Key endpoints/inputs:
| Thing | Where | Notes |
|------|-------|------|
| Endpoint URL `zzU` | 6047-6070 | `wNU` (standard) vs `j9U` (SBSD `/.well-known/sbsd`); both **decoder-hidden** |
| Script URL `dHU` | 6067-6068 | own `currentScript.src`; source of config |
| Config params | 6071-6072 | `ch` → `LAU`; `x` → `kQU` (initial token) |
| Heartbeat | 5873, 6083 | `ETU` via `setInterval(…, mbU)` |
| Poll request | 3133 | `GET zzU?s=true` (no body) |
| Submission channel | 5891 | `&x=` + `SCU()` on the **next-script** URL (the token) |
| Response handler | 5883 | `qUU` → rotate script or re-arm |
| Challenge UI | 3075-3119 | CPR overlay iframe on HTTP 429 |

## 2. Collection surface

**Behavioral events** — only these event types appear in plain text:
`readystatechange` (3018), `loadend` (3024), `message` (3119), `focus`/`blur`
(6079-6080), `load` (removed at 3070). The **mouse / keyboard / touch / scroll /
visibility** handlers are wired through `['addEventListener'](<decoded type>, …)`
where the event-type string is **decoder-hidden** — present but not statically
readable.

**Field registry `IzU`** (6044): a 14-entry table built from `Fs(zI, [ <name>,
<collector>, <type>, <slot> ])` tuples — i.e. the **sensor field definitions**.
Names/types are decoder-hidden; the *structure* (14 fields, name→collector→slot)
is clear. Collectors include `c9U/FFU/AQU/V4U/E4U/OTU/l9U/r3U/qSU/gcU/QHU/kSU/FAU`.

**Device/automation fingerprint** — read as `G7[<decoded prop>]…` throughout
`xZ` (2446), `wn` (4648), and the bootstrap. All property names are
decoder-hidden. Categories implied by structure: window/navigator presence and
method checks, visibility/focus, and automation tells (the `xZ` guards branch on
several `G7[…]` lookups before scheduling `wn`).

## 3. Encoding VM (see [03](03-inline-string-accessors.md))
Field values flow through the script's **bytecode VM**: the `S9`/`Dz`
`switch (OI)` dispatcher, driven by wrapper functions of the form
`return S9.apply(this, [CASE, arguments])`. Strings/method-names are produced by
**per-family stateful decoders** (`vF`/`vCU`+`SSU`, `Vb`→`UmU`, `IC`, `Ct`),
detailed in doc 03. The decoders are why the field names, property reads, and
endpoint above are opaque to static analysis.

## 4. Crypto / integrity (statically confirmed)
| Primitive | Symbol | Where | Evidence |
|-----------|--------|-------|----------|
| **SHA-256** | `vx` | 1785 | 64-entry round table `0x428a2f98…` (1786), IVs `0x6a09e667…0x5be0cd19`, `0x80` padding, 16-word schedule |
| **MurmurHash3 (x86-32)** | `pYU` | 6103 | state-machine over a string + seed; constants `0x1b873593`/`0xcc9e2d51`, `rotl13` (round fns `tKU`/`JhU`/`SpU`) |
| **Anti-tamper self-hash (seed)** | `B`/`HpU`/`VwU` | 127, 11168, 6239 | `B() = 122783220 − murmur3(self_source, 875960)`; `VwU` feeds nearly the whole function source to `pYU`; anchor literal `0xeefb964, 122783220;`. Tampering with the script text changes the seed → the VM decodes to garbage (see doc 03). |

SHA-256 (`vx`) is applied to produce a digest (integrity/proof field); MurmurHash3
serves both the decoder seed and (likely) lightweight payload checksums.

## 5. Submission & output format
- **Channel:** the token `hQ` (returned by `SCU()`, 5318) is appended as
  `&x=<token>` to the **next script URL** (5891); the poll itself is `GET
  zzU?s=true` (3133). This is the SBSD token-relay model — there is no classic
  `sensor_data` POST body in this script.
- **`hQ` token:** seeded from the URL `x` param (`xZ`, 2446/6075), advanced by the
  proof step `wn` (4648, decoder-hidden), relayed forward on each rotation.
- **Challenge payload:** for the CPR path, `btoa(JSON.stringify(serverResp))` is
  handed to the overlay iframe's `challenge` attribute (3108).

## 6. What stays decoder-hidden (honest gaps)
Static analysis cannot, on its own, recover: the **endpoint URLs** (`wNU`/`j9U`),
the **field names** in `IzU`, the **fingerprint property list**, the exact
**`x`-token format**, and the behavioral **event types**. All sit behind the
unsolved per-family decoder (doc 03). The *architecture, flow, crypto, and
submission channel above are solid*; the *semantic labels* need grounding.

### Grounding with a real sample (your own authorized site)
From browser DevTools on your site, capture:
1. the request that carries the `x` token (the rotating `…&x=<token>` script load,
   and/or the `…?s=true` poll) — gives the **endpoint** and **token format**;
2. one CPR `429` response JSON, if the challenge path triggers — matches `jrU`;
3. the loading `<script>` URL — confirms the `ch`/`x` params.
Cross-referencing those against §1/§5 labels the endpoint and token concretely;
fully resolving field names/fingerprint props additionally requires running the
script in-context to capture decoder output (the doc-03 path, out of scope here).

## Landmark index (`script.step2.js`)
| Symbol | Line | Role |
|--------|------|------|
| bootstrap case | ~6040 | endpoint/param setup, listeners, heartbeat |
| `zzU` / `NcU` | 6069-6070 | endpoint selection (standard vs SBSD) |
| `IzU` | 6044 | 14-field sensor registry |
| `ETU` | 5873 | heartbeat → `GsU` |
| `GsU` | 3128 | `GET zzU?s=true` |
| `qUU` | 5883 | response handler / script rotation |
| `SCU` / `hQ` | 5318 / 5974 | the `x` token getter / accumulator |
| `xZ` / `wn` | 2446 / 4648 | token seed + scheduler / proof step |
| `lzU` / `k5U` / `jrU` | 3013 / 3040 / 3075 | XHR & fetch 429 hooks → CPR overlay |
| `vx` | 1785 | SHA-256 |
| `pYU` | 6103 | MurmurHash3 |
| `S9`/`Dz` | (VM dispatcher) | bytecode engine driving collection/encoding |
