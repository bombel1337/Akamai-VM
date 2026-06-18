# Phase A findings — the current zalando v3 `sensor_data` is modern encryption

Captured sample: `myflow/babelflow/script/sensor_data.json`
(consistent with `script/script.js`, same page).

## Structure (decisive)
```
3;0;1;0;4339510;                              <- prefix (ver;..;k1;k2;seed/csv;)
VaqJVXmrDf/kMIPkyFYH+XOu787JyIAR5DfXMh9MoOQ=  <- section[0]: base64 of 32 bytes
4,22,0,0,1,168                                <- section[1]: metadata CSV (6 ints)
<80 high-entropy segments, ';'-separated>     <- section[2..81]: the payload
```
- Body = **82 `;`-sections**. section[0] base64-decodes to **exactly 32 bytes**
  (`55aa8955…1f4ca0e4`). section[1] is a small int CSV. The remaining 80 segments
  are the encrypted payload.
- Payload entropy ≈ **6.33 bits/char over 94 distinct chars** (max ≈6.55) → it is
  genuinely encrypted/random, **not** light obfuscation.

## What it is NOT
- **Not** the old LCG substitution+shuffle cipher (`akamai-sensor-verifier`):
  decoding with every prefix-key combo yields no `-1,2,-94,` marker.
- **Not** the `od`/`rir` digit-only cipher (`Akamai_Sensor_Generator/index.js`):
  that leaves letters/structure readable; this payload is high-entropy.

## What it most likely IS
A modern Akamai scheme where **section[0] is a 32-byte key/nonce/public key** and
the payload is encrypted under it. 32 bytes is exactly an **X25519 public key**
(ephemeral ECDH) or an AES-256 key / SHA-256 digest. The plaintext (the
`-1,2,-94,-NNN,` segment grid in `layout.js`) is AES/stream-encrypted with a key
derived from section[0] + a server secret embedded in `script.js`.

## Crypto primitives present in script.js (numeric signatures)
Searching raw `script.js` for hex constants (strings are hex-escaped and need
step-2 decode, but numbers are visible):
- `0x1b873593`, `0xcc9e2d51`  → **MurmurHash3** multipliers (c1/c2)
- `0x85ebca6b`, `0xc2b2ae35`  → **MurmurHash3** fmix finalizers
- `0xefbe4786`, `0xe9b5dba5`  → **SHA-256** round constants
- **No** AES S-box, **no** Curve25519 (`121665`).

So the payload is **not** AES/ECDH — it's a **hash-seeded keystream cipher**
(SHA-256 + MurmurHash3), the statically-reimplementable kind. Matches docs/04 §4
(`vx`=SHA-256, `pYU`=Murmur3).

## Consequence: static recovery IS feasible (earlier "infeasible" was wrong)
- **The key is client-side.** section[0] (32 bytes) ships in clear and is almost
  certainly a **SHA-256 digest** of known inputs; the keystream derives from it.
  Nothing depends on a server-only secret.
- **The crypto is identifiable** by the constants above (strings hidden, numbers
  not). The transform is arithmetic, reimplementable.
- **The plaintext is known** (`layout.js`). Known-plaintext + identified keystream
  primitives + client-side key ⇒ solvable.

### Static path (no dynamic execution required)
1. Run babelflow on `script.js` (beautify + hex-decode) to get readable source.
2. Locate the cipher routine via the MurmurHash3/SHA-256 constants and the
   `;`-join that produces the 82-section body; find where section[0] is built
   and where the `-1,2,-94,-NNN,` grid is consumed.
3. Reimplement section[0] (hash of inputs) + the keystream transform in `cipher.js`.
4. Verify with `analyze.js` against `script/sensor_data.json` (marker appears).

Dynamic capture (docs/03 puppeteer/`__REC`) remains a faster shortcut, not a
prerequisite. `layout.js` + `cipher.js` stay reusable.

