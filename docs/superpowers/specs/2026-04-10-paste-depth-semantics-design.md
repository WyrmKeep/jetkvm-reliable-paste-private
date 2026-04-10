# Paste-Depth Semantics + Shallow Queue + UpdateKeysDown Guard

**Issues:** #42 (completion-waiting race), #48 (macroQueue depth 4096 → 64), #34 (UpdateKeysDown on failed write)
**Date:** 2026-04-10
**Approach:** A — Split emit with rollback-safe pre-increment (atomic `pasteDepth`, enqueuer emits `State:true`, drain/rollback/cancel-sweep all emit `State:false` on 1→0 transitions). Enqueue cancellation is anchored on a macro-queue-scoped context that `cancelAndDrainMacroQueue` rotates, and every queued item carries its origin `*Session` so state messages always return to the session that started the paste.
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
- `jsonrpc.go` — `macroQueue` type + depth, `pasteDepth`, `rpcExecuteKeyboardMacro`, `drainMacroQueue`, `cancelAndDrainMacroQueue`, `emitPasteState`, enqueue-ctx plumbing
- `hidrpc.go` — `hidrpc.go:37` dispatch change (pass `session` and `IsPaste`); `onHidMessage` buffered-done-channel safety fix + keyboard-macro timeout log downgrade
- `internal/usbgadget/hid_keyboard.go` — `#34` early return on failed `keyboardWriteHidFile`
- `ui/src/hooks/useKeyboard.ts` — `waitForPasteDrain` helper; replace inline drain-wait block in `executePasteText`

`internal/hidrpc/message.go` is **read, not written** — the research confirmed `KeyboardMacroReport.IsPaste` and `KeyboardMacroState.IsPaste` are already present on both types and already marshalled over the wire. Zero change needed there.

**Must NOT touch (Phase 1 forbidden list):**
- `ui/src/components/popovers/PasteModal.tsx` — user-facing UI unchanged
- `ui/src/utils/pasteBatches.ts` and `ui/src/utils/pasteMacro.ts` — profile retuning is Phase 3a's scope; byte formula is Phase 3a's scope
- `internal/native/` — unrelated
- Flow control watermarks (`PASTE_LOW_WATERMARK`, `PASTE_HIGH_WATERMARK`) in `useKeyboard.ts` — #46's concern, preserved exactly

### Backend: `jsonrpc.go`

#### 1. New queue element type, named depth constant, and enqueue-cancel plumbing

```go
const macroQueueDepth = 64

type queuedMacro struct {
    steps   []hidrpc.KeyboardMacroStep
    isPaste bool
    session *Session // origin session — receives State:true/State:false emits
}

var (
    macroQueue         chan queuedMacro
    macroCurrentCancel context.CancelFunc // cancels the in-flight macro
    macroLock          sync.Mutex
    macroQueueOnce     sync.Once
    pasteDepth         atomic.Int32

    // Enqueue-side cancellation. Owned by the macro queue (not a session or
    // handler), and rotated by cancelAndDrainMacroQueue so that any enqueuer
    // blocked on a full macroQueue wakes up, rolls back its paste-depth
    // reservation, and returns ctx.Err() to the caller.
    macroEnqueueCtx    context.Context
    macroEnqueueCancel context.CancelFunc
    macroEnqueueMu     sync.Mutex
)

func initMacroQueue() {
    macroQueueOnce.Do(func() {
        macroQueue = make(chan queuedMacro, macroQueueDepth)
        macroEnqueueCtx, macroEnqueueCancel = context.WithCancel(context.Background())
        go drainMacroQueue()
    })
}

// currentEnqueueCtx returns the active enqueue-cancellation context under lock.
// Snapshot it once at the start of rpcExecuteKeyboardMacro so that a rotation
// during enqueue still unblocks the caller that was reading the old context.
func currentEnqueueCtx() context.Context {
    macroEnqueueMu.Lock()
    defer macroEnqueueMu.Unlock()
    return macroEnqueueCtx
}
```

The channel carries `queuedMacro` rather than a bare `[]hidrpc.KeyboardMacroStep`, so the drain goroutine knows whether to touch `pasteDepth` and which session to report state to.

