// Command gofast drives the Akamai sensor toolchain. Subcommands:
//
//	gofast              # (default) staged static deobfuscation -> out/ + script.final.js
//	gofast deobfuscate  # same as default, explicit
//	gofast generate     # script/input.json -> a v3 sensor_data body (stdout)
//	gofast selftest     # verify the cipher/generator round-trips bit-exact
//	gofast analyze <f>  # decode a captured sensor_data + dump its field grid
//	gofast diff <f...>  # decode 2+ captures + classify fields static vs dynamic
//	gofast capture-analyze <f>  # cross-ref a real-Chrome capture-real.json
//	gofast regen <f>    # capture -> refresh sc -> re-encode: a ready-to-POST sensor
//	gofast timemap <f>  # model the timing fields (anchor / elapsed / static) in a capture
//	gofast shift <f>    # coherent-replay: shift the anchor so a captured body is fresh now
//	gofast harvest <f>  # harvest.json -> validate + emit a ready-to-POST curl (the working path)
//	gofast serve        # HTTP API: POST /sensor with an input.json body -> sensor_data string
//
// See WORKFLOW.md for the full roadmap. Deobfuscation covers phase 2; generate/
// selftest cover phases 5 & 7 (the cipher is solved; an *accepted* sensor still
// needs a fresh bm_sz + real template + dynamic-field modeling, phase 6).
//
//	cd myflow/gofast && go run . [subcommand]
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gofast/pipeline"
	"gofast/sensor"
)

const (
	inputPath = "script/script.js"
	outDir    = "out"
	finalPath = "script.final.js"
	inputJSON = "script/input.json"
)

func main() {
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "", "deobfuscate", "deob":
		err = run()
	case "generate", "gen":
		err = runGenerate()
	case "selftest":
		err = runSelfTest()
	case "analyze":
		err = runAnalyze(os.Args[2:])
	case "diff":
		err = runDiff(os.Args[2:])
	case "capture-analyze", "cap":
		err = runCaptureAnalyze(os.Args[2:])
	case "regen":
		err = runRegen(os.Args[2:])
	case "timemap":
		err = runTimeMap(os.Args[2:])
	case "shift":
		err = runShift(os.Args[2:])
	case "harvest":
		err = runHarvest(os.Args[2:])
	case "serve":
		err = runServe(os.Args[2:])
	default:
		fmt.Fprintf(os.Stderr, "gofast: unknown subcommand %q (want: deobfuscate | generate | selftest | serve)\n", cmd)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "gofast:", err)
		os.Exit(1)
	}
}

// runGenerate reads script/input.json and writes a v3 sensor_data body to stdout.
func runGenerate() error {
	raw, err := os.ReadFile(inputJSON)
	if err != nil {
		return fmt.Errorf("read %s: %w", inputJSON, err)
	}
	var in sensor.SensorInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return fmt.Errorf("parse %s: %w", inputJSON, err)
	}
	if in.Bmsz == "" {
		return fmt.Errorf("%s: Bmsz is required (its first numeric token is the cipher seed)", inputJSON)
	}
	nowMs := time.Now().UnixMilli()
	if v := os.Getenv("GOFAST_NOW_MS"); v != "" { // deterministic override for tests
		if n, perr := strconv.ParseInt(v, 10, 64); perr == nil {
			nowMs = n
		}
	}
	sd, err := sensor.Generate(in, nowMs)
	if err != nil {
		return err
	}
	fmt.Println(sd)
	return nil
}

// runSelfTest verifies cipher + generator parity (bit-exact regenerate).
func runSelfTest() error {
	ok, detail := sensor.SelfTest()
	status := "PASS"
	if !ok {
		status = "FAIL"
	}
	fmt.Printf("selftest: %s — %s\n", status, detail)
	if !ok {
		return fmt.Errorf("selftest failed")
	}
	return nil
}

// decodeCapture reads a capture file (raw body or {"sensor_data":"..."}) and decodes it.
func decodeCapture(path string) (sensor.DecodeResult, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return sensor.DecodeResult{}, fmt.Errorf("read %s: %w", path, err)
	}
	r := sensor.DecodeV3(sensor.ExtractSensorData(string(raw)))
	if !r.OK {
		return r, fmt.Errorf("decode %s: %s", path, r.Reason)
	}
	return r, nil
}

