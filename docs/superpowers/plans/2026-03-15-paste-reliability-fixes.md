# Paste Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 7 reliability bugs causing late-stage paste corruption in JetKVM's chunked paste system.

**Architecture:** Surgical fixes across the frontend (React/TypeScript) and backend (Go). Each fix is independent and committed separately. A single feature branch `fix/paste-reliability` holds all commits, merged via one PR.

**Tech Stack:** TypeScript/React (Zustand state management), Go (USB HID gadget driver, JSON-RPC)

**Spec:** `docs/superpowers/specs/2026-03-15-paste-reliability-fixes-design.md`

---

## Chunk 1: Setup and Frontend Fixes

### Task 0: Create GitHub Issues and Feature Branch

**Files:** None (git/GitHub operations only)

- [ ] **Step 1: Create 7 GitHub issues**

Run these commands to create all issues:

```bash
cd "D:/Coding/Development/Claude/AI Prompts/projects/jetkvm-related/repo"

gh issue create --repo WyrmKeep/jetkvm-reliable-paste-private \
  --title "fix: waitForPasteMacroCompletion race condition causes premature batch overlap" \
  --body "Zustand subscribe fires on ANY store state change (keysDownState updates constantly during macro execution), not just isPasteInProgress transitions. This can cause premature resolution and silently re-introduce the original batch overlap bug from Phase 1."

gh issue create --repo WyrmKeep/jetkvm-reliable-paste-private \
  --title "fix: longRunThreshold and longRunPauseMs silently dropped from executePasteText" \
  --body "PasteModal.tsx passes longRunThreshold and longRunPauseMs to executePasteText, but ExecutePasteTextOptions does not declare these fields. The long-run slowdown feature designed to combat late-stage corruption does not work at all."

gh issue create --repo WyrmKeep/jetkvm-reliable-paste-private \
  --title "fix: macro completion signal does not distinguish success from failure" \
  --body "rpcExecuteKeyboardMacro sends KeyboardMacroState{State: false} whether the macro succeeded or aborted on HID write error. Frontend cannot distinguish and moves to next batch either way."

gh issue create --repo WyrmKeep/jetkvm-reliable-paste-private \
  --title "fix: goroutine leak in onHidMessage due to unbuffered channel" \
  --body "Every macro message spawns a goroutine that sends to unbuffered channel r. After the 1s timeout, nobody reads r, so the goroutine blocks forever. Leaks one goroutine per batch on resource-constrained ARM SoC."

gh issue create --repo WyrmKeep/jetkvm-reliable-paste-private \
  --title "fix: UpdateKeysDown called unconditionally even on failed HID writes" \
  --body "KeyboardReport calls UpdateKeysDown(modifier, keys) regardless of write success. Internal key state diverges from what the host received after a failed write."

gh issue create --repo WyrmKeep/jetkvm-reliable-paste-private \
  --title "fix: time.After timer leak in rpcDoExecuteKeyboardMacro loop" \
  --body "Each step creates a time.After timer that leaks until it fires. On cancel, hundreds of leaked timers accumulate. Known Go anti-pattern, causes GC pressure on embedded hardware."

gh issue create --repo WyrmKeep/jetkvm-reliable-paste-private \
  --title "fix: no post-macro drain delay causes host USB buffer pressure" \
  --body "Completion signal fires immediately after HID writes finish, but host USB stack may still be consuming input buffer. Next batch fires immediately, piling up faster than host can process."
```

Note: Capture the actual issue numbers from the output. They will be used in commit messages.

- [ ] **Step 2: Create feature branch**

```bash
git checkout -b fix/paste-reliability
```

---

### Task 1: Fix waitForPasteMacroCompletion Race Condition

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts:159-181`

- [ ] **Step 1: Apply the fix**

In `ui/src/hooks/useKeyboard.ts`, replace the `waitForPasteMacroCompletion` function (lines 159-181) with:

```typescript
  const waitForPasteMacroCompletion = useCallback(async (timeoutMs = 30000) => {
    let started = false;
    let lastValue = useHidStore.getState().isPasteInProgress;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Paste macro timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsubscribe = useHidStore.subscribe(state => {
        const current = state.isPasteInProgress;
        if (current === lastValue) return;
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
    });
  }, []);
```

Key change: Added `lastValue` tracking and `if (current === lastValue) return;` filter. This ensures only actual transitions of `isPasteInProgress` trigger the completion logic, filtering out noise from `keysDownState` and other store updates.

- [ ] **Step 2: Verify no TypeScript errors**

```bash
cd ui && npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors related to `useKeyboard.ts`

- [ ] **Step 3: Commit**

