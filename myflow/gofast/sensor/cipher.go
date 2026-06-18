// Package sensor generates a v3 Akamai sensor_data body from a SensorInput, by
// substituting input-derived fields into a captured device-profile template and
// re-encrypting with the recovered v3 cipher. Ported from
// ../../babelflow/generator/{cipher.js,generate.js} (verified bit-exact there).
//
// See WORKFLOW.md phases 5 & 7. The cipher is solved; producing an *accepted*
// sensor still needs a fresh bm_sz, a real device template, and dynamic-field
// modeling (phase 6) — this package covers the static assembly only.
package sensor

import "strings"

// alphabet is the 92-char substitution alphabet. It excludes " and ' (which pass
// through so the JSON structure of the plaintext survives). The leading char is a
// space. Must match cipher.js ALPHABET exactly.
const alphabet = " !#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~"

const alphaN = len(alphabet) // 92

// charIndex maps a byte value to its position in alphabet, or -1 if absent.
var charIndex = func() [256]int {
	var t [256]int
	for i := range t {
		t[i] = -1
	}
	for i := 0; i < len(alphabet); i++ {
		t[alphabet[i]] = i
	}
	return t
}()

// LCG keystream constants — key = (key*mul + add) & mask. Update only if a fresh
// sample fails to decode (cipher.js Phase A note).
const (
	lcgMul  = 65793
	lcgAdd  = 4282663
	lcgMask = 8388607 // 0x7FFFFF
)

func advance(k int) int { return (k*lcgMul + lcgAdd) & lcgMask }

// decryptSub / encryptSub: substitution over alphabet, keystream advances on EVERY
// code unit; code units not in the alphabet pass through unchanged. We iterate
// runes to mirror JS charCodeAt for BMP text (plaintext is ASCII, so rune == byte).

func encryptSub(data string, key int) string {
	var b strings.Builder
	for _, r := range data {
		rZ := (key >> 8) & 65535
		key = advance(key)
		idx := -1
		if r < 256 {
			idx = charIndex[r]
		}
		if idx == -1 {
			b.WriteRune(r)
			continue
		}
		b.WriteByte(alphabet[(idx+rZ%alphaN)%alphaN])
	}
	return b.String()
}

func decryptSub(data string, key int) string {
	var b strings.Builder
	for _, r := range data {
		rZ := (key >> 8) & 65535
		key = advance(key)
		idx := -1
		if r < 256 {
			idx = charIndex[r]
		}
		if idx == -1 {
			b.WriteRune(r)
			continue
		}
		b.WriteByte(alphabet[((idx-rZ%alphaN)%alphaN+alphaN)%alphaN])
	}
	return b.String()
}

// encodeV3 builds the body (without the "3;0;1;0;<seed>;" prefix):
// section0 ; metaCsv ; encryptSub(plain, seed).
func encodeV3(section0, meta string, seed int, plain string) string {
	return strings.Join([]string{section0, meta, encryptSub(plain, seed)}, ";")
}

// DecodeResult is the readable decomposition of a v3 sensor_data body.
type DecodeResult struct {
	OK       bool
	Prefix   string
	Section0 string
	Meta     string
	Seed     int
	Plain    string
	Reason   string
}

// DecodeV3 reverses a full sensor_data string into its sections + readable plain.
// The seed is prefix field[4] (the first numeric bm_sz token); fields a/b/c are not
// cipher keys and there is no shuffle layer.
func DecodeV3(sensorData string) DecodeResult {
	m := prefixRe.FindString(sensorData)
	if m == "" {
		return DecodeResult{Reason: "prefix not matched"}
	}
	fields := strings.Split(m, ";")
	seed := atoiOr(fields[seedField], 0)
	sec := strings.Split(sensorData[len(m):], ";")
	if len(sec) < 3 {
		return DecodeResult{Reason: "too few sections"}
	}
	payload := strings.Join(sec[2:], ";")
	return DecodeResult{
		OK: true, Prefix: m, Section0: sec[0], Meta: sec[1],
		Seed: seed, Plain: decryptSub(payload, seed),
	}
}