// runAnalyze decodes one capture and dumps seed/section0/meta + the field grid.
func runAnalyze(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: gofast analyze <capture.json>")
	}
	r, err := decodeCapture(args[0])
	if err != nil {
		return err
	}
	fields := sensor.Fields(r.Plain)
	fmt.Printf("file     : %s\n", args[0])
	fmt.Printf("seed     : %d (prefix field 4)\n", r.Seed)
	fmt.Printf("section0 : %s\n", r.Section0)
	fmt.Printf("meta     : %s\n", r.Meta)
	fmt.Printf("decoded %d field-objects:\n", len(fields))
	for i, f := range fields {
		fmt.Printf("  [%2d] %s\n", i, truncate(f, 100))
	}
	return nil
}

// runDiff decodes 2+ captures and classifies each positional field as STATIC (same
// across all captures) or DYNAMIC (changes) — the worklist for generator field modeling.
func runDiff(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: gofast diff <capture1.json> <capture2.json> [more...]")
	}
	results := make([]sensor.DecodeResult, len(args))
	grids := make([][]string, len(args))
	for i, p := range args {
		r, err := decodeCapture(p)
		if err != nil {
			return err
		}
		results[i] = r
		grids[i] = sensor.Fields(r.Plain)
		fmt.Printf("  [%d] %-28s seed=%-9d section0=%s\n", i, filepath.Base(p), r.Seed, r.Section0)
	}

	// header-level diffs
	fmt.Println()
	reportHeader("seed", results, func(r sensor.DecodeResult) string { return strconv.Itoa(r.Seed) })
	reportHeader("section0", results, func(r sensor.DecodeResult) string { return r.Section0 })
	reportHeader("meta", results, func(r sensor.DecodeResult) string { return r.Meta })

	// field-level diff (positional, up to the shortest grid)
	n := len(grids[0])
	for _, g := range grids[1:] {
		if len(g) != n {
			fmt.Printf("\n⚠ field-count differs across captures (%d vs %d) — structure is dynamic; comparing first %d\n",
				n, len(g), min(n, len(g)))
		}
		n = min(n, len(g))
	}

	var static, dynamic int
	fmt.Printf("\nfield grid (%d positions compared):\n", n)
	for i := 0; i < n; i++ {
		base := grids[0][i]
		changed := false
		for _, g := range grids[1:] {
			if g[i] != base {
				changed = true
				break
			}
		}
		tag := "STATIC "
		if changed {
			tag = "DYNAMIC"
			dynamic++
		} else {
			static++
		}
		fmt.Printf("  [%2d] %s %-24s %s\n", i, tag, sensor.FieldKey(base), truncate(base, 56))
		if changed {
			for j, g := range grids {
				fmt.Printf("         #%d %s\n", j, truncate(g[i], 64))
			}
		}
	}
	fmt.Printf("\nsummary: %d static, %d dynamic (the dynamic ones are what Generate must compute, not replay)\n", static, dynamic)
	return nil
}

// runRegen reads a capture (capture-real.json -> latest POST, or a raw sensor body /
// {"sensor_data":...} file), refreshes its sc timestamps to now, re-encodes, and
// prints a ready-to-POST sensor_data. This is the offline form of the hook's proven
// `regen` mode (capture-assisted generation).
func runRegen(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: gofast regen <capture-real.json | sensor_body_file>")
	}
	raw, err := os.ReadFile(args[0])
	if err != nil {
		return fmt.Errorf("read %s: %w", args[0], err)
	}

	// Prefer the latest POST from a full capture; otherwise treat the file as a body.
	body := ""
	if capData, perr := sensor.ParseCapture(raw); perr == nil && len(capData.Posts) > 0 {
		body = sensor.ExtractSensorData(capData.Posts[len(capData.Posts)-1].Body)
		fmt.Fprintf(os.Stderr, "regen: using latest of %d captured POSTs\n", len(capData.Posts))
	} else {
		body = sensor.ExtractSensorData(string(raw))
	}

	nowMs := time.Now().UnixMilli()
	if v := os.Getenv("GOFAST_NOW_MS"); v != "" {
		if n, perr := strconv.ParseInt(v, 10, 64); perr == nil {
			nowMs = n
		}
	}
	out, n, err := sensor.Regen(body, nowMs)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "regen: refreshed %d ms-epoch timestamp(s)\n", n)
	if n == 0 {
		fmt.Fprintln(os.Stderr, "regen: WARNING — no timestamp refreshed; output is byte-identical (= replay)")
	}
	fmt.Println(out)
	return nil
}

