package pipeline

import (
	"fmt"

	"github.com/t14raptor/go-fast/ast"
	"github.com/t14raptor/go-fast/generator"
	"github.com/t14raptor/go-fast/parser"
)

// foldConstantsPass walks expressions. TODO: detect *pure constant* subtrees (array
// literals, number/string/boolean literals, unary + - ! ~ void typeof, and
// arithmetic/binary operators) and evaluate them to a literal
// (!+[]+!+[]+!+[] -> 3, '0x'+'eefb964' -> '0xeefb964'). The ast/ext value helpers
// can do the const-eval. Mirrors ../../babelflow/steps/04-fold-constants.js.
type foldConstantsPass struct{ ast.NoopVisitor }

func (p *foldConstantsPass) VisitBinaryExpression(n *ast.BinaryExpression) {
	n.VisitChildrenWith(p.V) // visit children first (fold bottom-up)
	// TODO(step04): if both operands are now constant literals, replace n with the
	// evaluated literal.
}

func (p *foldConstantsPass) VisitUnaryExpression(n *ast.UnaryExpression) {
	n.VisitChildrenWith(p.V)
	// TODO(step04): fold constant unary expressions (+ - ! ~ void typeof).
}

// FoldConstants (step 04) — currently a pass-through exercising the visitor path.
func FoldConstants(src string) (string, error) {
	prog, err := parser.ParseFile(src)
	if err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}
	p := &foldConstantsPass{}
	p.V = p
	prog.VisitWith(p.V)
	return generator.Generate(prog), nil
}
