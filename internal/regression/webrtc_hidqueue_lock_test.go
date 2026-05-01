package regression

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"testing"
)

func TestHIDQueueSendAndCloseAreSerialized(t *testing.T) {
	fset := token.NewFileSet()
	sourcePath := filepath.Join("..", "..", "webrtc.go")
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatalf("read webrtc.go: %v", err)
	}
	file, err := parser.ParseFile(fset, sourcePath, source, 0)
	if err != nil {
		t.Fatalf("parse webrtc.go: %v", err)
	}

	handler := webrtcFindFunc(file, "getOnHidMessageHandler")
	if handler == nil {
		t.Fatal("getOnHidMessageHandler not found")
	}
	if webrtcContainsIdent(handler.Body, "recover") {
		t.Fatal("getOnHidMessageHandler still uses recover for HID queue send; serialize send/close under hidQueueLock instead")
	}
	if !webrtcContainsMethodCall(handler.Body, "session", "enqueueHIDQueueMessage") {
		t.Fatal("getOnHidMessageHandler must enqueue HID messages through enqueueHIDQueueMessage")
	}

	hidEnqueue := webrtcFindFunc(file, "enqueueHIDQueueMessage")
	if hidEnqueue == nil {
		t.Fatal("enqueueHIDQueueMessage not found")
	}
	if !webrtcContainsSelectorCall(hidEnqueue.Body, "s", "hidQueueLock", "Lock") ||
		!webrtcContainsSelectorCall(hidEnqueue.Body, "s", "hidQueueLock", "Unlock") {
		t.Fatal("enqueueHIDQueueMessage must hold s.hidQueueLock while reading and sending to hidQueue")
	}
	if !webrtcContainsSendToIdent(hidEnqueue.Body, "queue") {
		t.Fatal("enqueueHIDQueueMessage must send to the selected hidQueue while its defer unlock is active")
	}
	if !webrtcUnlocksOnlyWithDefer(hidEnqueue.Body, "s") {
		t.Fatal("enqueueHIDQueueMessage must keep hidQueueLock held until function return")
	}

	keysDown := webrtcFindFunc(file, "enqueueKeysDownState")
	if keysDown == nil {
		t.Fatal("enqueueKeysDownState not found")
	}
	if !webrtcContainsSelectorCall(keysDown.Body, "s", "hidQueueLock", "Lock") ||
		!webrtcContainsSelectorCall(keysDown.Body, "s", "hidQueueLock", "Unlock") {
		t.Fatal("enqueueKeysDownState must hold s.hidQueueLock while checking/sending to keysDownStateQueue")
	}
	if !webrtcContainsSendToSelector(keysDown.Body, "s", "keysDownStateQueue") {
		t.Fatal("enqueueKeysDownState must send to s.keysDownStateQueue under hidQueueLock")
	}
	if !webrtcUnlocksOnlyWithDefer(keysDown.Body, "s") {
		t.Fatal("enqueueKeysDownState must keep hidQueueLock held until function return")
	}

	closeQueues := webrtcFindFunc(file, "closeHIDQueues")
	if closeQueues == nil {
		t.Fatal("closeHIDQueues not found")
	}
	if !webrtcContainsSelectorCall(closeQueues.Body, "s", "hidQueueLock", "Lock") ||
		!webrtcContainsSelectorCall(closeQueues.Body, "s", "hidQueueLock", "Unlock") {
		t.Fatal("closeHIDQueues must hold s.hidQueueLock while closing HID queues")
	}
	if webrtcCountCalls(closeQueues.Body, "close") < 2 {
		t.Fatal("closeHIDQueues must close both hidQueue entries and keysDownStateQueue")
	}
	if !webrtcUnlocksOnlyWithDefer(closeQueues.Body, "s") {
		t.Fatal("closeHIDQueues must keep hidQueueLock held until function return")
	}
	if !webrtcContainsMethodCall(file, "session", "closeHIDQueues") {
		t.Fatal("session teardown must close HID queues through closeHIDQueues")
	}
}

func webrtcFindFunc(file *ast.File, name string) *ast.FuncDecl {
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if ok && fn.Name.Name == name {
			return fn
		}
	}
	return nil
}

func webrtcContainsIdent(node ast.Node, name string) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		ident, ok := n.(*ast.Ident)
		if ok && ident.Name == name {
			found = true
			return false
		}
		return true
	})
	return found
}

func webrtcContainsSelectorCall(node ast.Node, root, field, method string) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if webrtcIsNestedSelector(call.Fun, root, field, method) {
			found = true
			return false
		}
		return true
	})
	return found
}

func webrtcContainsMethodCall(node ast.Node, root, method string) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != method {
			return true
		}
		ident, ok := selector.X.(*ast.Ident)
		if ok && ident.Name == root {
			found = true
			return false
		}
		return true
	})
	return found
}

func webrtcUnlocksOnlyWithDefer(node ast.Node, root string) bool {
	var unlockCalls int
	var deferredUnlocks int
	ast.Inspect(node, func(n ast.Node) bool {
		switch typed := n.(type) {
		case *ast.CallExpr:
			if webrtcIsNestedSelector(typed.Fun, root, "hidQueueLock", "Unlock") {
				unlockCalls++
			}
		case *ast.DeferStmt:
			if webrtcIsNestedSelector(typed.Call.Fun, root, "hidQueueLock", "Unlock") {
				deferredUnlocks++
			}
		}
		return true
	})
	return unlockCalls == 1 && deferredUnlocks == 1
}

func webrtcContainsSendToIdent(node ast.Node, name string) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		send, ok := n.(*ast.SendStmt)
		if !ok {
			return true
		}
		ident, ok := send.Chan.(*ast.Ident)
		if ok && ident.Name == name {
			found = true
			return false
		}
		return true
	})
	return found
}

func webrtcContainsSendToSelector(node ast.Node, root, field string) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		send, ok := n.(*ast.SendStmt)
		if !ok {
			return true
		}
		selector, ok := send.Chan.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != field {
			return true
		}
		ident, ok := selector.X.(*ast.Ident)
		if ok && ident.Name == root {
			found = true
			return false
		}
		return true
	})
	return found
}

func webrtcCountCalls(node ast.Node, name string) int {
	var count int
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		ident, ok := call.Fun.(*ast.Ident)
		if ok && ident.Name == name {
			count++
		}
		return true
	})
	return count
}

func webrtcIsNestedSelector(expr ast.Expr, root, field, method string) bool {
	outer, ok := expr.(*ast.SelectorExpr)
	if !ok || outer.Sel.Name != method {
		return false
	}
	inner, ok := outer.X.(*ast.SelectorExpr)
	if !ok || inner.Sel.Name != field {
		return false
	}
	ident, ok := inner.X.(*ast.Ident)
	return ok && ident.Name == root
}
