package sensor

import (
	"regexp"
	"sort"
	"strconv"
)

// Timing model (recovered 2026-06-19 from a 4-POST capture). A v3 sensor's time data
// splits into:
//   - a session ANCHOR epoch: one 13-digit ms-epoch (1[78]xxxxxxxxxxx) identical across
//     every POST in a session — set once at sensor init (≈ navigationStart). Reuse it;
//     do NOT bump it per-POST (that breaks coherence — see WORKFLOW.md phase 8).
//   - ELAPSED timers: per-POST relative values ≈ (sendTime − anchor); these carry the
//     freshness the server checks. POST#2 showed token 1303 vs elapsed 1302 (1ms).
//   - static device tokens: reuse from the capture.
//   - behavioral traces: relative offsets inside [0, elapsed] (the hard modeling).
//
// timemap surfaces the anchor and, per POST, the tokens closest to the expected elapsed
// so the coupled timing group can be identified before attempting a coherent refresh.

var digit13Epoch = regexp.MustCompile(`^1[78]\d{11}$`)

// PostTiming is the timing analysis of one captured POST. Candidate timers exclude
// session-static tokens (a per-POST timer cannot be constant across POSTs).
type PostTiming struct {
	Index           int
	SendMs          int64   // post.t (hook Date.now at send)
	ExpectedElapsed int64   // SendMs - anchor
	Closest         int64   // token nearest ExpectedElapsed (prime "current elapsed" field)
	ClosestDelta    int64   // |Closest - ExpectedElapsed|
	Tight           []int64 // tokens within a tight band (±max(25,2%)) — high-confidence "head" timers
	NearCount       int     // tokens within the loose window (behavioral group size)
	NearElapsed     []int64 // loose-window tokens, nearest first (capped)
}

// TimeMapReport is the session-wide timing model.
type TimeMapReport struct {
	Anchor       int64 // the session-static ms-epoch, 0 if none common to all posts
	AnchorStable bool  // true if exactly one 13-digit epoch is shared by every POST
	Posts        []PostTiming
	StaticTokens int // count of 4+digit tokens present in every POST (reusable)
	TotalTokens  int
}

func intTokens(plain string) []string { return digitRunRe.FindAllString(plain, -1) }

// TimeMap builds the timing model from a capture's decoded POSTs.
func (c *Capture) TimeMap() TimeMapReport {
	type postData struct {
		t      int64
		tokens []string
		set    map[string]bool
	}
	var pds []postData
	for _, p := range c.Posts {
		r := DecodeV3(ExtractSensorData(p.Body))
		if !r.OK {
			continue
		}
		toks := intTokens(r.Plain)
		set := make(map[string]bool, len(toks))
		for _, t := range toks {
			set[t] = true
		}
		pds = append(pds, postData{t: p.T, tokens: toks, set: set})
	}

	rep := TimeMapReport{}
	if len(pds) == 0 {
		return rep
	}

	// anchor = the 13-digit epoch present in every POST (intersection)
	epochCount := map[string]int{}
	for _, pd := range pds {
		seen := map[string]bool{}
		for _, t := range pd.tokens {
			if digit13Epoch.MatchString(t) && !seen[t] {
				seen[t] = true
				epochCount[t]++
			}
		}
	}
	var common []string
	for e, n := range epochCount {
		if n == len(pds) {
			common = append(common, e)
		}
	}
	if len(common) == 1 {
		rep.Anchor, _ = strconv.ParseInt(common[0], 10, 64)
		rep.AnchorStable = true
	}

	// static token set: any token present in EVERY POST can't be a per-POST timer, so
	// exclude it from timing candidates (and count the 4+digit ones as reusable device data).
	staticSet := map[string]bool{}
	union := map[string]bool{}
	for tok := range pds[0].set {
		inAll := true
		for _, pd := range pds[1:] {
			if !pd.set[tok] {
				inAll = false
				break
			}
		}
		if inAll {
			staticSet[tok] = true
		}
	}
	for _, pd := range pds {
		for tok := range pd.set {
			if len(tok) >= 4 {
				union[tok] = true
			}
		}
	}
	rep.TotalTokens = len(union)
	for tok := range union {
		if staticSet[tok] {
			rep.StaticTokens++
		}
	}

	// per-POST elapsed candidates (excluding static tokens)
	for i, pd := range pds {
		pt := PostTiming{Index: i, SendMs: pd.t}
		if rep.Anchor != 0 {
			pt.ExpectedElapsed = pd.t - rep.Anchor
			loose := int64(150)
			if e := pt.ExpectedElapsed * 3 / 10; e > loose {
				loose = e
			}
			tight := int64(25)
			if e := pt.ExpectedElapsed * 2 / 100; e > tight {
				tight = e
			}
			seen := map[int64]bool{}
			for _, t := range pd.tokens {
				if len(t) > 9 || staticSet[t] {
					continue
				}
				v, err := strconv.ParseInt(t, 10, 64)
				if err != nil || v <= 5 || seen[v] {
					continue
				}
				d := abs64(v - pt.ExpectedElapsed)
				if d <= loose {
					seen[v] = true
					pt.NearElapsed = append(pt.NearElapsed, v)
					if d <= tight {
						pt.Tight = append(pt.Tight, v)
					}
				}
			}
			byDist := func(s []int64) func(a, b int) bool {
				return func(a, b int) bool { return abs64(s[a]-pt.ExpectedElapsed) < abs64(s[b]-pt.ExpectedElapsed) }
			}
			sort.Slice(pt.NearElapsed, byDist(pt.NearElapsed))
			sort.Slice(pt.Tight, byDist(pt.Tight))
			pt.NearCount = len(pt.NearElapsed)
			if pt.NearCount > 0 {
				pt.Closest = pt.NearElapsed[0]
				pt.ClosestDelta = abs64(pt.Closest - pt.ExpectedElapsed)
			}
			if len(pt.NearElapsed) > 12 {
				pt.NearElapsed = pt.NearElapsed[:12]
			}
		}
		rep.Posts = append(rep.Posts, pt)
	}
	return rep
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
