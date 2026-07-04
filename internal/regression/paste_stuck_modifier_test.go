package regression

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"testing"
)

func TestMacroWriteErrorPathSendsAllClearBeforeReturning(t *testing.T) {
	source := readRepoFile(t, "jsonrpc.go")

	requireContains(t, source, "sendKeyboardAllClearAfterMacroWriteError(err)\n\t\t\treturn err")
	requireContains(t, source, "func sendKeyboardAllClearAfterMacroWriteError(originalErr error)")
	requireContains(t, source, "rpcKeyboardReport(0, keyboardClearStateKeys)")
}

func TestWakeTapReleaseHasRetryAndAbortPath(t *testing.T) {
	source := readRepoFile(t, "jsonrpc.go")

	requireContains(t, source, "pasteWakeReleaseMaxAttempts = 3")
	requireContains(t, source, "func wakeTargetForPaste() error")
	requireContains(t, source, "usbgadget.ArmNextWakeReleaseWriteFailure()")
	requireContains(t, source, "for attempt := 1; attempt <= pasteWakeReleaseMaxAttempts; attempt++")
	requireContains(t, source, "return fmt.Errorf(\"paste wake release failed after %d attempts: %w\", pasteWakeReleaseMaxAttempts, releaseErr)")
	requireContains(t, source, "err = wakeTargetForPaste()")
	requireContains(t, source, "discardQueuedMacrosAfterPastePreflightFailure(\"paste wake failed\")")
}

func TestRPCDoExecuteKeyboardMacroStillUsesReusableTimer(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filepath.Join("..", "..", "jsonrpc.go"), nil, 0)
	if err != nil {
		t.Fatalf("parse jsonrpc.go: %v", err)
	}

	fn := findFunc(file, "rpcDoExecuteKeyboardMacro")
	if fn == nil {
		t.Fatal("rpcDoExecuteKeyboardMacro not found")
	}

	loop := findRangeLoop(fn.Body)
	if loop == nil {
		t.Fatal("rpcDoExecuteKeyboardMacro macro step loop not found")
	}

	var sleepCalls []token.Position
	ast.Inspect(loop.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if isSelector(call.Fun, "time", "Sleep") {
			sleepCalls = append(sleepCalls, fset.Position(call.Pos()))
		}
		return true
	})
	if len(sleepCalls) > 0 {
		t.Fatalf("rpcDoExecuteKeyboardMacro must not sleep inside the macro step loop: %v", sleepCalls)
	}
}
