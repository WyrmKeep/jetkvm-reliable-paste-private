package kvm

import (
    "context"
    "errors"
    "time"

    "github.com/jetkvm/kvm/internal/controlsession"
    "github.com/jetkvm/kvm/internal/hidrpc"
    "github.com/jetkvm/kvm/internal/pastepacing"
)

// Paste uses minimum post-write phase spacing. Ordinary keyboard macros retain
// their existing deadline scheduler in rpcDoExecuteKeyboardMacro.
func rpcDoExecutePasteMacro(ctx context.Context, generation controlsession.Generation, macro []hidrpc.KeyboardMacroStep) error {
    logKeyboardMacroExecution(logger, macro)
    delays := make([]time.Duration, len(macro))
    for i, step := range macro { delays[i] = time.Duration(step.Delay) * time.Millisecond }
    wrote := false
    err := pastepacing.Run(ctx, delays, func(i int) error {
        wrote = true
        // Includes existing write-error all-clear and generation lease checks.
        return executeKeyboardMacroStep(generation, macro[i])
    })
    if wrote && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
        if clearErr := rpcKeyboardReportForGeneration(generation, 0, keyboardClearStateKeys); clearErr != nil {
            logger.Warn().Err(clearErr).Msg("failed to reset keyboard after cancelled paste")
        }
    }
    return err
}
