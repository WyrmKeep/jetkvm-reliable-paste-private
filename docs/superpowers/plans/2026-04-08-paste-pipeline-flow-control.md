# Paste Pipeline Flow Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace synchronous per-batch ACK with `bufferedAmount`-based flow control for 2-5x paste throughput improvement.

**Architecture:** Backend adds a channel-based macro queue with a drain goroutine — `rpcExecuteKeyboardMacro` enqueues and returns instantly. Frontend replaces `waitForPasteMacroCompletion()` with high/low watermark flow control on the HID data channel, following the existing pattern from `mount.tsx`.

**Tech Stack:** Go 1.24.4 (channels, context, zerolog), React 19, TypeScript 5.9, Zustand 4, WebRTC RTCDataChannel API

**Spec:** `docs/superpowers/specs/2026-04-08-paste-pipeline-flow-control-design.md`

---

## File Structure

### Backend (Go)

| File | Action | Responsibility |
|------|--------|----------------|
| `jsonrpc.go` | Modify (lines 1011-1071) | Add macro queue state, rewrite `rpcExecuteKeyboardMacro` to enqueue, add `startMacroQueue`, drain goroutine, `cancelAndDrainMacroQueue` |
| `webrtc.go` | Modify (line 430) | Replace `cancelKeyboardMacro()` with `cancelAndDrainMacroQueue()` |
| `web.go` | Modify (line 248) | Replace `cancelKeyboardMacro()` with `cancelAndDrainMacroQueue()` |
| `cloud.go` | Modify (line 481) | Replace `cancelKeyboardMacro()` with `cancelAndDrainMacroQueue()` |

### Frontend (TypeScript/React)

| File | Action | Responsibility |
|------|--------|----------------|
| `ui/src/hooks/useHidRpc.ts` | Modify (line 318-329) | Expose `rpcHidChannel` in return value |
| `ui/src/hooks/useKeyboard.ts` | Modify (lines 36-66, 93-100, 159-181, 337-361, 426-553) | Remove `waitForPasteMacroCompletion`, add `bufferedAmount` flow control to `executePasteText`, update types |
| `ui/src/components/popovers/PasteModal.tsx` | Modify (lines 42, 90-141) | Update progress tracking for three-phase pipeline model |

---

## Task 1: Backend — Add macro queue state and drain goroutine

**Files:**
- Modify: `jsonrpc.go:1011-1033` (replace `keyboardMacroCancel`/`keyboardMacroLock` block)

- [ ] **Step 1: Add macro queue state variables**

Replace the existing cancel state block at `jsonrpc.go:1011-1033` with queue-based state:

```go
var (
	// macroQueue is the channel-based FIFO for keyboard macro batches.
	// The drain goroutine is the sole consumer; rpcExecuteKeyboardMacro is the producer.
	macroQueue chan []hidrpc.KeyboardMacroStep

	// macroCurrentCancel cancels the currently executing macro in the drain goroutine.
	macroCurrentCancel context.CancelFunc
	macroLock          sync.Mutex
)
```

- [ ] **Step 2: Add `startMacroQueue` function**

Add after the state variables:

```go
// startMacroQueue creates the macro queue channel and starts the drain goroutine.
// Called when the first WebRTC session is established.
func startMacroQueue() {
	if macroQueue != nil {
		return
	}
	macroQueue = make(chan []hidrpc.KeyboardMacroStep, 64)
	go drainMacroQueue()
}
```

- [ ] **Step 3: Add `drainMacroQueue` goroutine**