// runHarvest validates a harvested fresh body and emits a ready-to-POST curl. This is
// the proven path (only fresh, unmodified bodies pass). It warns if the body is already
// old, since timing is checked against session age.
func runHarvest(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: gofast harvest <harvest.json | capture-real.json>")
	}
	raw, err := os.ReadFile(args[0])
	if err != nil {
		return fmt.Errorf("read %s: %w", args[0], err)
	}
	h, err := sensor.ParseHarvest(raw)
	if err != nil {
		return err
	}
	body := sensor.ExtractSensorData(h.Body)
	dec := sensor.DecodeV3(body)
	if !dec.OK {
		return fmt.Errorf("harvested body does not decode: %s", dec.Reason)
	}
	fmt.Fprintf(os.Stderr, "harvest: endpoint=%s\n", h.URL)
	fmt.Fprintf(os.Stderr, "harvest: decoded OK (seed=%d section0=%s)\n", dec.Seed, dec.Section0)

	// The harvested cookies often already hold a VALID _abck (the session passed in the
	// browser) — frequently the real deliverable: reuse the cookies, no POST needed.
	if ab := cookieValue(h.Cookie, "_abck"); ab != "" {
		status := "?"
		if parts := strings.Split(ab, "~"); len(parts) > 1 {
			status = parts[1]
		}
		if status == "0" {
			fmt.Fprintf(os.Stderr, "harvest: _abck status=~0~  ✓ VALID — for automation, reuse these cookies directly (no POST needed)\n")
		} else {
			fmt.Fprintf(os.Stderr, "harvest: _abck status=~%s~  (not valid yet — browse longer until status=0, then re-harvest)\n", status)
		}
	}
	if h.T > 0 { // body age only matters for the POST-the-sensor path below
		age := time.Now().UnixMilli() - h.T
		warn := ""
		if age > 30000 {
			warn = "  ⚠ likely STALE for re-POSTing (timing vs session age); for the curl path, harvest+POST back-to-back"
		}
		fmt.Fprintf(os.Stderr, "harvest: body age=%dms%s\n", age, warn)
	}
	if h.URL == "" {
		return fmt.Errorf("no endpoint URL in harvest (need harvest.json from __harvest())")
	}

	// Emit a ready-to-POST curl. Headers/cookies should match a real request (copy from
	// DevTools if the POST is rejected); _abck is httpOnly so it won't be in h.Cookie.
	fmt.Printf("curl '%s' \\\n", h.URL)
	fmt.Printf("  -X POST \\\n")
	fmt.Printf("  -H 'content-type: text/plain;charset=UTF-8' \\\n")
	if h.UA != "" {
		fmt.Printf("  -H 'user-agent: %s' \\\n", h.UA)
	}
	if h.Cookie != "" {
		fmt.Printf("  -H 'cookie: %s' \\\n", h.Cookie)
	}
	fmt.Printf("  --data-raw '%s'\n", strings.ReplaceAll(h.Body, "'", `'\''`))
	return nil
}

// cookieValue extracts a cookie's value from a "k=v; k2=v2" cookie string.
func cookieValue(cookie, name string) string {
	for _, p := range strings.Split(cookie, ";") {
		p = strings.TrimSpace(p)
		if strings.HasPrefix(p, name+"=") {
			return p[len(name)+1:]
		}
	}
	return ""
}

