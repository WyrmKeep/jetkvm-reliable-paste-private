package regression

import (
	"path/filepath"
	"strings"
	"testing"
)

func requireNotContains(t *testing.T, source string, unwanted string) {
	t.Helper()
	if strings.Contains(source, unwanted) {
		t.Fatalf("expected source not to contain:\n%s", unwanted)
	}
}

func TestPasteCancelForcesKeyboardReleaseAndRejectsStaleSessions(t *testing.T) {
	source := readRepoFile(t, "jsonrpc.go")

	requireContains(t, source, "func forceKeyboardAllKeysUp(reason string)")
	requireContains(t, source, "rpcKeyboardReport(0, keyboardClearStateKeys)")
	requireContains(t, source, "func isStalePasteSession(session *Session) bool")
	requireContains(t, source, "func isStaleQueuedMacro(item queuedMacro) bool")
	requireContains(t, source, "return item.isPaste && isStalePasteSession(item.session)")
	requireContains(t, source, "rejecting stale-session paste macro")
	requireContains(t, source, "return context.Canceled")
	requireNotContains(t, source, "forceKeyboardAllKeysUp(\"stale paste macro enqueue\")")
	requireContains(t, source, "func rpcCancelKeyboardMacro(session *Session)")
	requireContains(t, source, "ignoring stale-session keyboard macro cancel")
	requireContains(t, source, "discarding stale-session queued keyboard macro")
	requireContains(t, source, "forceKeyboardAllKeysUp(\"stale paste macro discard\")")
	requireContains(t, source, "forceKeyboardAllKeysUp(\"canceled paste macro\")")
	requireContains(t, source, "forceKeyboardAllKeysUp(\"macro queue cancel\")")
	requireContains(t, source, "time.Sleep(pasteInterMacroDrain)")
}

func TestHidRpcCancelIsScopedToOriginSession(t *testing.T) {
	source := readRepoFile(t, "hidrpc.go")

	requireContains(t, source, "rpcCancelKeyboardMacro(session)")
}

func TestSessionSwitchMarksOldPasteWorkStaleBeforeCancelSweep(t *testing.T) {
	for _, parts := range [][]string{
		{"web.go"},
		{"cloud.go"},
	} {
		source := readRepoFile(t, parts...)
		assignIndex := strings.Index(source, "currentSession = session")
		cancelIndex := strings.Index(source, "cancelAndDrainMacroQueue()")
		if assignIndex < 0 || cancelIndex < 0 {
			t.Fatalf("%s missing currentSession assignment or cancel sweep", filepath.Join(parts...))
		}
		if assignIndex > cancelIndex {
			t.Fatalf("%s cancels before assigning currentSession; late old-session paste work can look current", filepath.Join(parts...))
		}
	}

	source := readRepoFile(t, "webrtc.go")
	nilIndex := strings.Index(source, "currentSession = nil")
	cancelIndex := strings.Index(source, "cancelAndDrainMacroQueue()")
	if nilIndex < 0 || cancelIndex < 0 {
		t.Fatal("webrtc.go missing currentSession nil assignment or cancel sweep")
	}
	if nilIndex > cancelIndex {
		t.Fatal("webrtc.go cancels before clearing currentSession; late closing-session paste work can look current")
	}
}

func TestFrontendPasteLoopGuardsHidChannelIdentity(t *testing.T) {
	source := readRepoFile(t, "ui", "src", "hooks", "useKeyboard.ts")

	requireContains(t, source, "let executePasteTextInFlightChannel: RTCDataChannel | null = null;")
	requireContains(t, source, "function ensurePasteExecutionChannelCurrent(channel: RTCDataChannel): void")
	requireContains(t, source, "useRTCStore.getState().rpcHidChannel !== channel")
	requireContains(t, source, "throw new Error(\"Paste HID data channel changed\")")
	requireContains(t, source, "executePasteTextInFlightChannel === channel")
	requireContains(t, source, "ensurePasteExecutionChannelCurrent(channel);")
}
