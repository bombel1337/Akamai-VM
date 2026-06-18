package pipeline

import (
	"fmt"

	"github.com/t14raptor/go-fast/ast"
	"github.com/t14raptor/go-fast/generator"
	"github.com/t14raptor/go-fast/parser"
)

// simplifyMembersPass walks member access. TODO: turn computed string-key access
// into dot notation when the key is a valid identifier
// (OY['window']['XMLHttpRequest'] -> OY.window.XMLHttpRequest). Leave decoder-driven
// computed keys (BASE()[IDX(k)]) and numeric keys alone. This is the last readable
// pass before the step-3 decoder wall. Mirrors ../../babelflow/steps/05-simplify-members.js.
type simplifyMembersPass struct{ ast.NoopVisitor }

func (p *simplifyMembersPass) VisitMemberExpression(n *ast.MemberExpression) {
	// TODO(step05): if the property is a computed string literal that is a valid
	// identifier, convert it to a static dot-property access.
	n.VisitChildrenWith(p.V)
}

// SimplifyMembers (step 05) — currently a pass-through exercising the visitor path.
func SimplifyMembers(src string) (string, error) {
	prog, err := parser.ParseFile(src)
	if err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}
	p := &simplifyMembersPass{}
	p.V = p
	prog.VisitWith(p.V)
	return generator.Generate(prog), nil
}