```bash
git add ui/src/hooks/useKeyboard.ts
git commit -m "fix(frontend): filter waitForPasteMacroCompletion to isPasteInProgress changes (fixes #ISSUE_NUM)"
```

Replace `#ISSUE_NUM` with the actual issue number from Task 0.

---

### Task 2: Wire in longRunThreshold and longRunPauseMs

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts:52-66` (interface)
- Modify: `ui/src/hooks/useKeyboard.ts:438-452` (destructuring)
- Modify: `ui/src/hooks/useKeyboard.ts:507-511` (pause calculation)

- [ ] **Step 1: Add fields to ExecutePasteTextOptions interface**

In `ui/src/hooks/useKeyboard.ts`, add two fields to the `ExecutePasteTextOptions` interface after `stressPauseMs` (line 62):

```typescript
export interface ExecutePasteTextOptions {
  keyboard: KeyboardLayoutLike;
  delayMs: number;
  maxStepsPerBatch: number;
  maxBytesPerBatch: number;
  batchPauseMs: number;
  finalSettleMs: number;
  tailBatchCount: number;
  tailPauseMs: number;
  stressDurationMs: number;
  stressPauseMs: number;
  longRunThreshold?: number;
  longRunPauseMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: PasteExecutionProgress) => void;
  onTrace?: (trace: PasteExecutionTrace) => void;
}
```

- [ ] **Step 2: Destructure the new fields**

In the destructuring block at lines 438-452, add `longRunThreshold` and `longRunPauseMs`:

```typescript
      const {
        keyboard,
        delayMs,
        maxStepsPerBatch,
        maxBytesPerBatch,
        batchPauseMs,
        finalSettleMs,
        tailBatchCount,
        tailPauseMs,
        stressDurationMs,
        stressPauseMs,
        longRunThreshold,
        longRunPauseMs,
        signal,
        onProgress,
        onTrace,
      } = options;
```

- [ ] **Step 3: Add long-run pause to the calculation**

Replace the pause calculation block (lines 504-511) with:

```typescript
        const batchesRemaining = batches.length - (index + 1);
        const tailMode = tailBatchCount > 0 && batchesRemaining < tailBatchCount;
        const stressMode = durationMs >= stressDurationMs;
        const longRunMode = longRunThreshold !== undefined && (index + 1) >= longRunThreshold;
        const appliedPauseMs = Math.max(
          batchPauseMs,
          tailMode ? tailPauseMs : 0,
          stressMode ? stressPauseMs : 0,
          longRunMode ? (longRunPauseMs ?? 0) : 0,
        );
```

- [ ] **Step 4: Verify no TypeScript errors**

```bash
cd ui && npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/useKeyboard.ts
git commit -m "fix(frontend): wire in longRunThreshold and longRunPauseMs (fixes #ISSUE_NUM)"
```

---

## Chunk 2: Backend Fixes

### Task 3: Add Error Field to Macro Completion Signal

This is the most complex fix -- it spans both backend and frontend with a wire format change.

**Files:**
- Modify: `internal/hidrpc/message.go:192-207` (add Error to struct)
- Modify: `internal/hidrpc/hidrpc.go:109-123` (add error to message constructor)
- Modify: `jsonrpc.go:1043-1066` (populate error in completion signal)
- Modify: `ui/src/hooks/hidRpc.ts:268-289` (parse error from message)
- Modify: `ui/src/hooks/stores.ts:491-506,508-531` (add pasteError to store)
- Modify: `ui/src/hooks/useKeyboard.ts:101-116` (handle error in message handler)
- Modify: `ui/src/hooks/useKeyboard.ts:159-181` (reject on error in completion)

- [ ] **Step 1: Add Error field to Go KeyboardMacroState struct**

In `internal/hidrpc/message.go`, replace the struct at lines 192-195:

```go
type KeyboardMacroState struct {
	State   bool
	IsPaste bool
	Error   string
}
```

- [ ] **Step 2: Update Go message constructor to include error**

In `internal/hidrpc/hidrpc.go`, replace `NewKeyboardMacroStateMessage` (lines 109-123):

```go
// NewKeyboardMacroStateMessage creates a new keyboard macro state message.
func NewKeyboardMacroStateMessage(state bool, isPaste bool, errMsg string) *Message {
	data := make([]byte, 2)
	if state {
		data[0] = 1
	}
	if isPaste {
		data[1] = 1
	}

	// Append error string as length-prefixed UTF-8
	if len(errMsg) > 0 {
		errBytes := []byte(errMsg)
		lenBytes := []byte{byte(len(errBytes) >> 8), byte(len(errBytes) & 0xFF)}
		data = append(data, lenBytes...)
		data = append(data, errBytes...)
	}

	return &Message{
		t: TypeKeyboardMacroState,
		d: data,
	}
}
```

- [ ] **Step 3: Update Go KeyboardMacroState parser to read error**

In `internal/hidrpc/message.go`, replace the `KeyboardMacroState()` method (lines 197-207):

```go
// KeyboardMacroState returns the keyboard macro state report from the message.
func (m *Message) KeyboardMacroState() (KeyboardMacroState, error) {
	if m.t != TypeKeyboardMacroState {
		return KeyboardMacroState{}, fmt.Errorf("invalid message type: %d", m.t)
	}

	state := KeyboardMacroState{
		State:   m.d[0] == uint8(1),
		IsPaste: m.d[1] == uint8(1),
	}

	// Parse optional error string (length-prefixed UTF-8 after byte 2)
	if len(m.d) > 3 {
		errLen := int(m.d[2])<<8 | int(m.d[3])
		if len(m.d) >= 4+errLen {
			state.Error = string(m.d[4 : 4+errLen])
		}
	}

	return state, nil
}
```

- [ ] **Step 4: Update caller in hidrpc.go to pass error**

In `hidrpc.go`, update line 215 where `NewKeyboardMacroStateMessage` is called:

```go
	case hidrpc.KeyboardMacroState:
		message, err = hidrpc.NewKeyboardMacroStateMessage(params.State, params.IsPaste, params.Error).Marshal()
