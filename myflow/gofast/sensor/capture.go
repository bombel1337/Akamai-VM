package sensor

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// Capture mirrors the window.__cap object exported by capture/devtools-hook.user.js
// via __save(). It is the real-Chrome recording used to get past the static step-3
// wall (WORKFLOW.md phase 6).
type Capture struct {
	Posts []struct {
		URL    string `json:"url"`
		Body   string `json:"body"`
		Stack  string `json:"stack"`
		T      int64  `json:"t"`
		Cookie string `json:"cookie"`
	} `json:"posts"`
	Hashes []string `json:"hashes"` // encodeURIComponent inputs (SHA-256 preimages)
	Joins  []struct {
		Sep string `json:"sep"`
		Val string `json:"val"`
	} `json:"joins"` // Array.join results (assembled plaintext the cipher consumes)
	Digests []struct {
		Algo  string `json:"algo"`
		Out   string `json:"out"` // base64 of the digest
		InLen int    `json:"inLen"`
		InB64 string `json:"inB64"` // base64 of the digest input (the preimage)
	} `json:"digests"`
	B64s []struct {
		Out   string `json:"out"`   // base64 output
		InHex string `json:"inHex"` // hex of the btoa input
		Stack string `json:"stack"`
	} `json:"b64s"`
	UA string `json:"ua"`
}

// Harvest is the single freshest body exported by the hook's __harvest() — the working
// path (only fresh bodies pass), ready for immediate POST.
type Harvest struct {
	URL         string `json:"url"`
	Body        string `json:"body"`
	UA          string `json:"ua"`
	Cookie      string `json:"cookie"`
	T           int64  `json:"t"`           // when the sensor was sent in-browser
	HarvestedAt int64  `json:"harvestedAt"` // when __harvest() ran
}

// ParseHarvest reads a harvest.json, or falls back to the latest POST of a full capture.
func ParseHarvest(raw []byte) (*Harvest, error) {
	var h Harvest
	if err := json.Unmarshal(raw, &h); err == nil && h.Body != "" && h.URL != "" {
		return &h, nil
	}
	c, err := ParseCapture(raw)
	if err != nil || len(c.Posts) == 0 {
		return nil, fmt.Errorf("not a harvest.json and no POSTs in capture")
	}
	p := c.Posts[len(c.Posts)-1]
	return &Harvest{URL: p.URL, Body: p.Body, UA: c.UA, Cookie: p.Cookie, T: p.T}, nil
}

// ParseCapture unmarshals an exported capture-real.json.
func ParseCapture(raw []byte) (*Capture, error) {
	var c Capture
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse capture: %w", err)
	}
	return &c, nil
}

// CaptureReport is the cross-referenced analysis of one captured POST: which digest/
// btoa call produced its section0 (recovering the preimage), and whether its decoded
// plaintext matches a captured Array.join (confirming the assembly point).
type CaptureReport struct {
	PostIndex int
	Decode    DecodeResult
	// Section0 provenance:
	DigestPreimageB64 string // InB64 of the digest whose Out == section0 (the SHA-256 input)
	DigestInLen       int
	BtoaInputHex      string // InHex of the btoa whose Out == section0
	// Plaintext provenance:
	JoinMatch    bool   // a captured Array.join Val == decoded plain
	JoinSep      string // the separator used for that join
	JoinValuePos int    // index into Joins
}

// AnalyzeCapture cross-references each POST against the captured crypto/join calls.
func (c *Capture) AnalyzeCapture() []CaptureReport {
	reports := make([]CaptureReport, 0, len(c.Posts))
	for i, p := range c.Posts {
		sd := ExtractSensorData(p.Body)
		r := DecodeV3(sd)
		rep := CaptureReport{PostIndex: i, Decode: r}
		if r.OK {
			// section0 via crypto.subtle.digest
			for _, d := range c.Digests {
				if d.Out == r.Section0 {
					rep.DigestPreimageB64 = d.InB64
					rep.DigestInLen = d.InLen
					break
				}
			}
			// section0 via btoa (44-char base64 of 32 raw bytes)
			for _, b := range c.B64s {
				if b.Out == r.Section0 {
					rep.BtoaInputHex = b.InHex
					break
				}
			}
			// plaintext assembly via Array.join
			for j, jn := range c.Joins {
				if jn.Val == r.Plain {
					rep.JoinMatch = true
					rep.JoinSep = jn.Sep
					rep.JoinValuePos = j
					break
				}
			}
		}
		reports = append(reports, rep)
	}
	return reports
}

// PreimageHit records a captured string whose SHA-256 (base64) equals a target.
type PreimageHit struct {
	Source string // "joins" | "hashes"
	Index  int
	Sep    string // join separator, if Source == "joins"
	Value  string
}

// sha256B64 reproduces base64(SHA-256(utf8(s))) — the standard way section0-style
// fingerprint hashes are built. For ASCII (the plaintext is ASCII) Go's []byte(s) is
// already the UTF-8 the JS unescape(encodeURIComponent(s)) would produce.
func sha256B64(s string) string {
	sum := sha256.Sum256([]byte(s))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// FindSection0Preimage scans every captured Array.join value and encodeURIComponent
// input, hashing each, and returns those whose base64(SHA-256) equals target. This
// recovers section0's preimage when it is built with the script's own SHA-256/base64
// (so the WebCrypto/btoa hooks never saw it).
func (c *Capture) FindSection0Preimage(target string) []PreimageHit {
	var hits []PreimageHit
	for i, jn := range c.Joins {
		if sha256B64(jn.Val) == target {
			hits = append(hits, PreimageHit{Source: "joins", Index: i, Sep: jn.Sep, Value: jn.Val})
		}
	}
	for i, h := range c.Hashes {
		if sha256B64(h) == target {
			hits = append(hits, PreimageHit{Source: "hashes", Index: i, Value: h})
		}
	}
	return hits
}

// HashesMatchingSection0 returns encodeURIComponent inputs that, when treated as the
// SHA-256 preimage, are worth checking against a section0 (we cannot hash here without
// pulling in crypto, so we surface candidates whose length is plausible). Mostly a
// convenience dump; the digest cross-ref above is the authoritative path.
func (c *Capture) HashesSample(n int) []string {
	out := make([]string, 0, n)
	for _, h := range c.Hashes {
		if len(out) >= n {
			break
		}
		if l := len(strings.TrimSpace(h)); l > 0 {
			out = append(out, h)
		}
	}
	return out
}