```go
// drainMacroQueue is the sole consumer of macroQueue. It executes each macro
// sequentially and reports completion state to the frontend after each one.
func drainMacroQueue() {
	for macro := range macroQueue {
		macroID := keyboardMacroSequence.Add(1)
		logger.Info().Uint64("macro_id", macroID).Int("step_count", len(macro)).Msg("executing queued keyboard macro")

		ctx, cancel := context.WithCancel(context.Background())

		macroLock.Lock()
		macroCurrentCancel = cancel
		macroLock.Unlock()

		err := rpcDoExecuteKeyboardMacro(ctx, macro)
		if err != nil {
			logger.Warn().Uint64("macro_id", macroID).Err(err).Msg("queued keyboard macro failed")
		} else {
			logger.Info().Uint64("macro_id", macroID).Msg("queued keyboard macro completed")
		}

		macroLock.Lock()
		macroCurrentCancel = nil
		macroLock.Unlock()

		cancel()

		// Report per-macro completion (frontend uses this for draining phase detection)
		s := hidrpc.KeyboardMacroState{
			State:   false,
			IsPaste: true,
		}
		if currentSession != nil {
			currentSession.reportHidRPCKeyboardMacroState(s)
		}
	}
}
```

- [ ] **Step 4: Add `cancelAndDrainMacroQueue` function**

```go
// cancelAndDrainMacroQueue cancels the currently executing macro and discards
// all queued macros. Called on session teardown, session takeover, and explicit cancel.
func cancelAndDrainMacroQueue() {
	macroLock.Lock()
	if macroCurrentCancel != nil {
		macroCurrentCancel()
		logger.Info().Msg("canceled current keyboard macro")
	}
	macroLock.Unlock()

	// Drain any queued macros without executing them
	if macroQueue != nil {
		drained := 0
		for {
			select {
			case <-macroQueue:
				drained++
			default:
				if drained > 0 {
					logger.Info().Int("count", drained).Msg("drained queued keyboard macros")
				}
				return
			}
		}
	}
}
```

- [ ] **Step 5: Verify build compiles**

Run: `go vet ./...`
Expected: No errors (new functions are defined but not yet called)

- [ ] **Step 6: Commit**

```bash
git add jsonrpc.go
git commit -m "feat(paste): add macro queue channel and drain goroutine

Add channel-based macro queue state, drainMacroQueue goroutine that
executes macros sequentially, and cancelAndDrainMacroQueue for safe
teardown. Part of #39 pipeline flow control."
```

---

## Task 2: Backend — Rewrite `rpcExecuteKeyboardMacro` to enqueue

**Files:**
- Modify: `jsonrpc.go:1035-1071` (replace `rpcExecuteKeyboardMacro`, `rpcCancelKeyboardMacro`)

- [ ] **Step 1: Rewrite `rpcExecuteKeyboardMacro`**

Replace the existing function at `jsonrpc.go:1035-1067`:

```go
func rpcExecuteKeyboardMacro(macro []hidrpc.KeyboardMacroStep) error {
	macroID := keyboardMacroSequence.Add(1)
	logger.Info().Uint64("macro_id", macroID).Int("step_count", len(macro)).Msg("enqueuing keyboard macro")

	// Ensure queue is started (idempotent)
	startMacroQueue()

	// Non-blocking enqueue. Frontend bufferedAmount flow control prevents this
	// from ever filling, but drop with error as a safety net.
	select {
	case macroQueue <- macro:
		return nil
	default:
		logger.Warn().Uint64("macro_id", macroID).Msg("macro queue full, dropping batch")
		return fmt.Errorf("macro queue full")
	}
}
```

- [ ] **Step 2: Rewrite `rpcCancelKeyboardMacro`**

Replace the existing function at `jsonrpc.go:1069-1071`:

```go
func rpcCancelKeyboardMacro() {
	cancelAndDrainMacroQueue()
}
```

- [ ] **Step 3: Remove dead code**

Delete the now-unused functions that were replaced by queue-based equivalents:
- `cancelKeyboardMacro()` (lines 1017-1026)
- `setKeyboardMacroCancel()` (lines 1028-1033)

- [ ] **Step 4: Continue to Task 3 before committing**

Do NOT commit yet — `webrtc.go`, `web.go`, `cloud.go` still reference the deleted `cancelKeyboardMacro`. Task 3 fixes these, then all backend changes commit together.

---

## Task 3: Backend — Update all cancel call sites

