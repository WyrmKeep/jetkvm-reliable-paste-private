package regression

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readRepoFile(t *testing.T, parts ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{"..", ".."}, parts...)...)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func requireContains(t *testing.T, source string, want string) {
	t.Helper()
	if !strings.Contains(source, want) {
		t.Fatalf("expected source to contain:\n%s", want)
	}
}

func TestPasteFailureStateIsReportedOnFinalPasteEdge(t *testing.T) {
	source := readRepoFile(t, "jsonrpc.go")

	requireContains(t, source, "pasteFailures atomic.Int32")
	requireContains(t, source, "if item.isPaste && !errors.Is(err, context.Canceled) {\n\t\t\t\tpasteFailures.Add(1)\n\t\t\t}")
	requireContains(t, source, "emitPasteState(item.session, false, pasteFailures.Swap(0) > 0)")
	requireContains(t, source, "emitPasteState(lastPasteSession, false, pasteFailures.Swap(0) > 0)")
	requireContains(t, source, "pasteFailures.Store(0)")
	requireContains(t, source, "emitPasteState(session, true, false)")
	requireContains(t, source, "emitPasteState(session, false, pasteFailures.Swap(0) > 0)")
}

func TestFrontendRejectsObservedPasteFailureAndTimeout(t *testing.T) {
	hidRPC := readRepoFile(t, "ui", "src", "hooks", "hidRpc.ts")
	keyboard := readRepoFile(t, "ui", "src", "hooks", "useKeyboard.ts")

	requireContains(t, hidRPC, "failed: boolean;")
	requireContains(t, hidRPC, "data[2] === 1")
	requireContains(t, keyboard, "let pasteFailureSequence = 0;")
	requireContains(t, keyboard, "let pasteStateSupportChannel: RTCDataChannel | null = null;")
	requireContains(t, keyboard, "sourceChannel !== useRTCStore.getState().rpcHidChannel")
	requireContains(t, keyboard, "rejectErr(new Error(\"Paste macro failed\"));")
	requireContains(t, keyboard, "pasteFailureSequence++;")
	requireContains(t, keyboard, "if (mode === \"required\" || seenTrue)")
	requireContains(t, keyboard, "allowNoStartFastPath = true")
	requireContains(t, keyboard, "mode === \"bestEffort\" && !seenTrue && allowNoStartFastPath")
	requireContains(t, keyboard, "!(rpcHidReady && !chunkMode && batches.length > 0)")
	requireContains(t, keyboard, "pasteFailureBaseline")
}
