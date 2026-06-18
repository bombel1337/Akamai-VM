package sensor

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// SensorInput is the public contract (matches script/input.json and babelflow's
// SensorInput). Only Bmsz is required (its first numeric token is the cipher seed);
// the rest fall back to template values.
type SensorInput struct {
	ScriptUrl      string `json:"ScriptUrl"`
	PageUrl        string `json:"PageUrl"`
	UserAgent      string `json:"UserAgent"`
	Abck           string `json:"Abck"`
	Bmsz           string `json:"Bmsz"`
	Version        string `json:"Version"`
	AcceptLanguage string `json:"AcceptLanguage"`
}

// template mirrors template.json. The device profile is fixed; input-derived and
// dynamic fields are substituted at generate time.
type template struct {
	PrefixFixed string `json:"prefixFixed"`
	Section0    string `json:"section0"`
	Meta        string `json:"meta"`
	SeedExample int    `json:"seedExample"`
	OrigInputs  struct {
		UserAgent   string `json:"UserAgent"`
		PageUrlHost string `json:"PageUrlHost"`
		ScriptToken string `json:"ScriptToken"`
		Locale      string `json:"Locale"`
		Bmsz        string `json:"Bmsz"`
	} `json:"origInputs"`
	Plain string `json:"plain"`
}

//go:embed template.json
var templateJSON []byte

var tmpl = func() template {
	var t template
	if err := json.Unmarshal(templateJSON, &t); err != nil {
		panic("sensor: bad embedded template.json: " + err.Error())
	}
	return t
}()

// prefix field layout: <ver>;<a>;<b>;<c>;<seed>;[,…]; — field[4] is the cipher seed.
var prefixRe = regexp.MustCompile(`\d+(;\d+)?;(\d+);(\d+);[\d,]+;`)

const seedField = 4