**Files:**
- Modify: `webrtc.go:430`
- Modify: `web.go:248`
- Modify: `cloud.go:481`

- [ ] **Step 1: Update `webrtc.go`**

At line 430, replace:
```go
cancelKeyboardMacro()
```
with:
```go
cancelAndDrainMacroQueue()
```

- [ ] **Step 2: Update `web.go`**

At line 248, replace:
```go
cancelKeyboardMacro()
```
with:
```go
cancelAndDrainMacroQueue()
```

- [ ] **Step 3: Update `cloud.go`**

At line 481, replace:
```go
cancelKeyboardMacro()
```
with:
```go
cancelAndDrainMacroQueue()
```

- [ ] **Step 4: Verify full build**

Run: `go vet ./...`
Expected: Clean — all references to `cancelKeyboardMacro` are removed.

- [ ] **Step 5: Run Go tests**

Run: `go test ./...`
Expected: All existing tests pass.

- [ ] **Step 6: Commit backend changes (Tasks 1-3 together)**

```bash
git add jsonrpc.go webrtc.go web.go cloud.go
git commit -m "feat(paste): replace cancel-on-arrival with macro queue pipeline

Replace cancelKeyboardMacro() pattern with channel-based macro queue.
rpcExecuteKeyboardMacro now enqueues and returns immediately; a drain
goroutine executes macros sequentially. Cancel drains the queue and
stops the current macro.

Part of #39 — pipeline batch execution with bufferedAmount flow control."
```

---

## Task 4: Frontend — Expose `rpcHidChannel` from `useHidRpc`

**Files:**
- Modify: `ui/src/hooks/useHidRpc.ts:318-329`

The `executePasteText` send loop needs direct access to `rpcHidChannel` for `bufferedAmount` monitoring. Currently the channel is accessed inside `useHidRpc` but not exposed in its return value.

- [ ] **Step 1: Add `rpcHidChannel` to return value**

At `useHidRpc.ts:318-329`, add `rpcHidChannel` to the return object:

```typescript
  return {
    reportKeyboardEvent,
    reportKeypressEvent,
    reportAbsMouseEvent,
    reportRelMouseEvent,
    reportKeyboardMacroEvent,
    cancelOngoingKeyboardMacro,
    reportKeypressKeepAlive,
    rpcHidChannel,
    rpcHidProtocolVersion,
    rpcHidReady,
    rpcHidStatus,
  };
```

- [ ] **Step 2: Verify lint passes**

Run: `cd ui && npm run lint`
Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/hooks/useHidRpc.ts
git commit -m "refactor(paste): expose rpcHidChannel from useHidRpc

Needed by executePasteText for bufferedAmount flow control on the
HID data channel. Part of #39."
```

---

## Task 5: Frontend — Replace `waitForPasteMacroCompletion` with `bufferedAmount` flow control

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts:36-66, 93-100, 159-181, 337-361, 426-553`

This is the core frontend change. The send loop in `executePasteText` stops waiting for per-batch ACKs and instead uses `bufferedAmount` high/low watermarks.

- [ ] **Step 1: Update `PasteExecutionTrace` interface**

At `useKeyboard.ts:41-50`, replace with:

```typescript
export interface PasteExecutionTrace {
  batchIndex: number;
  totalBatches: number;
  stepCount: number;
  estimatedBytes: number;
  bufferedAmount: number;
}
```

This removes `durationMs`, `appliedPauseMs`, `tailMode`, `stressMode` (no longer meaningful with pipeline) and adds `bufferedAmount` for pipeline depth monitoring.

- [ ] **Step 2: Simplify `ExecutePasteTextOptions`**

At `useKeyboard.ts:52-66`, replace with:

```typescript
export interface ExecutePasteTextOptions {
  keyboard: KeyboardLayoutLike;
  delayMs: number;
  maxStepsPerBatch: number;
  maxBytesPerBatch: number;
  finalSettleMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: PasteExecutionProgress) => void;
  onTrace?: (trace: PasteExecutionTrace) => void;
}
```

