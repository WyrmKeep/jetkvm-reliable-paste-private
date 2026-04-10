# Paste-Depth Semantics + Shallow Queue + UpdateKeysDown Guard

**Issues:** #42 (completion-waiting race), #48 (macroQueue depth 4096 → 64), #34 (UpdateKeysDown on failed write)
**Date:** 2026-04-10
**Approach:** A — Split emit with rollback-safe pre-increment (atomic `pasteDepth`, enqueuer emits `State:true`, drain/rollback/cancel-sweep all emit `State:false` on 1→0 transitions)
**Branch:** `fix/paste-depth-semantics`

## Problem

Three related correctness bugs share a single root cause — the backend emits macro completion signals at the wrong granularity and drops the `IsPaste` flag at the dispatch boundary.

### What the research verified (current `main`)

- `jsonrpc.go:1014` — `macroQueue chan []hidrpc.KeyboardMacroStep`, capacity `4096`
- `jsonrpc.go:1033-1080` — `drainMacroQueue()` hardcodes `IsPaste: true` on every `State:true`/`State:false` emission, emitted per-macro rather than per-session
- `jsonrpc.go:1109-1121` — `rpcExecuteKeyboardMacro(macro []hidrpc.KeyboardMacroStep)` takes no `isPaste` flag
- `hidrpc.go:37` — `rpcExecuteKeyboardMacro(keyboardMacroReport.Steps)` drops `keyboardMacroReport.IsPaste`
- `internal/hidrpc/message.go:101-105,192-195` — `KeyboardMacroReport.IsPaste` and `KeyboardMacroState.IsPaste` are **already** on the wire; zero wire-format change needed
- `internal/usbgadget/hid_keyboard.go:365-382` — `KeyboardReport` unconditionally calls `UpdateKeysDown(modifier, keys)` after `keyboardWriteHidFile`, even when the write errored
- `ui/src/hooks/useKeyboard.ts:107-108` — frontend already filters `if (!message.isPaste) break` before `setPasteModeEnabled`, but the filter is inert because the backend always sends `true`
- `ui/src/hooks/useKeyboard.ts:310-329` — `executeMacroRemote(steps, isPaste = false)` already accepts and passes `isPaste` to `sendKeyboardMacroEventHidRpc`
- `ui/src/hooks/useKeyboard.ts:475-508` — inline drain-wait block in `executePasteText`, resolves on timeout (silently treats "didn't hear back" as success)
- `MacroBar.tsx:41`, `VirtualKeyboard.tsx:154,161,166` — non-paste `executeMacro` callers that today spuriously toggle `isPasteInProgress` through no fault of their own, because the backend hardcodes `IsPaste: true` on state emit

### The live correctness bug

Any non-paste macro (button bindings, on-screen keyboard Ctrl+Alt+Del, custom user macros) fires `State:true, IsPaste:true` → `State:false, IsPaste:true` pairs through `drainMacroQueue`. The frontend's `setPasteModeEnabled` runs for each, toggling `isPasteInProgress`. If a paste is in flight concurrently, the paste's drain wait sees `isPasteInProgress` flip false and resolves prematurely — the paste is reported complete while macros are still queued and executing.

## Design

### Scope constraints

**Touch list (the only files changed in this PR):**
- `jsonrpc.go`
- `hidrpc.go`
- `internal/hidrpc/message.go` *(no code change expected — struct already has `IsPaste`; listed in case a helper lands here)*
- `internal/usbgadget/hid_keyboard.go`
- `ui/src/hooks/useKeyboard.ts`

**Must NOT touch (Phase 1 forbidden list):**
- `ui/src/components/popovers/PasteModal.tsx` — user-facing UI unchanged
- `ui/src/utils/pasteBatches.ts` and `ui/src/utils/pasteMacro.ts` — profile retuning is Phase 3a's scope; byte formula is Phase 3a's scope
- `internal/native/` — unrelated
- Flow control watermarks (`PASTE_LOW_WATERMARK`, `PASTE_HIGH_WATERMARK`) in `useKeyboard.ts` — #46's concern, preserved exactly