**Why a queue-scoped enqueue context rather than a handler/session context?** The current `handleHidRPCMessage` does not carry a context, and `onHidMessage`'s 1-second timeout goroutine does not give the enqueuer a cancel-aware deadline. Explicit user cancel arrives as a separate HID RPC message (not via context cancellation of the enqueue caller), so a per-call or per-session context would NOT wake blocked enqueuers when the user clicks cancel. The queue owns its own cancellation, and `cancelAndDrainMacroQueue` rotates it in one atomic operation — this is the only primitive that actually wakes every currently-blocked enqueuer.

#### 2. `rpcExecuteKeyboardMacro` — rollback-safe cancellable enqueue

```go
func rpcExecuteKeyboardMacro(session *Session, steps []hidrpc.KeyboardMacroStep, isPaste bool) error {
    initMacroQueue()

    // Snapshot the current enqueue cancellation context. If cancelAndDrainMacroQueue
    // rotates the context while we're blocked on send, the snapshot we hold still
    // fires on the old Cancel and unblocks us cleanly.
    ctx := currentEnqueueCtx()

    // Pre-increment: reserve a paste-depth slot BEFORE we attempt to enqueue.
    // Emit State:true if this Add is the 0→1 transition.
    if isPaste {
        if pasteDepth.Add(1) == 1 {
            emitPasteState(session, true)
        }
    }

    // Cancellable blocking send. If the enqueue context is cancelled (user
    // pressed cancel → cancelAndDrainMacroQueue rotated the context) before
    // the channel accepts the item, roll back the pasteDepth increment and
    // emit State:false if the rollback is itself the 1→0 transition.
    select {
    case macroQueue <- queuedMacro{steps: steps, isPaste: isPaste, session: session}:
        return nil
    case <-ctx.Done():
        if isPaste {
            if pasteDepth.Add(-1) == 0 {
                emitPasteState(session, false)
            }
        }
        return ctx.Err()
    }
}
```

The signature is `(session *Session, steps, isPaste)` — no ambient context parameter. The queue owns its own cancellation and the caller only has to supply the origin session for state reporting.