```

- [ ] **Step 5: Update jsonrpc.go to populate error in completion signal**

In `jsonrpc.go`, replace the completion signal block (lines 1052-1064):

```go
	err := rpcDoExecuteKeyboardMacro(ctx, macro)
	if err != nil {
		logger.Warn().Uint64("macro_id", macroID).Err(err).Msg("keyboard macro execution failed")
	} else {
		logger.Info().Uint64("macro_id", macroID).Msg("keyboard macro execution completed")
	}

	setKeyboardMacroCancel(nil)

	s.State = false
	if err != nil {
		s.Error = err.Error()
	}
	if currentSession != nil {
		currentSession.reportHidRPCKeyboardMacroState(s)
	}
```

- [ ] **Step 6: Update frontend KeyboardMacroStateMessage to parse error**

In `ui/src/hooks/hidRpc.ts`, update the `KeyboardMacroStateMessage` class (lines 268-289):

```typescript
export class KeyboardMacroStateMessage extends RpcMessage {
  state: boolean;
  isPaste: boolean;
  error: string;

  constructor(state: boolean, isPaste: boolean, error = "") {
    super(HID_RPC_MESSAGE_TYPES.KeyboardMacroState);
    this.state = state;
    this.isPaste = isPaste;
    this.error = error;
  }

  marshal(): Uint8Array {
    return new Uint8Array([this.messageType, this.state ? 1 : 0, this.isPaste ? 1 : 0]);
  }

  public static unmarshal(data: Uint8Array): KeyboardMacroStateMessage | undefined {
    if (data.length < 1) {
      throw new Error(`Invalid keyboard macro state report message length: ${data.length}`);
    }

    let error = "";
    if (data.length > 3) {
      const errLen = (data[2] << 8) | data[3];
      if (data.length >= 4 + errLen) {
        error = new TextDecoder().decode(data.slice(4, 4 + errLen));
      }
    }

    return new KeyboardMacroStateMessage(data[0] === 1, data[1] === 1, error);
  }
}
```

- [ ] **Step 7: Add pasteError to HID store**

In `ui/src/hooks/stores.ts`, update the `HidState` interface (around line 491) to add:

```typescript
export interface HidState {
  keyboardLedState: KeyboardLedState;
  setKeyboardLedState: (state: KeyboardLedState) => void;

  keysDownState: KeysDownState;
  setKeysDownState: (state: KeysDownState) => void;

  isVirtualKeyboardEnabled: boolean;
  setVirtualKeyboardEnabled: (enabled: boolean) => void;

  isPasteInProgress: boolean;
  setPasteModeEnabled: (enabled: boolean) => void;

  pasteError: string;
  setPasteError: (error: string) => void;

  usbState: USBStates;
  setUsbState: (state: USBStates) => void;
}
```

And in the `useHidStore` implementation (around line 508), add after `setPasteModeEnabled`:

```typescript
  pasteError: "",
  setPasteError: (error: string): void => set({ pasteError: error }),
