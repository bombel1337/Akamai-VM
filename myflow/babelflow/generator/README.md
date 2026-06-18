# Akamai v3 `sensor_data` generator (from scratch)

`Generate(SensorInput) -> sensor_data` for the modern (2026) Akamai web sensor,
built by decoding the live `script.js` — no Hyper SDK. The cipher was recovered
by dynamic capture and reimplemented statically (see [FINDINGS.md](FINDINGS.md)).

## Files
| File | Role |
|------|------|
| `cipher.js`     | the solved codec: `decodeV3` / `encodeV3` (+ `encryptSub`/`decryptSub`) |
| `generate.js`   | **the generator**: `generate(input)` -> sensor_data; `--selftest` |
| `template.json` | device profile = a real decoded first-POST sensor (your machine) |
| `devtools-hook.user.js` | **real-Chrome** capture/passthrough/mutate (Tampermonkey, document-start) — Akamai trusts real Chrome; use this for the verdict + execution-order stacks + section0 preimage |
| `validate.js`   | puppeteer swap harness — **bot-flagged by Akamai** (never validates); kept for offline checks only, not a real verdict |
| `capture.js`    | live-page hook that produced the template (puppeteer) |
| `crack2.js`     | keystream recovery from a capture (how the cipher was solved) |
| `analyze.js`    | `node analyze.js <sensor_data.json>` -> decode + dump fields |
| `input.json`    | editable SensorInput for `generate.js --file input.json` |
| `capture-out.json` | raw captures from `capture.js` (input to `crack2.js`) |

## Usage
```sh
# library
const { generate } = require('./generate');
const sensor = generate({
  ScriptUrl, PageUrl, UserAgent, Abck, Bmsz, Version: '3', AcceptLanguage, IP,
});

# CLI (e.g. to shell out from Go)
node generate.js '{"ScriptUrl":"...","PageUrl":"...","UserAgent":"...","Bmsz":"..~3158840~..","AcceptLanguage":"en-US","Abck":"...","IP":"..."}'
node generate.js --selftest      # must print PASS
```

## How it works
`sensor_data = "3;0;1;0;<seed>;" + section0 + ";" + meta + ";" + encryptSub(plaintext, seed)`

- **cipher**: substitution over a 92-char alphabet, LCG keystream
  `key=(key*65793+4282663)&0x7FFFFF`, `rZ=(key>>8)&0xFFFF`, `idx±(rZ%92)`, advancing
  every char; chars outside the alphabet (`" '`) pass through. No shuffle.
- **seed** = first numeric token of `Bmsz`.
- **plaintext** = list of `{"field":value}` objects joined by `:` (the device
  fingerprint). Comes from `template.json`, with input fields substituted.

### Input mapping (where each field belongs, and what generate.js does TODAY)
| SensorInput | belongs to | generate.js today |
|---|---|---|
| `Bmsz` | cipher seed (prefix field 4) | **required** — seed |
| `UserAgent` | `adp`/`version` fields | substituted if present |
| `PageUrl` | url field (`mwd`/`oev`) | substituted if present |
| `ScriptUrl` | script path token (`swi`/`i1`) | substituted if present |
| `AcceptLanguage` | navigator locale (`ver`/lang) | primary locale substituted (e.g. `en-US`) |
| `Abck`, `IP`, `Version` | not in the sensor body | ignored |
| GPU/screen/canvas/timezone/plugins | device profile | from template (not from input) |

Minimal call needs only `Bmsz`; the rest fall back to template values.

## Status / what to refine before it passes Akamai
Structurally correct (decodes + round-trips bit-exact). NOT yet validated live.
Still copied from the template (model these for acceptance):
- behavioral/timing fields: mouse traces (`s036`), `dau`, `tid`, counters, `meta`
  (only `sc` ms-epoch is refreshed today).
- `section0`/`ssh`: a stable fingerprint hash — reuse is fine while the device
  profile is unchanged; recompute if you mutate profile fields.

To refine: capture several POSTs (`capture.js`), decode each (`analyze.js`), diff
to classify fields static vs dynamic, and regenerate the dynamic ones in
`generate.js`. Real pass/fail = POST it and check `_abck` loses the `~-1~` and
becomes valid (see `zalando-solutions` `IsCookieValid`).

## Regenerating the template (new device/UA)
```sh
node capture.js            # on the authorized page; writes capture-out.json
# then rebuild template.json from a decoded capture (see crack2.js / analyze.js)
```
Only run captures/POSTs against sites you are authorized to test.
