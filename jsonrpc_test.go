package kvm

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jetkvm/kvm/internal/controlsession"
	"github.com/jetkvm/kvm/internal/hidrpc"
	"github.com/rs/zerolog"
	"github.com/stretchr/testify/require"
)

type keyboardReportCall struct {
	modifier byte
	keys     []byte
}

func withKeyboardReportWrite(t *testing.T, fn func(modifier byte, keys []byte) error) *[]keyboardReportCall {
	t.Helper()

	old := keyboardReportWrite
	oldManager := sessionManager
	sessionManager = controlsession.New[*Session]()
	session := &Session{}
	snapshot := sessionManager.PublishInitial(session)
	session.managerGenerationStore(snapshot.Generation)
	var calls []keyboardReportCall
	keyboardReportWrite = func(modifier byte, keys []byte) error {
		copiedKeys := append([]byte(nil), keys...)
		calls = append(calls, keyboardReportCall{modifier: modifier, keys: copiedKeys})
		return fn(modifier, copiedKeys)
	}
	t.Cleanup(func() {
		keyboardReportWrite = old
		sessionManager = oldManager
	})
	return &calls
}

func withFastPasteWakeTiming(t *testing.T) {
	t.Helper()

	oldTapHold := pasteWakeTapHold
	oldRetryDelay := pasteWakeReleaseRetryDelay
	oldSettle := pasteWakeSettle
	pasteWakeTapHold = 0
	pasteWakeReleaseRetryDelay = 0
	pasteWakeSettle = 0
	t.Cleanup(func() {
		pasteWakeTapHold = oldTapHold
		pasteWakeReleaseRetryDelay = oldRetryDelay
		pasteWakeSettle = oldSettle
	})
}

func requireClearReport(t *testing.T, call keyboardReportCall) {
	t.Helper()
	require.Equal(t, byte(0), call.modifier)
	require.Equal(t, keyboardClearStateKeys, call.keys)
}

func TestRPCDoExecuteKeyboardMacroSendsAllClearBeforeReturningWriteError(t *testing.T) {
	writeErr := errors.New("injected write failure")
	writeAttempts := 0
	calls := withKeyboardReportWrite(t, func(modifier byte, keys []byte) error {
		writeAttempts++
		if writeAttempts == 1 {
			return writeErr
		}
		return nil
	})

	err := rpcDoExecuteKeyboardMacro(context.Background(), currentSessionSnapshot().Generation, []hidrpc.KeyboardMacroStep{
		{Modifier: 0x02, Keys: []byte{0x04, 0, 0, 0, 0, 0}, Delay: 0},
	})

	require.ErrorIs(t, err, writeErr)
	require.Len(t, *calls, 2)
	require.Equal(t, byte(0x02), (*calls)[0].modifier)
	require.Equal(t, []byte{0x04, 0, 0, 0, 0, 0}, (*calls)[0].keys)
	requireClearReport(t, (*calls)[1])
}