```

- [ ] **Step 8: Handle error in useKeyboard message handler**

In `ui/src/hooks/useKeyboard.ts`, update the `KeyboardMacroStateMessage` handler (lines 109-112):

```typescript
      case KeyboardMacroStateMessage: {
        const macroMsg = message as KeyboardMacroStateMessage;
        if (!macroMsg.isPaste) break;
        setPasteModeEnabled(macroMsg.state);
        if (macroMsg.state) {
          // Clear any previous error when a new macro starts
          setPasteError("");
        } else if (macroMsg.error) {
          setPasteError(macroMsg.error);
        }
        break;
      }
```

And add `setPasteError` to the destructured store values at line 71:

```typescript
  const { keysDownState, setKeysDownState, setKeyboardLedState, setPasteModeEnabled, setPasteError } =
    useHidStore();
```

- [ ] **Step 9: Check for error in waitForPasteMacroCompletion**

Update the `waitForPasteMacroCompletion` function (from Task 1) to also reject on error:

```typescript
  const waitForPasteMacroCompletion = useCallback(async (timeoutMs = 30000) => {
    let started = false;
    let lastValue = useHidStore.getState().isPasteInProgress;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Paste macro timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsubscribe = useHidStore.subscribe(state => {
        const current = state.isPasteInProgress;
        if (current === lastValue) return;
        lastValue = current;

        if (current) {
          started = true;
          return;
        }

        if (started) {
          clearTimeout(timeout);
          unsubscribe();
          const error = state.pasteError;
          if (error) {
            reject(new Error(`Macro execution failed: ${error}`));
          } else {
            resolve();
          }
        }
      });
    });
  }, []);
```

- [ ] **Step 10: Verify no TypeScript errors**

```bash
cd ui && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 11: Verify Go compiles**

```bash
# From repo root -- cross-compile check (no need to build for ARM, just check syntax)
go vet ./... 2>&1 | head -20
```

- [ ] **Step 12: Commit**

```bash
git add internal/hidrpc/message.go internal/hidrpc/hidrpc.go jsonrpc.go hidrpc.go \
  ui/src/hooks/hidRpc.ts ui/src/hooks/stores.ts ui/src/hooks/useKeyboard.ts
git commit -m "fix(backend+frontend): include error in macro completion signal (fixes #ISSUE_NUM)"
```

---

### Task 4: Fix Goroutine Leak in onHidMessage

**Files:**
- Modify: `hidrpc.go:93`

- [ ] **Step 1: Make channel buffered**

In `hidrpc.go`, change line 93 from:

```go
	r := make(chan interface{})
```

to:

```go
	r := make(chan interface{}, 1)
```

- [ ] **Step 2: Commit**

```bash
git add hidrpc.go
git commit -m "fix(backend): buffer onHidMessage channel to prevent goroutine leak (fixes #ISSUE_NUM)"
```

---

### Task 5: Guard UpdateKeysDown Behind Successful Write

**Files:**
- Modify: `internal/usbgadget/hid_keyboard.go:365-382`

- [ ] **Step 1: Move UpdateKeysDown behind error check**

In `internal/usbgadget/hid_keyboard.go`, replace the `KeyboardReport` function (lines 365-382):

```go
func (u *UsbGadget) KeyboardReport(modifier byte, keys []byte) error {
	defer u.resetUserInputTime()

	if len(keys) > hidKeyBufferSize {
		keys = keys[:hidKeyBufferSize]
	}
	if len(keys) < hidKeyBufferSize {
		keys = append(keys, make([]byte, hidKeyBufferSize-len(keys))...)
	}

	err := u.keyboardWriteHidFile(modifier, keys)
	if err != nil {
		u.log.Warn().Uint8("modifier", modifier).Uints8("keys", keys).Msg("Could not write keyboard report to hidg0")
		return err
	}

	u.UpdateKeysDown(modifier, keys)
	return nil
}
```

Key change: `UpdateKeysDown` is now only called after a successful write. On error, we return immediately without updating internal state.

- [ ] **Step 2: Commit**

```bash
git add internal/usbgadget/hid_keyboard.go
git commit -m "fix(backend): guard UpdateKeysDown behind successful write (fixes #ISSUE_NUM)"
```

---

### Task 6: Replace time.After with Reusable Timer in Macro Loop

**Files:**
- Modify: `jsonrpc.go:1080-1114`

- [ ] **Step 1: Replace the macro loop**

In `jsonrpc.go`, replace `rpcDoExecuteKeyboardMacro` (lines 1080-1114):