#### 3. `drainMacroQueue` — decrement on completion, emit to origin session on 1→0

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
                emitPasteState(item.session, false)
            }
        }
    }
}
```

State is emitted to `item.session` — the session that originally enqueued the paste — rather than whichever global `currentSession` happens to be live at drain time. This matters when a user switches sessions (reloads the UI, reconnects) between enqueue and drain: the old session may be gone, in which case `emitPasteState` no-ops, and the frontend on the new session will reconcile state through its own fresh subscription rather than seeing cross-talk from the prior session's paste.

**Key deletions from current `drainMacroQueue`:**
- The hardcoded `State:true, IsPaste:true` emit at the start of each macro (lines 1040-1043)
- The hardcoded `State:false, IsPaste:true` emit at the end of each macro (lines 1066-1072)

Non-paste macros no longer produce state-message traffic from `drainMacroQueue` at all. The frontend filter at `useKeyboard.ts:107` already ignores non-paste state messages, so not emitting them is strictly an improvement.

**In-flight cancel semantics:** If `macroCurrentCancel()` is invoked while a paste macro is executing, `executeMacroUnderLock` returns. The post-run block still runs: `pasteDepth.Add(-1)` is executed exactly once for the cancelled in-flight item, matching the "let the drain goroutine decrement the in-flight paste item when it exits" requirement from the amendment.

#### 4. `cancelAndDrainMacroQueue` — rotate enqueue ctx, sweep queued pastes, decrement once

```go
func cancelAndDrainMacroQueue() {
    macroLock.Lock()
    defer macroLock.Unlock()

    // Step 1: Rotate the enqueue context. Cancel the current one to wake any
    // enqueuers blocked on macroQueue send; install a fresh context for future
    // enqueues. This is the ONLY primitive that actually unblocks pending
    // enqueuers — waking them up lets them roll back their paste-depth
    // reservation cleanly and return ctx.Err() to their callers, so the
    // frontend's paste attempt fails fast instead of hanging.
    macroEnqueueMu.Lock()
    if macroEnqueueCancel != nil {
        macroEnqueueCancel()
    }
    macroEnqueueCtx, macroEnqueueCancel = context.WithCancel(context.Background())
    macroEnqueueMu.Unlock()

    // Step 2: Cancel the in-flight macro (if any). drainMacroQueue's post-run
    // block will decrement pasteDepth and emit State:false if that decrement
    // is the 1→0 transition.
    if macroCurrentCancel != nil {
        macroCurrentCancel()
    }

    // Step 3: Sweep any remaining items out of the channel without running
    // them. Track the last paste session we saw so that if our sweep closes
    // the paste session (1→0), we emit State:false to the right session.
    var discardedPaste int32
    var lastPasteSession *Session
    draining := true
    for draining {
        select {
        case item := <-macroQueue:
            if item.isPaste {
                discardedPaste++
                lastPasteSession = item.session
            }
        default:
            draining = false
        }
    }

    if discardedPaste > 0 {
        if pasteDepth.Add(-discardedPaste) == 0 {
            emitPasteState(lastPasteSession, false)
        }
    }
}
```

**Why a single `Add(-discardedPaste)` rather than per-item decrement?** Semantically cleaner (one atomic observation of the transition edge), and avoids emitting `State:false` multiple times if the drain loop crosses 1→0→1→0 rapidly. The batched `Add` observes the final state in one step.

**Which session does the sweep emit to?** All paste items from a single `executePasteText` call are enqueued by the same WebRTC session's handler, so they all carry the same `*Session`. Using the last-seen one during the sweep is sufficient: if the sweep discards any paste items at all, they belong to the same session, and that session receives the `State:false`. If the sweep discards zero paste items, no emit is needed (either there was no paste or the drain goroutine's own decrement handles the transition).

**Race interaction with concurrent enqueues:** `cancelAndDrainMacroQueue` holds `macroLock`, but `rpcExecuteKeyboardMacro` does NOT take `macroLock` — it snapshots the enqueue context, does `pasteDepth.Add(1)`, and attempts to send on the channel. A concurrent enqueue during cancel resolves one of two ways:
- If the enqueuer already captured the **old** enqueue context, the rotation fires `Done()` on it and the enqueuer rolls back via the `ctx.Done()` branch of `select`.
- If the enqueuer captures the **new** enqueue context (after the rotation), it enqueues into the now-drained queue normally and its item runs on the next drain pass.

Either way, the atomic `pasteDepth` stays honest and no leaks occur.

#### 5. `emitPasteState` — factored helper, session-scoped

```go
// emitPasteState centralizes state reporting. Callers must ensure they only call
// this on the 0→1 or 1→0 transition (i.e., when the relevant pasteDepth.Add
// return value equals 1 or 0 respectively). The session parameter is the
// origin session — the one that enqueued the paste — so state messages are
// always delivered to the session that is waiting for them.
func emitPasteState(session *Session, state bool) {
    if session == nil {
        return
    }
    session.reportHidRPCKeyboardMacroState(hidrpc.KeyboardMacroState{
        State:   state,
        IsPaste: true,
    })
}
```

Called from four sites, each passing the correct session:
- `rpcExecuteKeyboardMacro` enqueue path: `emitPasteState(session, true)` — the caller's session
- `rpcExecuteKeyboardMacro` rollback path: `emitPasteState(session, false)` — the caller's session
- `drainMacroQueue` post-run: `emitPasteState(item.session, false)` — the session snapshotted at enqueue
- `cancelAndDrainMacroQueue` sweep: `emitPasteState(lastPasteSession, false)` — the session of the last paste item swept

If the origin session has been torn down (user reconnected, browser closed), `emitPasteState` silently no-ops. The frontend on the new session reconciles its state through its own fresh subscription.

### Backend: `hidrpc.go:37` — preserve `IsPaste` and pass origin session

```go
// BEFORE:
rpcErr = rpcExecuteKeyboardMacro(keyboardMacroReport.Steps)