func TestRPCDoExecuteKeyboardMacroDoesNotWriteAfterCancellation(t *testing.T) {
	calls := withKeyboardReportWrite(t, func(byte, []byte) error {
		return errors.New("unexpected keyboard report")
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := rpcDoExecuteKeyboardMacro(ctx, currentSessionSnapshot().Generation, []hidrpc.KeyboardMacroStep{
		{Modifier: 0x02, Keys: []byte{0x04, 0, 0, 0, 0, 0}, Delay: 0},
	})

	require.ErrorIs(t, err, context.Canceled)
	require.Empty(t, *calls)
}

func TestWakeTargetForPasteRetriesSingleReleaseFailure(t *testing.T) {
	withFastPasteWakeTiming(t)
	lastKeyboardReportTime.Store(0)

	releaseErr := errors.New("wake release injected failure")
	releaseFailures := 0
	calls := withKeyboardReportWrite(t, func(modifier byte, keys []byte) error {
		if modifier == 0 && releaseFailures == 0 {
			releaseFailures++
			return releaseErr
		}
		return nil
	})

	err := wakeTargetForPaste()

	require.NoError(t, err)
	require.Equal(t, 1, releaseFailures)
	require.Len(t, *calls, 3)
	require.Equal(t, byte(0x02), (*calls)[0].modifier)
	requireClearReport(t, (*calls)[1])
	requireClearReport(t, (*calls)[2])
}

func TestWakeTargetForPasteAbortsAfterPersistentReleaseFailure(t *testing.T) {
	withFastPasteWakeTiming(t)
	lastKeyboardReportTime.Store(0)

	releaseErr := errors.New("wake release persistent failure")
	releaseAttempts := 0
	calls := withKeyboardReportWrite(t, func(modifier byte, keys []byte) error {
		if modifier == 0 {
			releaseAttempts++
			return releaseErr
		}
		return nil
	})

	err := wakeTargetForPaste()

	require.ErrorIs(t, err, releaseErr)
	require.Equal(t, pasteWakeReleaseMaxAttempts, releaseAttempts)
	require.Len(t, *calls, 1+pasteWakeReleaseMaxAttempts)
	require.Equal(t, byte(0x02), (*calls)[0].modifier)
	require.Contains(t, err.Error(), "paste wake release failed")
}

func TestWakeTargetForPasteSkipsWhenKeyboardRecentlyActive(t *testing.T) {
	withFastPasteWakeTiming(t)
	lastKeyboardReportTime.Store(time.Now().UnixNano())
	calls := withKeyboardReportWrite(t, func(modifier byte, keys []byte) error {
		return errors.New("unexpected keyboard report")
	})

	err := wakeTargetForPaste()

	require.NoError(t, err)
	require.Empty(t, *calls)
}

func TestWakeTargetForPasteAbortsOnWakeTapPressFailure(t *testing.T) {
	withFastPasteWakeTiming(t)
	lastKeyboardReportTime.Store(0)

	pressErr := errors.New("wake press failure")
	calls := withKeyboardReportWrite(t, func(modifier byte, keys []byte) error {
		if modifier == 0x02 {
			return pressErr
		}
		return nil
	})

	err := wakeTargetForPaste()

	require.ErrorIs(t, err, pressErr)
	require.Len(t, *calls, 1)
	require.Equal(t, byte(0x02), (*calls)[0].modifier)
	require.Contains(t, err.Error(), "paste wake tap failed")
}

func TestQuiesceAndZeroWireHandlerInjectsOriginatingSessionGeneration(t *testing.T) {
	keyboardWrites, pointerWrites := installSessionManagerTestSeams(t)
	origin := &Session{}
	if _, err := activateSession(context.Background(), origin, "initial"); err != nil {
		t.Fatal(err)
	}
	keyboardWritesBeforeQuiesce := keyboardWrites.Load()
	pointerWritesBeforeQuiesce := pointerWrites.Load()
	logger := zerolog.Nop()
	result, err := callRPCHandler(logger, rpcHandlers["quiesceAndZero"], map[string]any{
		"operationId": "wire-operation",
	}, origin)
	require.NoError(t, err)
	receipt, ok := result.(controlsession.Receipt)
	require.True(t, ok)
	require.Equal(t, "wire-operation", receipt.OperationID)
	require.Equal(t, origin.managerGenerationLoad(), receipt.Generation)
	require.Equal(t, controlsession.OutcomeReleased, receipt.Outcome)
	require.True(t, receipt.Draining)
	require.True(t, receipt.ProducersJoined)
	require.True(t, receipt.MacroInactive)
	require.True(t, receipt.PasteInactive)
	require.True(t, receipt.OrdinaryLeasesZero)
	require.True(t, receipt.KeyboardZero)
	require.True(t, receipt.PointerZero)
	require.Equal(t, keyboardWritesBeforeQuiesce+1, keyboardWrites.Load())
	require.Equal(t, pointerWritesBeforeQuiesce+1, pointerWrites.Load())
}

func TestQuiesceAndZeroWireHandlerDeclaresOnlyOperationID(t *testing.T) {
	require.Equal(t, []string{"operationId"}, rpcHandlers["quiesceAndZero"].Params)
	require.True(t, rpcHandlers["quiesceAndZero"].SessionBound)
}
