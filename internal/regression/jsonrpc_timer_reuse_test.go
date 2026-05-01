package regression

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"testing"
)

func TestRPCDoExecuteKeyboardMacroLoopDoesNotAllocateTimerPerStep(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filepath.Join("..", "..", "jsonrpc.go"), nil, 0)
	if err != nil {
		t.Fatalf("parse jsonrpc.go: %v", err)
	}

	fn := findFunc(file, "rpcDoExecuteKeyboardMacroStepLoop")
	if fn == nil {
		t.Fatal("rpcDoExecuteKeyboardMacroStepLoop not found")
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
		t.Fatalf("rpcDoExecuteKeyboardMacroStepLoop should allocate exactly one reusable timer, found %d at %v", len(newTimerCalls), newTimerCalls)
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
		t.Fatalf("rpcDoExecuteKeyboardMacroStepLoop allocates or blocks with time package calls inside its step loop; use the reusable timer instead: %v", perStepDelayCalls)
	}
}

func TestRPCDoExecuteKeyboardMacroUsesSequenceWriterForPasteOnly(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filepath.Join("..", "..", "jsonrpc.go"), nil, 0)
	if err != nil {
		t.Fatalf("parse jsonrpc.go: %v", err)
	}

	fn := findFunc(file, "rpcDoExecuteKeyboardMacro")
	if fn == nil {
		t.Fatal("rpcDoExecuteKeyboardMacro not found")
	}

	if !hasPasteOnlySequenceBranch(fn.Body) {
		t.Fatal("rpcDoExecuteKeyboardMacro should dispatch isPaste macros to rpcDoExecutePasteKeyboardMacro and otherwise use rpcDoExecuteKeyboardMacroStepLoop")
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

func hasPasteOnlySequenceBranch(body *ast.BlockStmt) bool {
	var ifStmt *ast.IfStmt
	var ifIndex int
	for i, stmt := range body.List {
		candidate, ok := stmt.(*ast.IfStmt)
		if ok && isIdent(candidate.Cond, "isPaste") {
			ifStmt = candidate
			ifIndex = i
			break
		}
	}
	if ifStmt == nil || ifIndex+1 >= len(body.List) {
		return false
	}

	if len(ifStmt.Body.List) != 1 {
		return false
	}
	pasteReturn, ok := ifStmt.Body.List[0].(*ast.ReturnStmt)
	if !ok || len(pasteReturn.Results) != 1 {
		return false
	}
	pasteCall, ok := pasteReturn.Results[0].(*ast.CallExpr)
	if !ok || !isIdent(pasteCall.Fun, "rpcDoExecutePasteKeyboardMacro") {
		return false
	}

	loopReturn, ok := body.List[ifIndex+1].(*ast.ReturnStmt)
	if !ok || len(loopReturn.Results) != 1 {
		return false
	}
	loopCall, ok := loopReturn.Results[0].(*ast.CallExpr)
	return ok && isIdent(loopCall.Fun, "rpcDoExecuteKeyboardMacroStepLoop")
}
