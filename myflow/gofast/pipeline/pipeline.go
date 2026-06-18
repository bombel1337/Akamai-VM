// Package pipeline holds the staged static deobfuscation passes for gofast.
//
// Each pass takes JavaScript source and returns transformed source, mirroring the
// JS Babel passes in ../../babelflow/steps/. Today step 01 (beautify) is real; steps
// 02-05 are pass-through stubs that document the intended transform (see WORKFLOW.md
// phase 2). Keeping them pass-through lets the whole pipeline run end-to-end now.
package pipeline

// Step is one deobfuscation pass: source in, source out.
type Step struct {
	// ID is the short numeric tag, e.g. "01".
	ID string
	// Name is the human label, e.g. "beautify".
	Name string
	// OutFile is the artifact written under out/, e.g. "01-beautified.js".
	OutFile string
	// Run applies the transform. It returns the transformed source.
	Run func(src string) (string, error)
}

// Steps is the ordered pipeline, run start-to-finish by the driver.
var Steps = []Step{
	{ID: "01", Name: "beautify", OutFile: "01-beautified.js", Run: Beautify},
	{ID: "02", Name: "decode-hex", OutFile: "02-decoded-hex.js", Run: DecodeHex},
	{ID: "03", Name: "inline-operators", OutFile: "03-inlined.js", Run: InlineOperators},
	{ID: "04", Name: "fold-constants", OutFile: "04-folded.js", Run: FoldConstants},
	{ID: "05", Name: "simplify-members", OutFile: "05-simplified.js", Run: SimplifyMembers},
}