// runShift implements coherent-replay (TIMING.md): take the latest POST from a capture
// and shift its anchor so the body is coherent for a send at --at (default now). Prints
// the ready-to-POST sensor_data to stdout and a summary to stderr.
func runShift(args []string) error {
	var path string
	var atMs int64 = time.Now().UnixMilli()
	for i := 0; i < len(args); i++ {
		if args[i] == "--at" && i+1 < len(args) {
			if n, e := strconv.ParseInt(args[i+1], 10, 64); e == nil {
				atMs = n
			}
			i++
		} else if path == "" {
			path = args[i]
		}
	}
	if path == "" {
		return fmt.Errorf("usage: gofast shift <capture-real.json> [--at <ms>]")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	capData, err := sensor.ParseCapture(raw)
	if err != nil || len(capData.Posts) == 0 {
		return fmt.Errorf("need a capture-real.json with at least one POST")
	}
	last := capData.Posts[len(capData.Posts)-1]
	origSend := last.T
	delta := atMs - origSend

	out, oldA, newA, n, err := sensor.ShiftAnchor(sensor.ExtractSensorData(last.Body), delta)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "shift: origSend=%d at=%d delta=%dms | anchor %d -> %d (%d occurrence shifted)\n",
		origSend, atMs, delta, oldA, newA, n)
	if delta == 0 {
		fmt.Fprintln(os.Stderr, "shift: delta=0 (body is byte-identical = passthrough); pass --at <future ms> or run later")
	}
	fmt.Println(out)
	return nil
}

// runTimeMap builds and prints the timing model (anchor / per-POST elapsed timers /
// static-vs-dynamic tokens) from a capture-real.json — the prerequisite for a coherent
// multi-field timing refresh (WORKFLOW.md phase 6/8).
func runTimeMap(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: gofast timemap <capture-real.json>")
	}
	raw, err := os.ReadFile(args[0])
	if err != nil {
		return fmt.Errorf("read %s: %w", args[0], err)
	}
	capData, err := sensor.ParseCapture(raw)
	if err != nil {
		return err
	}
	m := capData.TimeMap()
	if m.AnchorStable {
		fmt.Printf("session anchor epoch : %d  (identical across all POSTs — reuse, do NOT bump)\n", m.Anchor)
	} else {
		fmt.Printf("session anchor epoch : (none common to all POSTs — need more POSTs, or anchor varies)\n")
	}
	fmt.Printf("static device tokens : %d of %d 4+digit tokens are in every POST (reusable)\n\n", m.StaticTokens, m.TotalTokens)
	fmt.Println("per-POST elapsed timers (token ≈ sendTime − anchor = freshness the server checks):")
	for _, p := range m.Posts {
		fmt.Printf("  POST#%d  send=%d  expected-elapsed=%dms\n", p.Index, p.SendMs, p.ExpectedElapsed)
		if p.NearCount > 0 {
			fmt.Printf("          closest: %d (off %dms) | tight band (high-confidence): %v | loose window: %d behavioral tokens\n",
				p.Closest, p.ClosestDelta, p.Tight, p.NearCount)
		} else if m.AnchorStable {
			fmt.Printf("          (no token near expected elapsed — timer may be split/derived)\n")
		}
	}
	fmt.Println("\nmodel: reuse anchor+section0+seed+static tokens; a coherent refresh must set the")
	fmt.Println("elapsed timers (and behavioral offsets) to match (newSendTime − anchor).")
	return nil
}