### Backend: `jsonrpc.go`

#### 1. New queue element type and named depth constant

```go
const macroQueueDepth = 64

type queuedMacro struct {
    steps   []hidrpc.KeyboardMacroStep
    isPaste bool
}

var (
    macroQueue         chan queuedMacro
    macroCurrentCancel context.CancelFunc
    macroLock          sync.Mutex
    macroQueueOnce     sync.Once
    pasteDepth         atomic.Int32
)
```

The channel carries `queuedMacro` rather than a bare `[]hidrpc.KeyboardMacroStep`, so the drain goroutine knows whether to touch `pasteDepth`.

#### 2. `rpcExecuteKeyboardMacro` — rollback-safe cancellable enqueue

```go
func rpcExecuteKeyboardMacro(ctx context.Context, steps []hidrpc.KeyboardMacroStep, isPaste bool) error {
    // Pre-increment: reserve a paste-depth slot BEFORE we attempt to enqueue.
    // Emit State:true if this is the 0→1 transition.
    if isPaste {
        if pasteDepth.Add(1) == 1 {
            emitPasteState(true)
        }
    }

    // Cancellable blocking send. If ctx is cancelled (session teardown or explicit
    // cancel) before the channel accepts the item, roll back the pasteDepth increment
    // AND emit State:false if the rollback is itself a 1→0 transition (handles the
    // case where a later enqueuer's reservation was balanced by our rollback).
    select {
    case macroQueue <- queuedMacro{steps: steps, isPaste: isPaste}:
        return nil
    case <-ctx.Done():
        if isPaste {
            if pasteDepth.Add(-1) == 0 {
                emitPasteState(false)
            }
        }
        return ctx.Err()
    }
}
```

**Where does `ctx` come from?** The existing call site at `hidrpc.go:37` runs inside `handleHidRPCMessage`, which already has a session context (the WebRTC data-channel handler is invoked per-session). The implementer will thread the same context that `handleHidRPCMessage` receives into `rpcExecuteKeyboardMacro`. If no such ctx is in scope today, fall back to `currentSession.ctx` (or equivalent) so that enqueue unblocks cleanly on session teardown. The implementation task in the plan must confirm the exact ctx source before writing code.

#### 3. `drainMacroQueue` — decrement on completion, emit on 1→0

```go
func drainMacroQueue() {
    for item := range macroQueue {
        // Preserve the full current per-macro execution body verbatim:
        // per-step timing, macroCurrentCancel ctx plumbing, error reporting,
        // and logging. The ONLY deletions from current drainMacroQueue are
        // the two hardcoded State:true/State:false emits (lines 1040-1043
        // and 1066-1072 in main). The ONLY addition is the post-run
        // pasteDepth decrement + conditional emit shown below.
        executeMacroSteps(item.steps)

        if item.isPaste {
            if pasteDepth.Add(-1) == 0 {
                emitPasteState(false)
            }
        }
    }
}
```

**Key deletions from current `drainMacroQueue`:**
- The hardcoded `State:true, IsPaste:true` emit at the start of each macro (lines 1040-1043)
- The hardcoded `State:false, IsPaste:true` emit at the end of each macro (lines 1066-1072)

Non-paste macros no longer produce state-message traffic from `drainMacroQueue` at all. The frontend filter at `useKeyboard.ts:107` already ignores non-paste state messages, so not emitting them is strictly an improvement.

**In-flight cancel semantics:** If `macroCurrentCancel()` is invoked while a paste macro is executing, `executeMacroUnderLock` returns. The post-run block still runs: `pasteDepth.Add(-1)` is executed exactly once for the cancelled in-flight item, matching the "let the drain goroutine decrement the in-flight paste item when it exits" requirement from the amendment.

