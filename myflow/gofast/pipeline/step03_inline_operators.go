package pipeline

import (
	"fmt"

	"github.com/t14raptor/go-fast/ast"
	"github.com/t14raptor/go-fast/generator"
	"github.com/t14raptor/go-fast/parser"
)

// inlineOperatorsPass walks call sites. TODO: detect pure operator-alias helpers
// (Mp=a=>!a, HE=(a,b)=>a+b, BI=(a,b)=>a-b, SI=(a,b)=>a>b, ...) and rewrite their
// calls back to real operators (scope-aware: only when the callee resolves to such
// a helper). Re-exposes constant subtrees for step 04. Run resolver.Resolve first
// when this is implemented. Mirrors ../../babelflow/steps/03-inline-operators.js.
type inlineOperatorsPass struct{ ast.NoopVisitor }

func (p *inlineOperatorsPass) VisitCallExpression(n *ast.CallExpression) {
	// TODO(step03): if callee is a known operator-alias helper, replace this call
	// with the corresponding unary/binary expression over its arguments.
	n.VisitChildrenWith(p.V)
}

// InlineOperators (step 03) — currently a pass-through exercising the visitor path.
func InlineOperators(src string) (string, error) {
	prog, err := parser.ParseFile(src)
	if err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}
	p := &inlineOperatorsPass{}
	p.V = p
	prog.VisitWith(p.V)
	return generator.Generate(prog), nil
}