// runCaptureAnalyze ingests an exported capture-real.json (from the devtools hook)
// and, for each POST, recovers the section0 preimage (via the captured digest/btoa
// calls) and confirms the plaintext assembly point (via the captured Array.join).
func runCaptureAnalyze(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: gofast capture-analyze <capture-real.json>")
	}
	raw, err := os.ReadFile(args[0])
	if err != nil {
		return fmt.Errorf("read %s: %w", args[0], err)
	}
	capData, err := sensor.ParseCapture(raw)
	if err != nil {
		return err
	}
	fmt.Printf("capture : %s\n", args[0])
	fmt.Printf("ua      : %s\n", capData.UA)
	fmt.Printf("posts=%d  joins=%d  digests=%d  btoa=%d  hashes=%d\n\n",
		len(capData.Posts), len(capData.Joins), len(capData.Digests), len(capData.B64s), len(capData.Hashes))

	reports := capData.AnalyzeCapture()
	for _, r := range reports {
		fmt.Printf("POST #%d\n", r.PostIndex)
		if !r.Decode.OK {
			fmt.Printf("  decode failed: %s\n\n", r.Decode.Reason)
			continue
		}
		fmt.Printf("  seed=%d  section0=%s  meta=%s\n", r.Decode.Seed, r.Decode.Section0, r.Decode.Meta)

		switch {
		case r.DigestPreimageB64 != "":
			fmt.Printf("  ✓ section0 = SHA-256 digest; preimage captured (inLen=%d):\n      %s\n",
				r.DigestInLen, truncate(r.DigestPreimageB64, 90))
		case r.BtoaInputHex != "":
			fmt.Printf("  ✓ section0 produced via btoa; input bytes (hex):\n      %s\n",
				truncate(r.BtoaInputHex, 90))
		default:
			// section0 is likely built with the script's own SHA-256/base64 (not
			// WebCrypto/btoa), so search every captured string for the preimage.
			hits := capData.FindSection0Preimage(r.Decode.Section0)
			if len(hits) > 0 {
				fmt.Printf("  ✓ section0 = base64(SHA-256(X)); preimage FOUND by search:\n")
				for _, h := range hits {
					where := h.Source
					if h.Source == "joins" {
						where = fmt.Sprintf("joins[%d] sep=%q", h.Index, h.Sep)
					} else {
						where = fmt.Sprintf("hashes[%d]", h.Index)
					}
					fmt.Printf("      via %s:\n      %s\n", where, truncate(h.Value, 120))
				}
			} else {
				fmt.Printf("  · section0 preimage NOT in captured digest/btoa, and no captured string hashes to it\n")
				fmt.Printf("    (try: interact more before __save; or it hashes a value we don't capture yet)\n")
			}
		}

		if r.JoinMatch {
			fmt.Printf("  ✓ plaintext == captured Array.join (sep=%q, joins[%d]) — assembly point confirmed\n",
				r.JoinSep, r.JoinValuePos)
		} else {
			fmt.Printf("  · plaintext not found among captured Array.join results\n")
		}
		fmt.Println()
	}

	fmt.Println("next: if section0 is stable across posts, reuse the captured value (no preimage needed);")
	fmt.Println("then run probe mode `__run('passthrough')` in the page console for the live verdict.")
	return nil
}

func reportHeader(name string, results []sensor.DecodeResult, get func(sensor.DecodeResult) string) {
	v0 := get(results[0])
	same := true
	for _, r := range results[1:] {
		if get(r) != v0 {
			same = false
			break
		}
	}
	tag := "STATIC "
	if !same {
		tag = "DYNAMIC"
	}
	fmt.Printf("  %s %-9s %s\n", tag, name, truncate(v0, 60))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func run() error {
	src, err := os.ReadFile(inputPath)
	if err != nil {
		return fmt.Errorf("read input %s: %w", inputPath, err)
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", outDir, err)
	}

	fmt.Println("gofast — staged deobfuscation (go-fAST)")
	fmt.Println()

	code := string(src)
	var lastOut string
	for _, step := range pipeline.Steps {
		t0 := time.Now()
		code, err = step.Run(code)
		if err != nil {
			return fmt.Errorf("step %s %s: %w", step.ID, step.Name, err)
		}
		lastOut = filepath.Join(outDir, step.OutFile)
		if err := os.WriteFile(lastOut, []byte(code), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", lastOut, err)
		}
		fmt.Printf("  ok  %-3s %-18s lines=%-7d (%v)\n",
			step.ID, step.Name, countLines(code), time.Since(t0).Round(time.Millisecond))
	}

	if err := os.WriteFile(finalPath, []byte(code), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", finalPath, err)
	}
	fmt.Printf("\nfinal -> %s (%d lines)\n", finalPath, countLines(code))
	return nil
}

func countLines(s string) int {
	if s == "" {
		return 0
	}
	n := 1
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			n++
		}
	}
	return n
}