#### 4. `cancelAndDrainMacroQueue` — sweep queued pastes, decrement once

```go
func cancelAndDrainMacroQueue() {
    macroLock.Lock()
    defer macroLock.Unlock()
    if macroCurrentCancel != nil {
        macroCurrentCancel()
    }

    var discardedPaste int32
    for {
        select {
        case item := <-macroQueue:
            if item.isPaste {
                discardedPaste++
            }
        default:
            goto done
        }
    }
done:
    if discardedPaste > 0 {
        if pasteDepth.Add(-discardedPaste) == 0 {
            emitPasteState(false)
        }
    }
}
```

**Why a single `Add(-discardedPaste)` rather than per-item decrement?** Semantically cleaner (one atomic observation of the transition edge), and avoids emitting `State:false` multiple times if the drain loop crosses 1→0→1→0 rapidly. The batched `Add` observes the final state in one step.

**Race interaction with concurrent enqueues:** `cancelAndDrainMacroQueue` holds `macroLock`, but `rpcExecuteKeyboardMacro` does NOT take `macroLock` — it just does `pasteDepth.Add(1)` and sends on the channel. A concurrent enqueue during cancel is fine: it bumps `pasteDepth`, lands in the now-drained queue, and drains normally after cancel returns. The atomic `pasteDepth` handles the bookkeeping correctly across all interleavings.

#### 5. `emitPasteState` — factored helper

```go
// emitPasteState centralizes state reporting. Callers must ensure they only call
// this when they hold the 0→1 or 1→0 transition (i.e., when the relevant
// pasteDepth.Add return value equals 1 or 0 respectively).
func emitPasteState(state bool) {
    if currentSession == nil {
        return
    }
    currentSession.reportHidRPCKeyboardMacroState(hidrpc.KeyboardMacroState{
        State:   state,
        IsPaste: true,
    })
}
```

Called from three sites: `rpcExecuteKeyboardMacro` (enqueue and rollback), `drainMacroQueue` (post-run decrement), `cancelAndDrainMacroQueue` (post-sweep decrement).

### Backend: `hidrpc.go:37` — preserve `IsPaste` through dispatch

```go
// BEFORE:
rpcErr = rpcExecuteKeyboardMacro(keyboardMacroReport.Steps)

// AFTER:
rpcErr = rpcExecuteKeyboardMacro(ctx, keyboardMacroReport.Steps, keyboardMacroReport.IsPaste)
```

`ctx` is the session/handler context in scope inside `handleHidRPCMessage`. If the current function signature doesn't already accept a context, the implementer threads one in (the WebRTC handler has a session context available).

### Backend: `internal/usbgadget/hid_keyboard.go:365-382` — #34 UpdateKeysDown guard

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
    u.RecordWriteResult(err)
    if err != nil {
        u.log.Warn().Uint8("modifier", modifier).Uints8("keys", keys).Msg("Could not write keyboard report to hidg0")
        return err // early return — do NOT UpdateKeysDown on failed write
    }
    u.UpdateKeysDown(modifier, keys)
    return nil
}
```

**Why early return** (vs. gated `if err == nil { UpdateKeysDown(...) }`): idiomatic Go, single happy path, no cognitive cost of re-reading the error state. Functionally identical to the gated form.

**Invariant:** after this change, `u.keysDownState` always reflects what the host actually received (modulo unobserved post-write failures further downstream, which are out of scope). A failed write leaves the internal state unchanged rather than poisoning it with keys that never reached the host.

### Frontend: `ui/src/hooks/useKeyboard.ts`

#### 1. New helper: `waitForPasteDrain`

Add a module-scoped async helper (not a React hook — it takes state via getters/subscribers, so it can be a plain function):

```typescript
type PasteDrainMode = "required" | "bestEffort";