// AFTER:
rpcErr = rpcExecuteKeyboardMacro(session, keyboardMacroReport.Steps, keyboardMacroReport.IsPaste)
```

`session` is the `*Session` receiver / parameter of the enclosing handler. The implementation task must verify how `session` is reachable from the current `handleHidRPCMessage` (it is the WebRTC data-channel handler's owning session — the implementer reads the function signature and adjusts). No ambient `context.Context` is threaded through; enqueue cancellation is owned by the macro queue itself, not by this handler.

### Backend: `hidrpc.go` `onHidMessage` — unblock the 1-second timeout worker

The approved pipeline spec assumed `onHidMessage` stayed under its 1-second handler timeout because enqueue returned promptly. Shrinking `macroQueue` from 4096 to 64 combined with blocking-enqueue-as-backpressure invalidates that assumption: a busy host can easily keep the queue full for longer than 1 second, and the handler's timeout can race the worker.

**Current shape (as understood from the research) and the bug:**

```go
// Roughly:
done := make(chan error) // unbuffered
go func() {
    done <- handleHidRPCMessage(message) // may block >1s waiting for queue
}()
select {
case err := <-done:
    // fast path
case <-time.After(1 * time.Second):
    logger.Warn().Msg("HID RPC handler timed out")
    // worker is still running; it will eventually try to send to `done`,
    // but nobody is reading → worker goroutine leaks indefinitely
}
```

**Fix — buffered completion channel:**

```go
done := make(chan error, 1) // buffered so the worker's send never blocks
go func() {
    done <- handleHidRPCMessage(message)
}()
select {
case err := <-done:
    // normal completion
case <-time.After(1 * time.Second):
    // Downgrade the timeout log for keyboard-macro messages: with blocking
    // backpressure the timeout is now an expected, benign signal that the
    // backend is absorbing flow control, not a fault.
    if message.Type() == hidrpc.TypeKeyboardMacroReport {
        logger.Debug().Msg("HID RPC keyboard-macro enqueue took >1s (backpressure)")
    } else {
        logger.Warn().Msg("HID RPC handler timed out")
    }
    // Worker finishes later and sends into the buffered channel with no
    // blocker; the send is a no-op from the handler's perspective.
}
```

**Exact current structure of `onHidMessage` is not in the research report.** The implementation task verifies the actual pattern and applies the minimum-delta fix (buffered channel for the completion signal; downgrade the timeout log for `TypeKeyboardMacroReport` specifically). If the current implementation already uses a close-based pattern or `sync.Once`-protected send, the implementer chooses the form that matches existing style — the requirement is simply that the worker cannot block forever on a dropped done channel.

**Why this is in scope for Phase 1:** the 4096 → 64 queue change in the same PR creates the conditions for this timeout to fire routinely. Shipping one without the other would risk a measurable goroutine-leak regression as soon as a user starts pasting large text.

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

#### 1. New helper: `waitForPasteDrain` — subscribe-first with arm window

The naive "fast-return if `!isPasteInProgress`" fast-path has a late-start race: `executePasteText` finishes its send loop before backend `State:true` has arrived, the store still reads `false`, the helper returns immediately, and the caller reports success while the paste is actually still queued and running. The fix is to subscribe first and only return early if the store stayed false throughout a short **arm window** — giving backend `State:true` a chance to land before we start deciding whether the paste is "in progress".

Add a module-scoped async helper (not a React hook — it takes state via getters/subscribers, so it can be a plain function):

```typescript
type PasteDrainMode = "required" | "bestEffort";

const DEFAULT_ARM_WINDOW_MS = 200;
const DEFAULT_SETTLE_MS = 500;