```go
func rpcDoExecuteKeyboardMacro(ctx context.Context, macro []hidrpc.KeyboardMacroStep) error {
	logger.Debug().Interface("macro", macro).Msg("Executing keyboard macro")

	timer := time.NewTimer(0)
	if !timer.Stop() {
		<-timer.C
	}
	defer timer.Stop()

	for i, step := range macro {
		err := rpcKeyboardReport(step.Modifier, step.Keys)
		if err != nil {
			logger.Warn().Err(err).Msg("failed to execute keyboard macro")
			return err
		}

		// notify the device that the keyboard state is being cleared
		if isClearKeyStep(step) {
			gadget.UpdateKeysDown(0, keyboardClearStateKeys)
		}

		// Use context-aware sleep that can be cancelled
		delay := time.Duration(step.Delay) * time.Millisecond
		timer.Reset(delay)
		select {
		case <-timer.C:
			// Sleep completed normally
		case <-ctx.Done():
			// Drain timer if it fired between select and ctx.Done
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			// make sure keyboard state is reset
			err := rpcKeyboardReport(0, keyboardClearStateKeys)
			if err != nil {
				logger.Warn().Err(err).Msg("failed to reset keyboard state")
			}

			logger.Debug().Int("step", i).Msg("Keyboard macro cancelled during sleep")
			return ctx.Err()
		}
	}

	return nil
}
```

Key changes:
- Single `time.NewTimer` created before the loop and reused via `Reset()`
- `defer timer.Stop()` ensures cleanup
- Proper timer drain on context cancellation

- [ ] **Step 2: Verify Go compiles**

```bash
go vet ./... 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add jsonrpc.go
git commit -m "fix(backend): replace time.After with reusable timer in macro loop (fixes #ISSUE_NUM)"
```

---

### Task 7: Add Post-Macro Drain Delay

**Files:**
- Modify: `jsonrpc.go:1052` (after rpcDoExecuteKeyboardMacro call)

- [ ] **Step 1: Add drain delay**

In `jsonrpc.go`, after the `rpcDoExecuteKeyboardMacro` call (line 1052) and before the error logging, add:

```go
	err := rpcDoExecuteKeyboardMacro(ctx, macro)

	// Allow host USB stack to drain pending HID reports before signaling completion.
	// 50ms gives the host time for ~50 USB polls at 1ms intervals.
	time.Sleep(50 * time.Millisecond)

	if err != nil {
```

- [ ] **Step 2: Commit**

```bash
git add jsonrpc.go
git commit -m "fix(backend): add post-macro drain delay for host USB consumption (fixes #ISSUE_NUM)"
```

---

### Task 8: Create Pull Request

- [ ] **Step 1: Push branch**

```bash
git push -u origin fix/paste-reliability
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --repo WyrmKeep/jetkvm-reliable-paste-private \
  --title "fix: paste reliability -- 7 surgical fixes for late-stage corruption" \
  --body "$(cat <<'EOF'
## Summary

7 targeted reliability fixes for the chunked paste system, addressing bugs found during deep team analysis of late-stage paste corruption.

### Frontend fixes
- **#1 waitForPasteMacroCompletion race** -- Zustand subscribe was firing on all store changes (keysDownState updates), not just isPasteInProgress transitions. Could silently re-introduce batch overlap.
- **#2 longRunThreshold silently dropped** -- Fields were passed from PasteModal but never destructured in executePasteText. The long-run slowdown feature was a no-op.
- **#3 Error propagation** (frontend portion) -- Parse and surface macro execution errors from the backend completion signal.

### Backend fixes
- **#3 Error in completion signal** (backend portion) -- KeyboardMacroState now includes an error string so frontend can distinguish success from write failure.
- **#4 Goroutine leak** -- Buffered the onHidMessage channel (1 char fix) to prevent goroutine leak per batch.
- **#5 UpdateKeysDown guard** -- Only update internal key state after successful HID write.
- **#6 Timer reuse** -- Replace time.After with reusable timer in macro loop to eliminate GC pressure.
- **#7 Drain delay** -- 50ms post-macro delay gives host USB stack time to consume buffered input.

### Confirmed test results driving these fixes
- Pause alone does NOT fix corruption
- Clicking into target window DOES fix it immediately
- Mouse movement without click does NOT fix it
- Focus is confirmed as a factor, but these code bugs compound the problem

## Test plan
- [ ] Deploy to JetKVM device at 192.168.1.36
- [ ] Small paste (~100 chars) -- basic functionality
- [ ] Medium paste (~2000 chars) -- completion scheduling
- [ ] Large paste (~10000+ chars via file mode) -- no late-stage corruption
- [ ] Check device logs for clean macro execution (no goroutine leak warnings)
- [ ] Test both "reliable" and "fast" profiles

EOF
)"
```

- [ ] **Step 3: Return PR URL to user**
