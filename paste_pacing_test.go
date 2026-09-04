package kvm

import (
	"context"
	"errors"
	"testing"

	"github.com/jetkvm/kvm/internal/hidrpc"
	"github.com/stretchr/testify/require"
)

func TestPastePacerPreservesWriteErrorAllClear(t *testing.T) {
	sentinel := errors.New("injected paste write failure")
	attempts := 0
	calls := withKeyboardReportWrite(t, func(byte, []byte) error {
		attempts++
		if attempts == 1 {
			return sentinel
		}
		return nil
	})
	err := rpcDoExecutePasteMacro(context.Background(), currentSessionSnapshot().Generation, []hidrpc.KeyboardMacroStep{
		{Modifier: 2, Keys: []byte{4, 0, 0, 0, 0, 0}, Delay: 10},
	})
	require.ErrorIs(t, err, sentinel)
	require.Len(t, *calls, 2)
	requireClearReport(t, (*calls)[1])
}

func TestPastePacerDoesNotWriteWhenAlreadyCancelled(t *testing.T) {
	calls := withKeyboardReportWrite(t, func(byte, []byte) error { return errors.New("unexpected write") })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := rpcDoExecutePasteMacro(ctx, currentSessionSnapshot().Generation, []hidrpc.KeyboardMacroStep{
		{Modifier: 2, Keys: []byte{4, 0, 0, 0, 0, 0}, Delay: 10},
	})
	require.ErrorIs(t, err, context.Canceled)
	require.Empty(t, *calls)
}

func TestPastePacerClearsWhenCancelledAfterPress(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := withKeyboardReportWrite(t, func(modifier byte, _ []byte) error {
		if modifier != 0 {
			cancel()
		}
		return nil
	})
	err := rpcDoExecutePasteMacro(ctx, currentSessionSnapshot().Generation, []hidrpc.KeyboardMacroStep{
		{Modifier: 2, Keys: []byte{4, 0, 0, 0, 0, 0}, Delay: 10},
		{Modifier: 2, Keys: []byte{5, 0, 0, 0, 0, 0}, Delay: 10},
	})
	require.ErrorIs(t, err, context.Canceled)
	require.Len(t, *calls, 2)
	requireClearReport(t, (*calls)[1])
}
