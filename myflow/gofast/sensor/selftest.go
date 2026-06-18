package sensor

import (
	"fmt"
	"strings"
)

// SelfTest regenerates the template's own inputs with a frozen timestamp and checks
// the result equals the body we'd assemble directly from the template — proving the
// substitution + cipher + assembly are faithful. Mirrors generate.js selftest().
// Returns (pass, detail).
func SelfTest() (bool, string) {
	o := tmpl.OrigInputs

	frozen := int64(tmpl.SeedExample) // placeholder; overwritten below if sc present
	if m := scRe.FindStringSubmatch(tmpl.Plain); len(m) > 1 {
		frozen = int64(atoiOr(m[1], 0))
	}

	sd, err := Generate(SensorInput{
		UserAgent: o.UserAgent,
		PageUrl:   "https://" + o.PageUrlHost,
		ScriptUrl: "https://www.zalando.pl/x/y/" + o.ScriptToken + "/z",
		Bmsz:      fmt.Sprintf("X~%d~Y", tmpl.SeedExample),
	}, frozen)
	if err != nil {
		return false, "generate error: " + err.Error()
	}

	expectBody := encodeV3(tmpl.Section0, tmpl.Meta, tmpl.SeedExample, tmpl.Plain)
	expect := tmpl.PrefixFixed + fmt.Sprintf("%d", tmpl.SeedExample) + ";" + expectBody

	if sd != expect {
		for i := 0; i < max(len(sd), len(expect)); i++ {
			if i >= len(sd) || i >= len(expect) || sd[i] != expect[i] {
				lo := max(0, i-10)
				return false, fmt.Sprintf("first diff @%d: %q vs %q",
					i, safeSlice(sd, lo, i+10), safeSlice(expect, lo, i+10))
			}
		}
		return false, "length mismatch"
	}

	dec := DecodeV3(sd)
	rt := dec.OK && strings.Contains(dec.Plain, `"adp"`)
	return true, fmt.Sprintf("regenerate==template (bit-exact); round-trip decode ok: %v", rt)
}

func safeSlice(s string, lo, hi int) string {
	if lo < 0 {
		lo = 0
	}
	if hi > len(s) {
		hi = len(s)
	}
	if lo > hi {
		return ""
	}
	return s[lo:hi]
}
