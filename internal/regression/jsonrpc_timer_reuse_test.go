package regression

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"testing"
)

func TestRPCDoExecuteKeyboardMacroDoesNotAllocateTimerPerStep(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filepath.Join("..", "..", "jsonrpc.go"), nil, 0)
	if err != nil {
		t.Fatalf("parse jsonrpc.go: %v", err)
	}

	fn := findFunc(file, "rpcDoExecuteKeyboardMacro")
	if fn == nil {
		t.Fatal("rpcDoExecuteKeyboardMacro not found")
	}

	var newTimerCalls []token.Position
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if isSelector(call.Fun, "time", "NewTimer") {
			newTimerCalls = append(newTimerCalls, fset.Position(call.Pos()))
		}
		return true
	})
	if len(newTimerCalls) != 1 {
		t.Fatalf("rpcDoExecuteKeyboardMacro should allocate exactly one reusable timer, found %d at %v", len(newTimerCalls), newTimerCalls)
	}

	loop := findRangeLoop(fn.Body)
	if loop == nil {
		t.Fatal("rpcDoExecuteKeyboardMacro macro step loop not found")
	}

	var perStepDelayCalls []token.Position
	ast.Inspect(loop.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if isSelector(call.Fun, "time", "After") ||
			isSelector(call.Fun, "time", "NewTimer") ||
			isSelector(call.Fun, "time", "Sleep") {
			perStepDelayCalls = append(perStepDelayCalls, fset.Position(call.Pos()))
		}
		return true
	})
	if len(perStepDelayCalls) > 0 {
		t.Fatalf("rpcDoExecuteKeyboardMacro allocates or blocks with time package calls inside its step loop; use the reusable timer instead: %v", perStepDelayCalls)
	}
}

func findFunc(file *ast.File, name string) *ast.FuncDecl {
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if ok && fn.Name.Name == name {
			return fn
		}
	}
	return nil
}

func findRangeLoop(body *ast.BlockStmt) *ast.RangeStmt {
	for _, stmt := range body.List {
		loop, ok := stmt.(*ast.RangeStmt)
		if ok && isIdent(loop.X, "macro") {
			return loop
		}
	}
	return nil
}

func isIdent(expr ast.Expr, name string) bool {
	ident, ok := expr.(*ast.Ident)
	return ok && ident.Name == name
}

func isSelector(expr ast.Expr, pkgName, selectorName string) bool {
	selector, ok := expr.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	ident, ok := selector.X.(*ast.Ident)
	return ok && ident.Name == pkgName && selector.Sel.Name == selectorName
}
