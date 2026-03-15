# Paste Reliability Fixes -- Design Spec

**Date:** 2026-03-15
**Status:** Approved
**Approach:** Minimal surgical fixes (Approach A)
**Branch:** `fix/paste-reliability`
**PR:** Single PR, one commit per fix, all issues referenced

---

## Context

The JetKVM private build's Paste Text feature handles large text/code pastes via chunked batching over HID-RPC. After 8 phases of development, the system works for most of a large paste but corrupts late in long runs.

### Confirmed behavior (live testing)
- **Pause only (no click):** Does NOT fix corruption -- only a few words resume correctly
- **Click into target window:** Immediately restores correct typing
- **Mouse move without click:** Does NOT fix corruption

This confirms target window focus is a real factor, but a team analysis of the full codebase found 7 reliability bugs that compound the problem.

### Scope
- Fix 7 reliability bugs (code fixes only, no UI polish)
- Defer dead code cleanup, UI styling, and maintenance issues to a follow-up PR
- All fixes are surgical: smallest possible diff per bug

---

## Fix #1: `waitForPasteMacroCompletion` Race Condition

**Issue:** GitHub Issue #30 (to be created)
**File:** `ui/src/hooks/useKeyboard.ts`
**Severity:** Critical

### Problem
The Zustand `subscribe` in `waitForPasteMacroCompletion` fires on ANY store state change, not just changes to `isPasteInProgress`. During macro execution, `keysDownState` updates constantly. This can cause premature resolution, silently re-introducing the original batch overlap bug from Phase 1.

### Fix
Add a value-change filter so only actual transitions of `isPasteInProgress` trigger the logic:

```typescript
let lastValue = useHidStore.getState().isPasteInProgress;

const unsubscribe = useHidStore.subscribe(state => {
  const current = state.isPasteInProgress;
  if (current === lastValue) return; // ignore unrelated state changes
  lastValue = current;

  if (current) {
    started = true;
    return;
  }
  if (started) {
    clearTimeout(timeout);
    unsubscribe();
    resolve();
  }
});
```

### Rationale
Filters noise from `keysDownState` and other store updates. Only actual transitions of `isPasteInProgress` are observed. This is the most dangerous bug because it can silently re-introduce the original overlap problem that Phase 2 was designed to fix.

---

## Fix #2: Wire in `longRunThreshold` / `longRunPauseMs`

**Issue:** GitHub Issue #31 (to be created)
**File:** `ui/src/hooks/useKeyboard.ts`
**Severity:** High

### Problem
`PasteModal.tsx` passes `longRunThreshold` and `longRunPauseMs` to `executePasteText`, but the `ExecutePasteTextOptions` interface does not declare these fields and they are never destructured. The long-run slowdown feature -- designed specifically to combat late-stage corruption -- does not work at all.

### Fix
1. Add both fields to `ExecutePasteTextOptions` interface
2. Destructure them in `executePasteText`
3. Add long-run pause logic to the existing pause calculation:

```typescript
const longRunMode = longRunThreshold !== undefined && (index + 1) >= longRunThreshold;
const longRunPause = longRunMode ? (longRunPauseMs ?? 0) : 0;
const appliedPauseMs = Math.max(batchPauseMs, tailPause, stressPause, longRunPause);
```

### Rationale
3 lines of logic restores a safety feature that was intended but silently dropped during code duplication from `pasteBatches.ts` to inline `executePasteText`.

---

## Fix #3: Distinguish Success vs Failure in Completion Signal

**Issue:** GitHub Issue #32 (to be created)
**Files:** `jsonrpc.go`, `internal/hidrpc/message.go`, `ui/src/hooks/hidRpc.ts`, `ui/src/hooks/stores.ts`, `ui/src/hooks/useKeyboard.ts`
**Severity:** High

### Problem
`rpcExecuteKeyboardMacro` sends `KeyboardMacroState{State: false}` whether the macro succeeded or aborted on a HID write error. The frontend cannot distinguish success from failure and moves to the next batch either way.

### Fix
**Backend:**
1. Add `Error string` field to `KeyboardMacroState` struct
2. Populate it when `rpcDoExecuteKeyboardMacro` returns an error
3. Include error in the marshaled state message

**Frontend:**
1. Add `pasteError` field to the HID store
2. Parse and store the error from `KeyboardMacroStateMessage`
3. In `waitForPasteMacroCompletion`, reject the promise if error is present
4. `executePasteText` catch block already handles errors -- it will show the notification

### Wire format change
The `KeyboardMacroStateMessage` currently marshals to 2 bytes (state + isPaste). The error string will be appended as a length-prefixed UTF-8 string after the existing fields. Old frontends that don't understand the new field will simply ignore the extra bytes (forward-compatible).

### Rationale
Without this, a batch that lost characters due to HID write timeout is reported as "done" and the next batch fires immediately, compounding the data loss.

---

## Fix #4: Goroutine Leak in `onHidMessage`

**Issue:** GitHub Issue #33 (to be created)
**File:** `hidrpc.go`
**Severity:** High

### Problem
Every macro message spawns a goroutine via `go func() { handleHidRPCMessage(...); r <- nil }()`. The `onHidMessage` function waits only 1 second, then abandons the channel. The goroutine finishes the macro but blocks on `r <- nil` with no receiver, leaking one goroutine per batch. Over a 500-batch paste, 500 goroutines leak on a resource-constrained ARM SoC.

### Fix
Make the channel buffered:

```go
r := make(chan interface{}, 1)  // was: make(chan interface{})
```