This removes `batchPauseMs`, `tailBatchCount`, `tailPauseMs`, `stressDurationMs`, `stressPauseMs` — all compensated for synchronous ACK latency that no longer exists.

- [ ] **Step 3: Destructure `rpcHidChannel` from `useHidRpc`**

At `useKeyboard.ts:93-100`, update the destructure to include `rpcHidChannel`:

```typescript
  const {
    reportKeyboardEvent: sendKeyboardEventHidRpc,
    reportKeypressEvent: sendKeypressEventHidRpc,
    reportKeyboardMacroEvent: sendKeyboardMacroEventHidRpc,
    cancelOngoingKeyboardMacro: cancelOngoingKeyboardMacroHidRpc,
    reportKeypressKeepAlive: sendKeypressKeepAliveHidRpc,
    rpcHidChannel,
    rpcHidReady,
  } = useHidRpc(message => {
```

- [ ] **Step 4: Delete `waitForPasteMacroCompletion`**

Delete the entire function at `useKeyboard.ts:159-181`:

```typescript
  // DELETE THIS ENTIRE BLOCK:
  const waitForPasteMacroCompletion = useCallback(async (timeoutMs = 30000) => {
    ...
  }, []);
```

- [ ] **Step 5: Simplify `executeMacroRemote` — remove completion waiting for paste**

At `useKeyboard.ts:337-361`, replace with:

```typescript
  const executeMacroRemote = useCallback(
    async (steps: MacroSteps, isPaste = false) => {
      const macro: KeyboardMacroStep[] = [];

      for (const [_, step] of steps.entries()) {
        const keyValues = (step.keys || []).map(key => keys[key]).filter(Boolean);
        const modifierMask: number = (step.modifiers || [])
          .map(mod => modifiers[mod])
          .reduce((acc, val) => acc + val, 0);

        if (keyValues.length > 0 || modifierMask > 0) {
          macro.push({ keys: keyValues, modifier: modifierMask, delay: 5 });
          macro.push({ ...MACRO_RESET_KEYBOARD_STATE, delay: step.delay || 25 });
        }
      }

      sendKeyboardMacroEventHidRpc(macro, isPaste);
    },
    [sendKeyboardMacroEventHidRpc],
  );
```

Key changes: removed `completionPromise` / `waitForPasteMacroCompletion` call, removed `await`. The function now fires and returns immediately for paste.

- [ ] **Step 6: Rewrite `executePasteText` with `bufferedAmount` flow control**

Replace the entire function at `useKeyboard.ts:436-553`:

```typescript
  const executePasteText = useCallback(
    async (text: string, options: ExecutePasteTextOptions) => {
      const {
        keyboard,
        delayMs,
        maxStepsPerBatch,
        maxBytesPerBatch,
        finalSettleMs,
        signal,
        onProgress,
        onTrace,
      } = options;

      const batches: MacroSteps[] = [];
      let currentBatch: MacroSteps = [];

      const estimateBytes = (logicalSteps: number) => 6 + logicalSteps * 18;

      const flushBatch = () => {
        if (currentBatch.length === 0) return;
        batches.push(currentBatch);
        currentBatch = [];
      };

      const invalidChars = new Set<string>();

      for (const char of text) {
        const normalizedChar = char.normalize("NFC");
        const charSteps = buildStepsForChar(normalizedChar, keyboard, delayMs);
        if (!charSteps) {
          invalidChars.add(normalizedChar);
          continue;
        }

        const projectedSteps = currentBatch.length + charSteps.length;
        const projectedBytes = estimateBytes(projectedSteps);

        if (
          currentBatch.length > 0 &&
          (projectedSteps > maxStepsPerBatch || projectedBytes > maxBytesPerBatch)
        ) {
          flushBatch();
        }

        currentBatch.push(...charSteps);
      }

      flushBatch();

      if (invalidChars.size > 0) {
        throw new Error(`Unsupported characters: ${Array.from(invalidChars).join(", ")}`);
      }

      // Pipeline flow control constants
      const PASTE_LOW_WATERMARK = 64 * 1024;
      const PASTE_HIGH_WATERMARK = 256 * 1024;

      const channel = rpcHidChannel;
      if (!channel || channel.readyState !== "open") {
        throw new Error("HID data channel not available");
      }

      // Save and set bufferedAmount threshold for paste flow control
      const prevThreshold = channel.bufferedAmountLowThreshold;
      channel.bufferedAmountLowThreshold = PASTE_LOW_WATERMARK;

      let drainResolve: (() => void) | null = null;
      const waitForDrain = () => new Promise<void>(r => { drainResolve = r; });
      const onLow = () => { drainResolve?.(); };
      channel.addEventListener("bufferedamountlow", onLow);

      try {
        for (let index = 0; index < batches.length; index++) {
          if (signal?.aborted) {
            throw new Error("Paste execution aborted");
          }

          const batch = batches[index];
          await executePasteMacro(batch);

          onTrace?.({
            batchIndex: index + 1,
            totalBatches: batches.length,
            stepCount: batch.length,
            estimatedBytes: estimateBytes(batch.length),
            bufferedAmount: channel.bufferedAmount,
          });

          onProgress?.({
            completedBatches: index + 1,
            totalBatches: batches.length,
          });

          // Pause if channel buffer exceeds high watermark
          if (channel.bufferedAmount >= PASTE_HIGH_WATERMARK) {
            await waitForDrain();
          }
        }

        // Wait for final settle (backend finishes executing remaining queued macros)
        if (finalSettleMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, finalSettleMs);
            const abortHandler = () => {
              clearTimeout(timeout);
              reject(new Error("Paste execution aborted"));
            };
            signal?.addEventListener("abort", abortHandler, { once: true });
          });
        }
      } finally {
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.bufferedAmountLowThreshold = prevThreshold;
      }
    },
    [executePasteMacro, rpcHidChannel],
  );
```

Key changes:
- Removed `batchPauseMs`, `tailBatchCount`, `tailPauseMs`, `stressDurationMs`, `stressPauseMs` destructuring
- Added `bufferedAmount` flow control with high/low watermarks
- `executePasteMacro(batch)` still calls `executeMacroRemote` which now returns immediately
- Threshold and listener cleaned up in `finally` block
- `finalSettleMs` retained for backend drain time

- [ ] **Step 7: Verify lint passes**

Run: `cd ui && npm run lint`
Expected: Clean. If type errors appear from PasteModal.tsx (removed options), those are fixed in Task 6.

- [ ] **Step 8: Commit**

```bash
git add ui/src/hooks/useKeyboard.ts
git commit -m "feat(paste): replace ACK waiting with bufferedAmount flow control

Remove waitForPasteMacroCompletion and per-batch ACK subscription.
executePasteText now fires batches continuously, pausing only when
the HID channel bufferedAmount exceeds 256KB high watermark. Resumes
on bufferedamountlow at 64KB.

Removes adaptive pacing options (tailPauseMs, stressPauseMs, etc.)
that compensated for the synchronous round-trip stall.

Part of #39 — pipeline batch execution with bufferedAmount flow control."
```

---

## Task 6: Frontend — Update PasteModal.tsx for pipeline progress

**Files:**
- Modify: `ui/src/components/popovers/PasteModal.tsx:42, 90-141`

PasteModal needs to pass the simplified options and handle the three-phase progress model.

- [ ] **Step 1: Update `onConfirmPaste` to use simplified options**

At `PasteModal.tsx:104-131`, replace the `executePasteText` call:

```typescript
      await executePasteText(text, {
        keyboard: selectedKeyboard as KeyboardLayoutLike,
        delayMs: effectiveDelay,
        maxStepsPerBatch: profile.maxStepsPerBatch,
        maxBytesPerBatch: profile.maxBytesPerBatch,
        finalSettleMs: 3000,
        signal: abortController.signal,
        onProgress: progress => {
          setPasteProgress({
            completed: progress.completedBatches,
            total: progress.totalBatches,
            phase: progress.completedBatches === progress.totalBatches ? "draining" : "sending",
          });
        },
        onTrace: trace => {
          setTraceLinesPersisted(current => [
            ...current,
            `batch ${trace.batchIndex}/${trace.totalBatches}: steps=${trace.stepCount} bytes=${trace.estimatedBytes} buffered=${trace.bufferedAmount}`,
          ]);
        },
      });
```

Key changes:
- Removed `batchPauseMs`, `tailBatchCount`, `tailPauseMs`, `longRunThreshold`, `longRunPauseMs`, `stressDurationMs`, `stressPauseMs`
- `finalSettleMs` increased to 3000ms (longer drain window since macros are now queued)
- Trace format uses `bufferedAmount` instead of `duration`/`pause`/`tail`/`stress`
- Progress phase logic unchanged (already had sending/draining)

- [ ] **Step 2: Clean up unused imports from PasteModal.tsx dependency array**

At `PasteModal.tsx:141`, simplify the dependency array for `onConfirmPaste`:

```typescript
  }, [selectedKeyboard, executePasteText, delay, debugMode, selectedFile, fileText, setTraceLinesPersisted]);
```

Remove `pasteProfile` from deps since profile is only used for `maxStepsPerBatch`/`maxBytesPerBatch`/`keyDelayMs` now, and `profile` is already derived inside the callback.

Wait — `pasteProfile` is still used to select the profile object. Keep it:

```typescript
  }, [selectedKeyboard, executePasteText, delay, pasteProfile, debugMode, selectedFile, fileText, setTraceLinesPersisted]);
```

No change needed — the existing dep array is correct.

- [ ] **Step 3: Verify lint passes**

Run: `cd ui && npm run lint`
Expected: Clean.

- [ ] **Step 4: Verify i18n (no new user-facing strings added)**

Run: `cd ui && npm run i18n:validate`
Expected: Clean — no new keys needed.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/popovers/PasteModal.tsx
git commit -m "feat(paste): update PasteModal for pipeline progress model

Simplify executePasteText options (remove adaptive pacing params),
increase finalSettleMs for queued macro drain time, update trace
format to show bufferedAmount instead of per-batch timing.

Part of #39 — pipeline batch execution with bufferedAmount flow control."
```

---

## Task 7: Verification — Full build and lint check

**Files:** None (verification only)

- [ ] **Step 1: Go vet**

Run: `go vet ./...`
Expected: Clean.

- [ ] **Step 2: Go tests**

Run: `go test ./...`
Expected: All pass.

- [ ] **Step 3: Frontend lint**

Run: `cd ui && npm run lint`
Expected: Clean.

- [ ] **Step 4: i18n validation**

Run: `cd ui && npm run i18n:validate`
Expected: Clean.

- [ ] **Step 5: Security scan — forbidden patterns**

Run: `grep -rn "fmt\.Print\|log\.Fatal\|log\.Panic\|log\.Print" --include="*.go" jsonrpc.go webrtc.go web.go cloud.go`
Expected: No matches in changed files.

Run: `grep -rn "console\.log" --include="*.ts" --include="*.tsx" ui/src/hooks/useKeyboard.ts ui/src/hooks/useHidRpc.ts ui/src/components/popovers/PasteModal.tsx`
Expected: No matches in changed files (existing console.error in catch blocks are acceptable).

- [ ] **Step 6: Review diff**

Run: `git diff main...HEAD --stat`
Expected: Only the files listed in the plan are modified:
- `jsonrpc.go`
- `webrtc.go`
- `web.go`
- `cloud.go`
- `ui/src/hooks/useHidRpc.ts`
- `ui/src/hooks/useKeyboard.ts`
- `ui/src/components/popovers/PasteModal.tsx`
- `docs/superpowers/specs/2026-04-08-paste-pipeline-flow-control-design.md`