async function waitForPasteDrain(
  mode: PasteDrainMode,
  timeoutMs: number,
  signal?: AbortSignal,
  settleMs: number = DEFAULT_SETTLE_MS,
  armWindowMs: number = DEFAULT_ARM_WINDOW_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let armHandle: ReturnType<typeof setTimeout> | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (armHandle) clearTimeout(armHandle);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    };
    const resolveClean = () => {
      if (done) return;
      done = true;
      cleanup();
      setTimeout(resolve, settleMs); // observed drain → host USB settle
    };
    const resolveImmediate = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(); // no drain observed → no settle needed
    };
    const rejectErr = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };
    const onAbort = () => rejectErr(new Error("Paste execution aborted"));

    // Subscribe FIRST so we never miss a State:true that arrives between
    // now and the arm-window check.
    const unsubscribe = useHidStore.subscribe((state) => {
      if (!state.isPasteInProgress) {
        resolveClean();
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });

    timeoutHandle = setTimeout(() => {
      if (mode === "required") {
        rejectErr(
          new Error(`waitForPasteDrain: required drain timed out after ${timeoutMs}ms`),
        );
      } else {
        resolveImmediate(); // bestEffort: treat timeout as success, no settle
      }
    }, timeoutMs);

    // Arm window — only in bestEffort mode. If isPasteInProgress is still
    // false after armWindowMs, assume the paste never materialized (zero
    // batches, immediate error, send loop that did nothing) and resolve
    // without waiting for the full timeout. In required mode the caller
    // is asserting "a paste is in progress or about to start" so we wait
    // the full timeout budget and reject if nothing drains.
    if (mode === "bestEffort" && !useHidStore.getState().isPasteInProgress) {
      armHandle = setTimeout(() => {
        armHandle = undefined;
        if (!useHidStore.getState().isPasteInProgress) {
          resolveImmediate();
        }
        // else: a State:true arrived during the arm window; the subscription
        // will fire when the matching State:false lands.
      }, armWindowMs);
    }
  });
}
```

- **`"bestEffort"`** — resolves on timeout or on an unarmed arm window; preserves current final-settle UX. Used by Phase 1's final-drain call site in `executePasteText`.
- **`"required"`** — rejects on timeout; never takes the arm-window fast path. Reserved for #38's chunk boundaries in Phase 2. **No `"required"` call sites are added in Phase 1.**
- Settle delay (`500ms`) only runs on **observed** clean drain. Timeout and arm-window early return skip the settle (there is nothing to settle for).

**Why subscribe before the arm window?** The subscription is cheap (a Zustand listener) and catches any `State:true` that arrives between the helper's entry and the arm-window resolution. If `State:true` lands during the arm window, the subscription sees it, notes `isPasteInProgress=true` (doesn't resolve), and the arm-window callback sees the non-false state and defers to the subscription. If `State:true` never lands, the arm window resolves. Either way, no paste session is silently dropped.

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
1. Enqueuer A (paste M1, `isPaste=true`): `Add(1)` → 1, emit `State:true`, send OK
2. Enqueuer B (button macro M2, `isPaste=false`): no `pasteDepth` touch, send OK
3. Drain: runs M1, `Add(-1)` → 0, emit `State:false`
4. Drain: runs M2, no `pasteDepth` touch, no emit

Frontend sees: `State:true` → `State:false`. The button macro produces no state traffic. Balanced, and the paste's drain wait isn't disturbed by the button macro — fixing the live bug reported in #42.

**Scenario D — enqueue rollback on rotated enqueue context (user cancel):**
1. `pasteDepth = 0`
2. Enqueuer A: snapshots `macroEnqueueCtx` → `ctxA`
3. Enqueuer A: `Add(1)` → 1, emit `State:true` to A's session
4. Enqueuer A: channel is full, blocks on send against `ctxA.Done()`
5. User presses cancel → `cancelAndDrainMacroQueue` cancels `ctxA` and installs a fresh `macroEnqueueCtx`
6. Enqueuer A: `select` takes `ctxA.Done()` branch, `Add(-1)` → 0, emit `State:false` to A's session
7. Enqueuer A returns `ctxA.Err()` to its caller

Frontend sees: `State:true` → `State:false`. Balanced. No depth leak. The frontend's drain-wait will resolve (observed drain) or time out (bestEffort) — either way the user's cancel translates into a clean paste-session close.

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

**Scenario G — new paste begins after sweep completes:**
1. Pre-state: `pasteDepth = 1`, the in-flight macro is the last one of the current session
2. Sweep runs (queue empty, `discardedPaste = 0`, no emit)
3. Drain: `Add(-1)` → 0, emit `State:false`
4. New enqueue Y: snapshots the **fresh** enqueue ctx, `Add(1)` → 1, emits `State:true`, sends OK

Frontend sees: `State:false` (closing the cancelled session) → `State:true` (opening the new paste) → eventually `State:false` (closing the new paste). Two sessions, each balanced. The fresh enqueue ctx guarantees that Y cannot be unblocked by the previous cancel — only a future `cancelAndDrainMacroQueue` can cancel Y.

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

Device testing is deferred until after PR review. The verification loop in Step 6 of the workflow runs only the static checks. A plan-level "smoke test" note in the PR body advises the reviewer that the following runtime scenarios are post-merge validation:

- 100k-char paste in both `reliable` and `fast` profiles — verify no stalls, no stuck `isPasteInProgress`
- Button macro (e.g., from `MacroBar.tsx`) fired concurrently with a paste — verify paste drain wait does not resolve prematurely
- Cancel mid-paste with a queue ≥32 items deep — verify blocked enqueuers wake and return errors, `State:false` fires exactly once, no goroutine leak (check `goroutine` count before/after with a debug endpoint if available)
- `onHidMessage` 1-second timeout fires on a very busy host — verify no logs flood in `Warn` (should be `Debug` for keyboard-macro) and no goroutine leak
- Failed HID write (simulatable by unplugging the USB gadget mid-paste, if practical) — verify `keysDownState` is not poisoned; a subsequent working keypress is reported correctly

## Out of scope (explicit non-goals)

- Per-session paste IDs / `pasteSessionId` field on messages — #42 body defers these; not needed for depth semantics. (See the "Known protocol limitation" section below for what this defers.)
- Chunk boundaries for large pastes (#38, Phase 2) — `waitForPasteDrain("required", ...)` call sites are added in Phase 2, not here; `"required"` ships in Phase 1 with zero call sites
- Profile retuning (#40, Phase 3a) — `pasteBatches.ts` / `pasteMacro.ts` untouched
- Timer reuse in the drain loop (#43, Phase 3b) — `jsonrpc.go` timer allocations not optimized in this PR
- Timed-sequence HID writer (#44, Phase 4) — `hid_keyboard.go` write path not restructured; only the #34 early-return guard lands
- Frontend vitest harness (#45, Phase 5) — no test infrastructure added
- Any backend changes outside the functions listed in the touch list above

## Known protocol limitation: trailing batches after cancel

**This is a documented limitation, not a bug to fix in Phase 1.**

Explicit paste cancel is best-effort for batches the browser has already sent over the WebRTC data channel but the backend has not yet consumed into `macroQueue`. A trailing batch can arrive at the backend *after* `cancelAndDrainMacroQueue` has run, and because there is no wire-level paste-session identity (no `pasteSessionId` field on `KeyboardMacroReport`), the backend cannot distinguish "a trailing batch from the cancelled paste" from "the first batch of a new paste the user just started". The backend treats any arriving paste macro as a live paste and processes it.

Concretely, after a user cancel the following sequence can occur:
1. Frontend send loop finishes sending batches 1..N to the WebRTC data channel
2. User clicks cancel; frontend's `AbortSignal` fires, `executePasteText` returns
3. `cancelAndDrainMacroQueue` runs on the backend, rotates the enqueue ctx, cancels the in-flight macro, sweeps the queue, emits `State:false`
4. Batches N-3..N (still in flight over SCTP, not yet consumed by the HID RPC handler) arrive
5. Backend re-enters paste mode for these trailing batches: `pasteDepth` goes 0→1→...→0 again, `State:true` then `State:false` fire
6. Host sees a short burst of keystrokes after the user clicked cancel

Paste-depth semantics fix the **internal state race** (backend and frontend agree on "are we in a paste"), but they cannot fix **stale post-cancel traffic** without adding wire-level paste identity. That is explicitly deferred to a future session-ID phase.

**QA note:** a trailing burst of keystrokes after cancel, on the order of one or two batches, is an expected protocol limitation — not evidence that paste-depth accounting is broken. Reproducing it requires a large paste in fast profile so there are enough in-flight SCTP frames to outlive the cancel round-trip.
