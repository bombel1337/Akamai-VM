package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"gofast/sensor"
)

// runServe starts an HTTP API: POST /sensor with an input.json body returns a v3
// sensor_data string (text/plain). This is the offline generate path (sensor.Generate)
// exposed over HTTP — the same code as `gofast generate`, so the same caveat applies:
// the body round-trips the cipher but is only server-ACCEPTED once the section0/field RE
// (RE_STATE.md M1–M5) lands. The caller POSTs the returned body to the Akamai endpoint
// and reads _abck from the set-cookie response.
func runServe(args []string) error {
	addr := ":8080"
	if v := os.Getenv("GOFAST_ADDR"); v != "" {
		addr = v
	}
	for i := 0; i < len(args); i++ {
		if args[i] == "--addr" && i+1 < len(args) {
			addr = args[i+1]
			i++
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handleHealth)
	mux.HandleFunc("/sensor", handleSensor)

	srv := &http.Server{
		Addr:         addr,
		Handler:      withLogging(mux),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	fmt.Fprintf(os.Stderr, "gofast serve: listening on %s  (POST /sensor, GET /healthz)\n", addr)
	return srv.ListenAndServe()
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "ok")
}

// handleSensor reads an input.json payload and returns the raw sensor_data string.
func handleSensor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, http.StatusMethodNotAllowed, "use POST with an input.json body")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MiB cap
	if err != nil {
		httpError(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	var in sensor.SensorInput
	if err := json.Unmarshal(raw, &in); err != nil {
		httpError(w, http.StatusBadRequest, "parse input json: "+err.Error())
		return
	}
	if in.Bmsz == "" {
		httpError(w, http.StatusBadRequest, "Bmsz is required (its first numeric token is the cipher seed)")
		return
	}

	nowMs := time.Now().UnixMilli()
	if v := os.Getenv("GOFAST_NOW_MS"); v != "" { // deterministic override for tests
		if n, perr := strconv.ParseInt(v, 10, 64); perr == nil {
			nowMs = n
		}
	}

	sd, err := sensor.Generate(in, nowMs)
	if err != nil {
		httpError(w, http.StatusUnprocessableEntity, "generate: "+err.Error())
		return
	}
	w.Header().Set("content-type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, sd)
}

func httpError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("content-type", "text/plain; charset=utf-8")
	w.WriteHeader(code)
	_, _ = io.WriteString(w, msg+"\n")
}

// withLogging logs method/path/status/duration and recovers panics as 500s.
func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			if rec := recover(); rec != nil {
				if !sw.wrote {
					sw.WriteHeader(http.StatusInternalServerError)
					_, _ = io.WriteString(sw, "internal error\n")
				}
				fmt.Fprintf(os.Stderr, "gofast serve: panic %v\n", rec)
			}
			fmt.Fprintf(os.Stderr, "gofast serve: %s %s -> %d (%v)\n",
				r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Millisecond))
		}()
		next.ServeHTTP(sw, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.wrote = true
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	s.wrote = true
	return s.ResponseWriter.Write(b)
}
