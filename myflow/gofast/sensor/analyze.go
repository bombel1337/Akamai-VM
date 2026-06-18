package sensor

import (
	"encoding/json"
	"regexp"
	"strings"
)

// ExtractSensorData accepts either a raw sensor_data string or a JSON object of the
// form {"sensor_data":"..."} (how captures are usually saved) and returns the body.
func ExtractSensorData(raw string) string {
	raw = strings.TrimSpace(raw)
	var o struct {
		SensorData string `json:"sensor_data"`
	}
	if err := json.Unmarshal([]byte(raw), &o); err == nil && o.SensorData != "" {
		return o.SensorData
	}
	return raw
}

var fieldSplitRe = regexp.MustCompile(`\},?\{`)
var fieldTrimRe = regexp.MustCompile(`^[{,]+|[}]+$`)

// Fields splits a decoded plaintext into its {"field":value} objects on the "},{"
// boundary, mirroring analyze.js. NOTE: in live v3 captures the plaintext field
// layout is permuted/transposed per POST (the quotes/braces do not balance against
// the content — see WORKFLOW.md phase 6 / the step-3 wall), so these cells are NOT a
// clean field map. Use this for eyeballing decoded content, not for positional diff.
func Fields(plain string) []string {
	parts := fieldSplitRe.Split(plain, -1)
	out := make([]string, len(parts))
	for i, p := range parts {
		out[i] = fieldTrimRe.ReplaceAllString(p, "")
	}
	return out
}

// FieldKey returns a short label for a field-object: the text before the first ':'
// with surrounding quotes stripped (e.g. `"sc":1781...` -> `sc`). Falls back to a
// truncated prefix when there is no colon.
func FieldKey(field string) string {
	key := field
	if i := strings.IndexByte(field, ':'); i >= 0 {
		key = field[:i]
	}
	key = strings.Trim(key, `"`)
	if len(key) > 24 {
		key = key[:24]
	}
	return key
}
