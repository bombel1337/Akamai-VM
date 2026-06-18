package pipeline

import (
	"fmt"

	"github.com/t14raptor/go-fast/ast"
	"github.com/t14raptor/go-fast/generator"
	"github.com/t14raptor/go-fast/parser"
)

// decodeHexPass walks the AST. TODO: re-emit string literals from their decoded
// value so \xNN escapes resolve ("\x6c\x65\x6e\x67\x74\x68" -> "length"). Numbers
// and regex literals stay untouched. Mirrors ../../babelflow/steps/02-decode-hex.js.
type decodeHexPass struct{ ast.NoopVisitor }

func (p *decodeHexPass) VisitStringLiteral(n *ast.StringLiteral) {
	// TODO(step02): clear any raw/hex-escaped form so Generate re-emits n.Value.
	n.VisitChildrenWith(p.V)
}

// DecodeHex (step 02) — currently a pass-through that exercises the visitor path.
func DecodeHex(src string) (string, error) {
	prog, err := parser.ParseFile(src)
	if err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}
	p := &decodeHexPass{}
	p.V = p
	prog.VisitWith(p.V)
	return generator.Generate(prog), nil
}