var (
	scRe     = regexp.MustCompile(`sc:(\d{13})`)
	localeRe = regexp.MustCompile(`^\s*([A-Za-z]{2}(?:-[A-Za-z]{2,})?)`)
	digitsRe = regexp.MustCompile(`^\d+$`)
	segOK    = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

func atoiOr(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

// bmszSeed extracts the cipher seed: the first numeric '~'-token, e.g.
// "<hex>~3158840~4605490" -> 3158840. (Not a regex over the whole string — the
// leading hex contains digit runs.)
func bmszSeed(bmsz string) (int, error) {
	parts := strings.Split(bmsz, "~")
	for _, p := range parts[1:] {
		if digitsRe.MatchString(p) {
			return strconv.Atoi(p)
		}
	}
	if len(parts) > 0 && digitsRe.MatchString(parts[0]) {
		return strconv.Atoi(parts[0])
	}
	return 0, fmt.Errorf("cannot extract bm_sz seed token from: %s", bmsz)
}

// scriptToken picks the script-path token from ScriptUrl, matching the template
// token's shape (>=12 chars, [A-Za-z0-9_-]); falls back to the template token.
func scriptToken(scriptURL, tmplToken string) string {
	u, err := url.Parse(scriptURL)
	if err != nil {
		return tmplToken
	}
	for _, s := range strings.Split(u.Path, "/") {
		if len(s) >= 12 && segOK.MatchString(s) {
			return s
		}
	}
	return tmplToken
}

// pageHost strips the scheme (the template stores host+path without scheme).
func pageHost(pageURL string) string {
	return regexp.MustCompile(`^https?://`).ReplaceAllString(pageURL, "")
}

// primaryLocale extracts the primary locale: "en-US,en;q=0.9" -> "en-US".
func primaryLocale(acceptLanguage string) string {
	m := localeRe.FindStringSubmatch(acceptLanguage)
	if len(m) > 1 {
		return m[1]
	}
	return ""
}

// Generate builds a v3 sensor_data body from input, using nowMs as the refreshed
// `sc` ms-epoch timestamp. Mirrors generate.js generate().
func Generate(input SensorInput, nowMs int64) (string, error) {
	plain := tmpl.Plain
	o := tmpl.OrigInputs

	// 1) input-derived substitutions (verbatim string replace)
	if input.UserAgent != "" {
		plain = strings.ReplaceAll(plain, o.UserAgent, input.UserAgent)
	}
	if input.PageUrl != "" {
		plain = strings.ReplaceAll(plain, o.PageUrlHost, pageHost(input.PageUrl))
	}
	if input.ScriptUrl != "" {
		plain = strings.ReplaceAll(plain, o.ScriptToken, scriptToken(input.ScriptUrl, o.ScriptToken))
	}
	if input.AcceptLanguage != "" && o.Locale != "" {
		if loc := primaryLocale(input.AcceptLanguage); loc != "" {
			plain = strings.ReplaceAll(plain, o.Locale, loc)
		}
	}

	// 2) refresh the confirmed dynamic timestamp (`sc`). Other time/counter fields
	// (dau, tid, …) have unknown derivations and stay at template values for now.
	plain = scRe.ReplaceAllString(plain, "sc:"+strconv.FormatInt(nowMs, 10))

	// 3) seed from Bmsz, assemble + encrypt
	seed, err := bmszSeed(input.Bmsz)
	if err != nil {
		return "", err
	}
	body := encodeV3(tmpl.Section0, tmpl.Meta, seed, plain)
	return tmpl.PrefixFixed + strconv.Itoa(seed) + ";" + body, nil
}

// epochRe matches a maximal digit run; Regen filters for 13-digit ms-epochs by value.
var digitRunRe = regexp.MustCompile(`\d+`)

// refreshEpochs replaces every 13-digit ms-epoch-looking number (1[78]xxxxxxxxxxx,
// i.e. 2023–2027) with nowMs. We target by VALUE, not by the `sc:` label, because the
// transposed plaintext de-correlates labels from values (the `sc:` label sits next to
// junk while the real timestamp is in another slot). delta keeps relative offsets if
// you later want multiple timestamps staggered; for now all move to nowMs.
func refreshEpochs(plain string, nowMs int64) (string, int) {
	now := strconv.FormatInt(nowMs, 10)
	n := 0
	out := digitRunRe.ReplaceAllStringFunc(plain, func(run string) string {
		if len(run) == 13 && (run[0] == '1') && (run[1] == '7' || run[1] == '8') {
			n++
			return now
		}
		return run
	})
	return out, n
}

var anchorEpochRe = regexp.MustCompile(`1[78]\d{11}`)

// ShiftAnchor implements the coherent-replay transform (TIMING.md): keep section0/seed
// and all relative timers/behavioral offsets, and shift ONLY the session-anchor epoch by
// deltaMs. Replaying a captured body at time T with deltaMs = T − originalSend keeps
// (T − anchorNew) == originalElapsed, so the elapsed field and offsets stay coherent —
// one field changed instead of the whole timing group. Returns body, old/new anchor, and
// how many anchor occurrences were shifted (expect 1). Risk to verify live: if section0
// binds the anchor, shifting it invalidates section0 (then fall back to timer-shifting).
func ShiftAnchor(sensorData string, deltaMs int64) (string, int64, int64, int, error) {
	r := DecodeV3(sensorData)
	if !r.OK {
		return "", 0, 0, 0, fmt.Errorf("decode capture: %s", r.Reason)
	}
	anchorStr := anchorEpochRe.FindString(r.Plain)
	if anchorStr == "" {
		return "", 0, 0, 0, fmt.Errorf("no anchor epoch (1[78]xxxxxxxxxxx) found in plaintext")
	}
	anchor, _ := strconv.ParseInt(anchorStr, 10, 64)
	newAnchor := anchor + deltaMs
	newStr := strconv.FormatInt(newAnchor, 10)
	plain := strings.ReplaceAll(r.Plain, anchorStr, newStr)
	n := strings.Count(r.Plain, anchorStr)
	return r.Prefix + encodeV3(r.Section0, r.Meta, r.Seed, plain), anchor, newAnchor, n, nil
}

// Regen is capture-assisted generation: decode a real captured sensor_data, keep its
// section0/meta/seed (section0 is server-checked and session-stable, so it must be a
// real one), refresh the dynamic ms-epoch timestamp(s) to nowMs, and re-encode. Unlike
// Generate (template/from-scratch, whose stale section0 fails the check), this reuses a
// valid captured fingerprint. Returns the body and how many timestamps were refreshed.
func Regen(sensorData string, nowMs int64) (string, int, error) {
	r := DecodeV3(sensorData)
	if !r.OK {
		return "", 0, fmt.Errorf("decode capture: %s", r.Reason)
	}
	plain, n := refreshEpochs(r.Plain, nowMs)
	return r.Prefix + encodeV3(r.Section0, r.Meta, r.Seed, plain), n, nil
}
