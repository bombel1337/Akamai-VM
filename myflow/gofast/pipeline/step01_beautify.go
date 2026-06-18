package pipeline

import (
	"fmt"

	"github.com/t14raptor/go-fast/generator"
	"github.com/t14raptor/go-fast/parser"
)

// Beautify (step 01) reflows the single minified line into readable, indented code.
// String literals keep their original (hex-escaped) form here; decoding them is
// step 02. Mirrors ../../babelflow/steps/01-beautify.js.
func Beautify(src string) (string, error) {
	prog, err := parser.ParseFile(src)
	if err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}
	return generator.Generate(prog), nil
}