## Located in out/05-simplified.js (current script)
| Line | Symbol | Role |
|------|--------|------|
| 1198 | `jC(s)` | additive checksum (sum of charCodeAt) — the `ab()` analog, field `-118` |
| 1205 | `jqx()` | encoded string pool (decoder-hidden; the step-3 wall) |
| 1214 | `bLx(s)` | `encode_utf8` = unescape(encodeURIComponent) — feeds the hashes |
| 1276 | `nnx`   | SHA-256 K-table; schedule at 1287-1294 |
| 9189/10493/10646 | — | MurmurHash3 (fmix `0x85ebca6b`; mults `0x1b873593`/`0xcc9e2d51`) |
| 10255 | — | `String.fromCharCode(this[..]())` char-stream emitter |
| 10450 | `sf(…, ';', …)` | a `;`-join over a decoder-hidden source (body assembly candidate) |

## Confirmed prefix semantics (sample `3;0;1;0;3158840;`)
Field 5 = **first numeric token of `bm_sz`** (`…~3158840~4605490`). So the prefix
is metadata, not the cipher key. section[0] (32 bytes) is **not** a plain SHA-256
of inputs (abck/bmsz/ua/pageurl, singles+pairs+salts all tested, no hit) → it is
hashed over the *plaintext grid* or produced by the keystream.

## ✅ SOLVED (dynamic capture, 2026-06-17)
The payload cipher is fully recovered and verified **bit-exact** (re-encode ==
original body) on both the standalone sample and live captures:
- **Hook**: `capture.js` wraps global `encodeURIComponent`/`Array.join`/XHR on the
  live page (no edits to script.js → self-hash intact). `crack2.js` aligned the
  `Array.join(":")` assembled plaintext (Δ0 length) with the payload.
- **Cipher** (`cipher.js` `decodeV3`/`encodeV3`): substitution over the 92-char
  ALPHABET, LCG keystream `key=(key*65793+4282663)&0x7FFFFF`, `rZ=(key>>8)&0xFFFF`,
  `idx±(rZ%92)`, advancing **every char**; chars **not** in the alphabet (`" '`)
  **pass through** (so JSON structure survives). **No shuffle layer.**
- **Seed** = prefix field[4] (the first `bm_sz` token, e.g. `3158840`).
- **Body** = `<prefix> <section0> ; <metaCsv> ; encryptSub(plaintext, seed)`.
- **Plaintext** = array of `{"field":value}` objects joined by `:`. section[0]
  (`ssh`) is a stable fingerprint hash carried in cleartext + inside the plaintext.

Remaining for from-scratch generation: reproduce the field VALUES (the JSON
fingerprint + behavioral fields) and section[0]/meta — the plaintext is now fully
readable, so this is field modeling, not crypto.

## Honest status (historical)
Feasibility of the *primitives* = proven (SHA-256/Murmur/hex/checksum in hand,
key client-side, plaintext layout known). BUT the **wiring** is the blocker:

### Cipher-path trace (where it ends)
- section[0] preimage built at 05-simplified.js:5806-5808 via `dD()[KI(VI)].call(...)`.
- `t5x` (11314) is **hex** encode (used for hex field hashes), not section[0]'s base64.
- decoder machinery: `dD()` @13790 (cached object), `KI(x)=qjm()[x]` @13889
  (state-free 2-char-key index — resolvable), `dD()[key]` = a decoder function
  installed at init that returns the real string **only with live runtime state**
  (cr stack, per-key cache, self-hash seed, init order).

### Conclusion
Every cipher-path operation (section[0], keystream, body join) routes through
`dD()[KI(...)]`. Resolving those = solving **step 3** (docs/03), which is the
project's documented blocker: the decoders only yield correct strings in the
script's authentic execution. Pure-static "generate from scratch" is therefore
gated on step 3, which static analysis cannot crack (verified out-of-flow across
Node/jsdom/Chromium in docs/03, and re-confirmed by this trace).

### Real options
1. **Dynamic**: run the script once with `dD()`/`bG`/emitter hooked → captures the
   decoded method names + section[0] preimage + keystream. Unblocks everything.
2. **Solve step 3** (the project's open hard problem) — large, uncertain.
3. **Use a maintained solver** (Hyper SDK) for this version.

`layout.js`, `cipher.js`, `analyze.js` remain the ready decoder/encoder once the
scheme is known by either route.