async function waitForPasteDrain(
  mode: PasteDrainMode,
  timeoutMs: number,
  signal?: AbortSignal,
  settleMs: number = 500,
): Promise<void> {
  if (!useHidStore.getState().isPasteInProgress) {
    return;
  }
  return new Promise<void>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      unsubscribe();
      reject(new Error("Paste execution aborted"));
    };
    const unsubscribe = useHidStore.subscribe((state) => {
      if (!state.isPasteInProgress) {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        setTimeout(resolve, settleMs);
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutHandle = setTimeout(() => {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      if (mode === "required") {
        reject(new Error(`waitForPasteDrain: required drain timed out after ${timeoutMs}ms`));
      } else {
        resolve();
      }
    }, timeoutMs);
  });
}
```

- `"bestEffort"` — resolves on timeout; preserves current final-settle UX
- `"required"` — rejects on timeout; used by #38's chunk boundaries in Phase 2 (call sites added there, not here)
- Both modes preserve the existing 500ms settle delay after a clean drain signal (the current `setTimeout(resolve, 500)` in `executePasteText`)

#### 2. Replace the inline drain wait in `executePasteText`

**Current (lines ~475-508):** ~33 lines of inline promise construction with timeout/abort/subscribe bookkeeping.

**Replacement:**
```typescript
const drainTimeoutMs = Math.max(finalSettleMs, batches.length * 1000);
try {
  await waitForPasteDrain("bestEffort", drainTimeoutMs, signal);
} catch (err) {
  // bestEffort only rejects on abort, not on timeout
  throw err;
}
```

No behavioral change in Phase 1 — `"bestEffort"` resolves on timeout exactly like the current code does.

#### 3. Nothing else changes

- `isPasteInProgress` store slice: unchanged (already exists in `useHidStore`)
- Message handler at `useKeyboard.ts:106-108`: unchanged (already filters on `message.isPaste`; the filter becomes effective once the backend stops hardcoding `true`)
- `executeMacroRemote`: unchanged (already passes `isPaste`)
- Flow control watermarks, abort wiring, batch send loop: unchanged
- `buildPasteMacroBatches`, `estimateBatchBytes`, `pasteMacro.ts`: untouched (Phase 3a scope)

## Correctness invariants

### Invariant 1: depth-count honesty

At any instant,

```
pasteDepth == (count of paste items currently in macroQueue)
              + (1 if a paste item is currently executing in drain, else 0)
              + (count of paste items whose enqueuer has pre-incremented but not yet
                 successfully sent or rolled back)