The goroutine can always send without blocking. The GC collects the channel and goroutine once both are unreachable.

### Rationale
One-character fix that eliminates a resource leak proportional to paste length. Each leaked goroutine holds at minimum a few KB of stack memory on the constrained device.

---

## Fix #5: Guard `UpdateKeysDown` Behind Successful Write

**Issue:** GitHub Issue #34 (to be created)
**File:** `internal/usbgadget/hid_keyboard.go`
**Severity:** Medium

### Problem
`KeyboardReport` calls `UpdateKeysDown(modifier, keys)` unconditionally, even when the HID write failed. This causes internal key state to diverge from what the host actually received, potentially causing subsequent reports to have incorrect modifier/key state.

### Fix
Move `UpdateKeysDown` behind the error check:

```go
err := u.keyboardWriteHidFile(modifier, keys)
if err != nil {
    u.log.Warn()...
    return err  // don't update state on failure
}
u.UpdateKeysDown(modifier, keys)
return nil
```

### Rationale
Internal state should only reflect what was actually sent to the host. With Fix #3, write errors now abort the macro and report failure, so this prevents stale state from affecting any retry attempts.

---

## Fix #6: Replace `time.After` with Reusable Timer in Macro Loop

**Issue:** GitHub Issue #35 (to be created)
**File:** `jsonrpc.go`
**Severity:** Medium

### Problem
Each step in `rpcDoExecuteKeyboardMacro` creates a `time.After` timer that is never explicitly stopped. If the context is canceled, the timer leaks until it fires. For macros with hundreds of steps, this creates GC pressure on the resource-constrained ARM SoC.

### Fix
Use a single `time.NewTimer` reused across all iterations:

```go
timer := time.NewTimer(0)
if !timer.Stop() {
    <-timer.C
}
defer timer.Stop()

for i, step := range macro {
    // ... write step ...
    if i < len(macro)-1 {
        delay := time.Duration(step.Delay) * time.Millisecond
        timer.Reset(delay)
        select {
        case <-timer.C:
        case <-ctx.Done():
            // reset keyboard state, return error
        }
    }
}
```

### Rationale
Standard Go best practice. Eliminates timer leak on cancel and reduces GC pressure during sustained macro execution.

---

## Fix #7: Post-Macro Drain Delay

**Issue:** GitHub Issue #36 (to be created)
**File:** `jsonrpc.go`
**Severity:** Medium

### Problem
The completion signal fires as soon as all writes to `/dev/hidg0` finish, but the host USB stack may still be consuming the input buffer. The next batch fires immediately, piling up input faster than the host can process.

### Fix
Add a 50ms sleep after the macro loop completes but before signaling completion:

```go
macroErr := rpcDoExecuteKeyboardMacro(ctx, macro)

// Allow host USB stack to drain pending HID reports
time.Sleep(50 * time.Millisecond)
```

### Rationale
50ms gives the host time to process ~50 USB polls at 1ms intervals, which exceeds the maximum pending report queue depth. This directly addresses the confirmed focus/consumption issue by ensuring the host has breathing room between batches. The delay is small enough to have negligible throughput impact (~10% slowdown on a 500ms batch).

---

## Git Workflow

### Issues
Create 7 GitHub issues (#30-#36), one per fix, in the private repo.

### Branch
Single branch: `fix/paste-reliability` off `main`

### Commits
One commit per fix, referencing the issue:
- `fix(frontend): filter waitForPasteMacroCompletion to isPasteInProgress changes (fixes #30)`
- `fix(frontend): wire in longRunThreshold and longRunPauseMs (fixes #31)`
- `fix(backend): include error in macro completion signal (fixes #32)`
- `fix(backend): buffer onHidMessage channel to prevent goroutine leak (fixes #33)`
- `fix(backend): guard UpdateKeysDown behind successful write (fixes #34)`
- `fix(backend): replace time.After with reusable timer in macro loop (fixes #35)`
- `fix(backend): add post-macro drain delay for host USB consumption (fixes #36)`

### PR
Single PR closing all 7 issues. Title: `fix: paste reliability -- 7 surgical fixes for late-stage corruption`

---

## Files Changed Summary

| File | Fixes | Estimated lines changed |
|------|-------|------------------------|
| `ui/src/hooks/useKeyboard.ts` | #1, #2, #3 (frontend portion) | ~20 |
| `ui/src/hooks/stores.ts` | #3 (add pasteError to store) | ~5 |
| `ui/src/hooks/hidRpc.ts` | #3 (parse error from message) | ~10 |
| `jsonrpc.go` | #3, #6, #7 | ~25 |
| `internal/hidrpc/message.go` | #3 (add Error to struct + marshal) | ~10 |
| `hidrpc.go` | #4 | 1 |
| `internal/usbgadget/hid_keyboard.go` | #5 | ~3 |

**Total: ~75 lines across 7 files**

---

## Testing Plan

After deployment to the JetKVM device:
1. Paste a small text (~100 chars) -- verify basic functionality still works
2. Paste a medium text (~2000 chars) -- verify completion-aware scheduling works
3. Paste a large text (~10000+ chars) via file-backed mode -- verify no late-stage corruption
4. During large paste, check device logs for:
   - No "HID RPC message timed out" goroutine leaks (fix #4)
   - Any error messages properly surfaced to frontend (fix #3)
5. Intentionally close the paste modal mid-paste -- verify no crash (existing behavior, not changed)
6. Compare reliability with "reliable" vs "fast" profile