```

The third term is transient and bounded: each enqueuer holds one provisional slot until the `select` resolves one way or the other. There is no path where a provisional slot leaks — every `Add(1)` is paired with either a successful send (handing ownership to the channel/drain) or an `Add(-1)` on the `ctx.Done()` branch.

### Invariant 2: balanced state transitions

`emitPasteState(true)` fires exactly when some `pasteDepth.Add(1)` returns 1.
`emitPasteState(false)` fires exactly when some `pasteDepth.Add(±n)` returns 0.

Because atomic operations are totally ordered, every 0→1 transition is followed by exactly one 1→0 transition before the next 0→1, and vice versa. Therefore, across the lifetime of the process, `emitPasteState(true)` and `emitPasteState(false)` are called in alternating order starting with `true`. The frontend sees a balanced sequence of state-open / state-close pairs.

### Invariant 3: no spurious state for non-paste macros

`drainMacroQueue` only calls `emitPasteState` for items with `item.isPaste == true`. Non-paste items (button bindings, on-screen keyboard combos, custom macros) traverse the queue, execute under the same `executeMacroUnderLock`, and produce zero state-message traffic. This fixes the live bug where `MacroBar.tsx`-triggered macros were toggling `isPasteInProgress`.

### Race scenario walkthrough

**Scenario A — clean single paste:**
1. Frontend sends paste macro M1 with `isPaste=true`
2. Enqueuer: `pasteDepth.Add(1)` → 1, emit `State:true`
3. Enqueuer: channel send succeeds, returns nil
4. Drain: dequeues M1, runs it
5. Drain: `pasteDepth.Add(-1)` → 0, emit `State:false`

Frontend sees: `State:true` → `State:false`. Balanced.

**Scenario B — overlapping pastes:**
1. Enqueuer A (paste M1): `Add(1)` → 1, emit `State:true`, send OK
2. Enqueuer B (paste M2): `Add(1)` → 2, no emit, send OK
3. Drain: runs M1, `Add(-1)` → 1, no emit
4. Drain: runs M2, `Add(-1)` → 0, emit `State:false`

Frontend sees: `State:true` → `State:false`. Balanced across both macros.

**Scenario C — non-paste macro runs concurrently with paste:**
1. Enqueuer A (paste M1): `Add(1)` → 1, emit `State:true`, send OK
2. Enqueuer B (button macro M2, `isPaste=false`): no `pasteDepth` touch, send OK
3. Drain: runs M1, `Add(-1)` → 1 (wait — this doesn't match; pasteDepth was 1, so `Add(-1)` → 0 here)

Let me retrace: step 1 leaves `pasteDepth = 1`. Step 2 doesn't touch it. Step 3 drain runs M1, `Add(-1)` → 0, emit `State:false`. Step 4 drain runs M2, no `pasteDepth` touch, no emit.

Frontend sees: `State:true` → `State:false`. The button macro produces no state traffic. Balanced, and the paste's drain wait isn't disturbed by the button macro.

**Scenario D — enqueue rollback on cancelled context:**
1. `pasteDepth = 0`
2. Enqueuer A: `Add(1)` → 1, emit `State:true`
3. Enqueuer A: channel is full, blocks on send
4. Session context cancelled
5. Enqueuer A: `select` takes `ctx.Done()` branch, `Add(-1)` → 0, emit `State:false`
6. Enqueuer A returns `ctx.Err()`

Frontend sees: `State:true` → `State:false`. Balanced. No depth leak. If the session is gone, the frontend won't receive either message, which is fine — the frontend's drain-wait rejects via the abort signal path anyway.

**Scenario E — enqueue rollback while others are still running:**
1. `pasteDepth = 0`
2. A: `Add(1)` → 1, emit `State:true`, blocks on send (queue full)
3. B: `Add(1)` → 2, also blocks
4. Drain eats a non-paste item, making room
5. B: send succeeds, returns nil (no emit — new value was 2)
6. A: ctx cancels, `Add(-1)` → 1, no emit (not 1→0)
7. B arrives at drain, runs, `Add(-1)` → 0, emit `State:false`

Frontend sees: `State:true` (from A) → `State:false` (from B's drain decrement). Balanced. No leak: A's rollback didn't emit, B's drain did.

**Scenario F — mid-paste user cancel:**
1. Pre-state: `pasteDepth = 5` (one running in drain, four queued)
2. User presses cancel, `cancelAndDrainMacroQueue` invoked
3. `macroCurrentCancel()` aborts the in-flight macro; it returns from `executeMacroUnderLock`
4. Sweep loop dequeues the four queued paste items (they run no code) and sets `discardedPaste = 4`
5. Drain goroutine's post-run block: `pasteDepth.Add(-1)` for the in-flight item
6. Cancel sweep's post-loop block: `pasteDepth.Add(-4)` for the discarded items

Steps 5 and 6 race. Both are atomic `Add`s with return-value edge detection. Exactly one of the two interleavings below occurs:

- **Sweep before drain:** `Add(-4)` returns 1 (no emit) → `Add(-1)` returns 0 (emit `State:false`) ✓
- **Drain before sweep:** `Add(-1)` returns 4 (no emit) → `Add(-4)` returns 0 (emit `State:false`) ✓

Whichever op observes the final 0 is the one that emits. No double-emit, no miss, no negative depth. Frontend sees exactly one `State:false` for the cancelled session.

**What about adversarial ordering with a new enqueue mid-cancel?**
- pre-state: `pasteDepth = 5`, 1 running + 4 queued
- Sweep: `Add(-4)` → 1
- New enqueue X: `Add(1)` → 2, emits nothing (not 0→1), starts blocking send
- Drain: `Add(-1)` → 1, does not emit
- Sweep: returns (queue was empty when it swept)
- X: send succeeds. X is now in the queue alone with `pasteDepth = 1`.
- Drain wakes up, runs X, `Add(-1)` → 0, emits `State:false`

Frontend sees: `State:true` (from A's original enqueue way before) → `State:false` (from X's drain). Balanced. No gap even across a user cancel.

But wait — X emitted no `State:true`. Is that a problem? The session was already "open" from A's earlier emit, and the frontend views this as one continuous session. Once the session closes (via X's drain decrement), it's closed. No inconsistency for the frontend.

**What if the entire paste completes during sweep and a new paste starts?**
- pre-state: `pasteDepth = 1`, the in-flight M is the last one, about to finish
- Sweep: queue empty, `discardedPaste = 0`, sweep does nothing
- Drain: `Add(-1)` → 0, emits `State:false`
- New enqueue Y: `Add(1)` → 1, emits `State:true`, sends OK

Frontend sees: `...` → `State:false` → `State:true` → (eventually) `State:false`. Two sessions, each balanced. ✓

### Invariant 4: no negative depth

Given that (a) all decrement sites check `Add(-n) == 0` rather than `<= 0`, (b) the sweep's `Add(-discardedPaste)` subtracts only items it actually dequeued, (c) `discardedPaste` is bounded by the number of paste items the sweep pulled out of the channel, and (d) the drain loop only decrements items it actually dequeued — the sum of all decrements across all paths exactly equals the sum of all successful increments. Therefore `pasteDepth` can never go negative, and the emit condition `Add returned 0` fires exactly once per completed session.

## Testing and verification

### Compile-time / static

- `cd ui && npx tsc --noEmit`
- `cd ui && npx eslint './src/**/*.{ts,tsx}'`
- `go build ./...`
- `go vet ./...`
- `go test ./...` for any package touched (usbgadget and jsonrpc if reachable by a test; the repo does not have a unit test harness for jsonrpc today so this may be a no-op)

### Runtime

Device testing is deferred until after PR review. The verification loop in Step 6 of the workflow runs only the static checks. A plan-level "smoke test" note in the PR body advises the reviewer that runtime validation (100k-char paste, button-macro concurrent with paste, cancel mid-paste) is a post-merge activity.

## Out of scope (explicit non-goals)

- Per-session paste IDs / `pasteSessionId` field on messages — #42 body defers these; not needed for depth semantics
- Chunk boundaries for large pastes (#38, Phase 2) — relies on `waitForPasteDrain("required", ...)` call sites, added in Phase 2
- Profile retuning (#40, Phase 3a) — `pasteBatches.ts` / `pasteMacro.ts` untouched
- Timer reuse in the drain loop (#43, Phase 3b) — `jsonrpc.go` timer allocations not part of this PR
- Timed-sequence HID writer (#44, Phase 4) — `hid_keyboard.go` write path not restructured; only the #34 guard lands
- Frontend vitest harness (#45, Phase 5) — no test infrastructure added
- Any backend changes outside the three functions listed in the touch list

## Open question for the implementation task

**Where does `ctx` come from at `hidrpc.go:37`?** The research report did not capture the surrounding 30 lines of `handleHidRPCMessage`. The Step 5 implementation task must verify that:

1. `handleHidRPCMessage` (or its caller) receives a context.Context bound to the session lifetime
2. That context is passed through to `rpcExecuteKeyboardMacro`
3. No existing code path relies on `rpcExecuteKeyboardMacro` being callable without a context (it should not — this is the only caller per the research)

If the current handler does not accept a context today, the implementer adds one. The plan-writing step (Step 4) will include a small subtask for this discovery.
