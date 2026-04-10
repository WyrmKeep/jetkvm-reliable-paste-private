# Paste-Depth Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 1 paste reliability fixes in one PR: paste-depth semantics with rollback-safe cancellable enqueue (#42), shallow 64-slot macro queue (#48), `UpdateKeysDown` guard on failed HID writes (#34), `onHidMessage` goroutine-leak safety for the new shallow queue, and a frontend `waitForPasteDrain` helper with a subscribe-first arm window that eliminates the late-start race.

**Architecture:** Backend owns its own enqueue cancellation context, rotated by `cancelAndDrainMacroQueue` so blocked enqueuers wake cleanly on user cancel. Every queued item carries its origin `*Session` so state messages return to the session that started the paste, not whichever global `currentSession` happens to be live. State transitions (`State:true` / `State:false`) fire exactly on atomic `pasteDepth` 0↔1 edges, emitted from four sites (enqueue, rollback, drain post-run, cancel sweep). Non-paste macros bypass all paste-depth plumbing entirely.

**Tech Stack:** Go 1.24, TypeScript 5 / React 18, Zustand store, WebRTC data channel for backend↔frontend HID RPC.

**Spec:** `docs/superpowers/specs/2026-04-10-paste-depth-semantics-design.md` — required reading before starting any task.

**Branch:** `fix/paste-depth-semantics` (already cut from `main`; spec already committed).

## Scope and verification constraints

**Touch list (the ONLY files this plan modifies):**
- `jsonrpc.go`
- `hidrpc.go`
- `internal/usbgadget/hid_keyboard.go`
- `ui/src/hooks/useKeyboard.ts`

**Forbidden files (do NOT touch in any task):**
- `ui/src/components/popovers/PasteModal.tsx` — user-facing UI unchanged
- `ui/src/utils/pasteBatches.ts` — Phase 3a scope
- `ui/src/utils/pasteMacro.ts` — Phase 3a scope (`estimateBatchBytes` is IMPORTED here but not modified)
- `internal/native/` — unrelated subsystem
- `internal/hidrpc/message.go` — `KeyboardMacroReport.IsPaste` and `KeyboardMacroState.IsPaste` are already on the wire; no wire format change needed
- The `PASTE_LOW_WATERMARK` / `PASTE_HIGH_WATERMARK` constants and `bufferedAmount` flow control in `useKeyboard.ts` — #46's concern, preserve exactly
- `ui/package.json`, `go.mod` — no dependency changes in Phase 1

**Verification model (no unit test framework in this repo):**
- Frontend: `cd ui && npx tsc --noEmit` and `cd ui && npx eslint './src/**/*.{ts,tsx}'`
- Backend: `go build ./...` and `go vet ./...`
- `go test ./...` runs the existing Go test suite; `jsonrpc.go`, `hidrpc.go`, and `internal/usbgadget/` do not currently ship with unit tests, so `go test` is a build-and-vet gate for those packages (it should still pass — no regressions in tests that do exist)
- Runtime device testing is POST-merge per CLAUDE.md; do not try to run the debug binary from the plan

**Commit convention:** `type(scope): description (#N)` where `type ∈ {fix, feat, refactor, perf, docs, test}` and `scope ∈ {paste, usb, hid, ui}`. Every commit ends with:

```
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

**Never use `--no-verify`, `--amend`, or force-push.** If a hook fails, fix the underlying issue and create a new commit. Commits are one per plan task, not one per sub-step.

## Verified facts (grepped against current `main`)

These were confirmed by reading the files directly and are used throughout the plan:

- `type Session struct` is declared at `webrtc.go:25`. It is exported from package `kvm`. Use `*Session` freely within the package.
- `reportHidRPCKeyboardMacroState` is a method on `*Session` at `hidrpc.go:255`. Signature: `func (s *Session) reportHidRPCKeyboardMacroState(state hidrpc.KeyboardMacroState)`. No return value.
- `handleHidRPCMessage` at `hidrpc.go:14` already accepts `session *Session` as its second parameter. `session` is in scope at line 37 where `rpcExecuteKeyboardMacro` is called — no signature change needed for `handleHidRPCMessage`.
- `onHidMessage` at `hidrpc.go:66` uses an **unbuffered** completion channel (`r := make(chan interface{})`) and a 1-second `time.After` timeout. This is the goroutine leak path.
- `startMacroQueue` (not `initMacroQueue`) is the existing init helper at `jsonrpc.go:1024`. Reuse this name.
- `rpcDoExecuteKeyboardMacro(ctx context.Context, macro []hidrpc.KeyboardMacroStep) error` at `jsonrpc.go:1134` is the per-macro executor. `drainMacroQueue` calls it with a per-macro `context.WithCancel`. **Do not touch `rpcDoExecuteKeyboardMacro` itself** — only its caller.
- Go version is `1.24.4` per `go.mod`. `sync/atomic.Int32` is available (added in 1.19).
- `keyboardMacroSequence atomic.Uint64` exists at `jsonrpc.go:1128` and is used for macro ID logging. Preserve its use in the rewritten functions.
- Current drain loop has a `time.Sleep(200 * time.Millisecond)` inter-macro drain delay at `jsonrpc.go:1078`. **This is the fix from PR #41 — preserve it verbatim.**
- Current `cancelAndDrainMacroQueue` does NOT hold `macroLock` during its drain loop. It takes `macroLock` briefly only to cancel the current macro, then releases it before sweeping the channel. Preserve this pattern.

---

## Task 1: Backend — paste-depth semantics + queue reshape + dispatch update

**Files:**
- Modify: `jsonrpc.go` (lines 1011–1121 — the entire macro queue section)
- Modify: `hidrpc.go:37` (the `rpcExecuteKeyboardMacro` call site in `handleHidRPCMessage`)

**Why these are combined into one task:** `rpcExecuteKeyboardMacro`'s signature changes from `(steps)` to `(session, steps, isPaste)`. Its only caller is `hidrpc.go:37`. Splitting would produce an intermediate commit where the package does not build. One task = one commit = one compile-clean state.

**Scope lock for this task:**
- ✅ Modify `jsonrpc.go` only in the macro queue region (lines ~1011–1126). Do not touch `rpcDoExecuteKeyboardMacro` at line 1134.
- ✅ Modify `hidrpc.go` only at line 37 (the macro dispatch).
- ❌ Do NOT touch `hidrpc.go:66` (`onHidMessage`) in this task — that is Task 2.
- ❌ Do NOT touch any frontend file.
- ❌ Do NOT remove the 200ms inter-macro sleep at the end of `drainMacroQueue`.

### Steps

- [ ] **Step 1.1: Read the current macro queue section**

Run:
```
Read jsonrpc.go lines 1011-1126
```

Confirm: the variable block at 1011-1020, `startMacroQueue` at 1022-1028, `drainMacroQueue` at 1031-1080, `cancelAndDrainMacroQueue` at 1082-1107, `rpcExecuteKeyboardMacro` at 1109-1121, `rpcCancelKeyboardMacro` at 1123-1125. Note any line drift from these anchors before editing.

- [ ] **Step 1.2: Confirm `atomic` import is already present**

Run:
```
Grep in jsonrpc.go imports for "sync/atomic"
```

Expected: already imported (used by `keyboardMacroSequence atomic.Uint64` at line 1128). If not present, add it in the imports block.

- [ ] **Step 1.3: Replace the var block, add const, struct, and helpers**

Find in `jsonrpc.go` (approximately lines 1011–1028):

```go
var (
	// macroQueue is the channel-based FIFO for keyboard macro batches.
	// The drain goroutine is the sole consumer; rpcExecuteKeyboardMacro is the producer.
	macroQueue chan []hidrpc.KeyboardMacroStep

	// macroCurrentCancel cancels the currently executing macro in the drain goroutine.
	macroCurrentCancel context.CancelFunc
	macroLock          sync.Mutex
	macroQueueOnce     sync.Once
)

// startMacroQueue creates the macro queue channel and starts the drain goroutine.
// Called when the first WebRTC session is established.
func startMacroQueue() {
	macroQueueOnce.Do(func() {
		macroQueue = make(chan []hidrpc.KeyboardMacroStep, 4096)
		go drainMacroQueue()
	})
}
```

Replace with:

```go
// macroQueueDepth is the buffered capacity of macroQueue. Keep this shallow so
// the frontend's bufferedAmount flow control provides real backpressure — a
// deep queue hides the sender's view of how far behind the backend has fallen.
// See docs/superpowers/specs/2026-04-08-paste-pipeline-flow-control-design.md.
const macroQueueDepth = 64

// queuedMacro wraps a macro batch with its paste flag and origin session so
// drainMacroQueue and cancelAndDrainMacroQueue can report state messages back
// to the session that enqueued the paste, not whichever global currentSession
// happens to be live when the edge fires.
type queuedMacro struct {
	steps   []hidrpc.KeyboardMacroStep
	isPaste bool
	session *Session
}

var (
	// macroQueue is the channel-based FIFO for keyboard macro batches.
	// The drain goroutine is the sole consumer; rpcExecuteKeyboardMacro is the producer.
	macroQueue chan queuedMacro

	// macroCurrentCancel cancels the currently executing macro in the drain goroutine.
	macroCurrentCancel context.CancelFunc
	macroLock          sync.Mutex
	macroQueueOnce     sync.Once

	// pasteDepth is the atomic count of accepted/executing paste macros.
	// Incremented by rpcExecuteKeyboardMacro before the blocking channel send,
	// decremented by drainMacroQueue after each paste macro finishes, by
	// rpcExecuteKeyboardMacro's rollback branch on cancelled enqueue, and by
	// cancelAndDrainMacroQueue for each paste macro swept out of the queue.
	// State:true emits on the 0→1 transition; State:false emits on the 1→0
	// transition. Non-paste macros never touch this counter.
	pasteDepth atomic.Int32

	// macroEnqueueCtx is the cancellation context for blocking enqueues.
	// It is owned by the macro queue (not by any handler or session) and is
	// rotated by cancelAndDrainMacroQueue so that enqueuers blocked on a full
	// macroQueue wake up, roll back their paste-depth reservation, and return
	// ctx.Err() to the caller.
	macroEnqueueCtx    context.Context
	macroEnqueueCancel context.CancelFunc
	macroEnqueueMu     sync.Mutex
)

// startMacroQueue creates the macro queue channel, the enqueue cancellation
// context, and starts the drain goroutine. Idempotent — safe to call from
// every rpcExecuteKeyboardMacro invocation.
func startMacroQueue() {
	macroQueueOnce.Do(func() {
		macroQueue = make(chan queuedMacro, macroQueueDepth)
		macroEnqueueCtx, macroEnqueueCancel = context.WithCancel(context.Background())
		go drainMacroQueue()
	})
}

// currentEnqueueCtx returns the active enqueue cancellation context under
// lock. Enqueuers snapshot this once at entry; if cancelAndDrainMacroQueue
// rotates the context while they're blocked on send, the snapshot they hold
// still fires on the old Cancel and unblocks them cleanly.
func currentEnqueueCtx() context.Context {
	macroEnqueueMu.Lock()
	defer macroEnqueueMu.Unlock()
	return macroEnqueueCtx
}

// emitPasteState reports a paste-session state transition to the origin
// session. Callers must only invoke this on the 0→1 or 1→0 transition
// (i.e., when the relevant pasteDepth.Add return value equals 1 or 0
// respectively). If the session is nil (origin session torn down between
// enqueue and drain), this silently no-ops — the frontend on the new
// session will reconcile state through its own fresh subscription.
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

- [ ] **Step 1.4: Replace `drainMacroQueue` — remove hardcoded emits, add paste-depth decrement**

Find in `jsonrpc.go` (approximately lines 1031–1080):

```go
// drainMacroQueue is the sole consumer of macroQueue. It executes each macro
// sequentially and reports completion state to the frontend after each one.
func drainMacroQueue() {
	for macro := range macroQueue {
		macroID := keyboardMacroSequence.Add(1)
		logger.Info().Uint64("macro_id", macroID).Int("step_count", len(macro)).Msg("executing queued keyboard macro")

		// Report macro start (frontend uses this for isPasteInProgress)
		if currentSession != nil {
			currentSession.reportHidRPCKeyboardMacroState(hidrpc.KeyboardMacroState{
				State:   true,
				IsPaste: true,
			})
		}

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

		// Inter-macro drain delay: gives the host USB stack time to process
		// buffered HID reports before the next macro arrives. Without this,
		// back-to-back macros overflow the host's USB input queue, causing
		// character corruption on busy systems.
		time.Sleep(200 * time.Millisecond)
	}
}
```

Replace with:

```go
// drainMacroQueue is the sole consumer of macroQueue. It executes each macro
// sequentially. Paste-session state transitions (State:true / State:false) are
// emitted on atomic pasteDepth 0↔1 edges, not per macro — see rpcExecuteKeyboardMacro
// for the 0→1 emit and the post-run block below for the 1→0 emit.
func drainMacroQueue() {
	for item := range macroQueue {
		macroID := keyboardMacroSequence.Add(1)
		logger.Info().
			Uint64("macro_id", macroID).
			Int("step_count", len(item.steps)).
			Bool("is_paste", item.isPaste).
			Msg("executing queued keyboard macro")

		ctx, cancel := context.WithCancel(context.Background())

		macroLock.Lock()
		macroCurrentCancel = cancel
		macroLock.Unlock()

		err := rpcDoExecuteKeyboardMacro(ctx, item.steps)
		if err != nil {
			logger.Warn().Uint64("macro_id", macroID).Err(err).Msg("queued keyboard macro failed")
		} else {
			logger.Info().Uint64("macro_id", macroID).Msg("queued keyboard macro completed")
		}

		macroLock.Lock()
		macroCurrentCancel = nil
		macroLock.Unlock()

		cancel()

		// Paste-depth decrement + conditional emit on the 1→0 transition.
		// Non-paste macros never touch pasteDepth or emit state.
		if item.isPaste {
			if pasteDepth.Add(-1) == 0 {
				logger.Debug().Uint64("macro_id", macroID).Msg("paste-depth 1->0 (drain complete)")
				emitPasteState(item.session, false)
			}
		}

		// Inter-macro drain delay: gives the host USB stack time to process
		// buffered HID reports before the next macro arrives. Without this,
		// back-to-back macros overflow the host's USB input queue, causing
		// character corruption on busy systems.
		time.Sleep(200 * time.Millisecond)
	}
}
```

Key deletions verified: the `State:true` emit block (old lines 1039–1044) and the `State:false` emit block (old lines 1065–1072) are both removed. Everything else — logging, `macroCurrentCancel` plumbing, ctx cancel, 200ms sleep — is preserved verbatim. The only additions are the new `Bool("is_paste", ...)` log field and the post-run decrement block.

- [ ] **Step 1.5: Replace `cancelAndDrainMacroQueue` — rotate enqueue ctx, sweep with session tracking**

Find in `jsonrpc.go` (approximately lines 1082–1107):

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

Replace with:

```go
// cancelAndDrainMacroQueue cancels the currently executing macro, wakes any
// enqueuers blocked on a full macroQueue, and discards all queued macros.
// Called on session teardown, session takeover, and explicit cancel.
//
// The steps run in order: (1) rotate the enqueue context so blocked enqueuers
// wake and roll back cleanly, (2) cancel the in-flight macro so drainMacroQueue
// returns from rpcDoExecuteKeyboardMacro and hits its post-run decrement
// block, (3) sweep the channel and atomically subtract the discarded paste
// count from pasteDepth, emitting State:false on a 1→0 transition.
func cancelAndDrainMacroQueue() {
	// Step 1: Rotate the enqueue context. Cancel the current one to wake any
	// enqueuers blocked on macroQueue send; install a fresh context for future
	// enqueues.
	macroEnqueueMu.Lock()
	if macroEnqueueCancel != nil {
		macroEnqueueCancel()
	}
	macroEnqueueCtx, macroEnqueueCancel = context.WithCancel(context.Background())
	macroEnqueueMu.Unlock()

	// Step 2: Cancel the in-flight macro (if any). drainMacroQueue's post-run
	// block will decrement pasteDepth and emit State:false if that decrement is
	// the 1→0 transition.
	macroLock.Lock()
	if macroCurrentCancel != nil {
		macroCurrentCancel()
		logger.Info().Msg("canceled current keyboard macro")
	}
	macroLock.Unlock()

	// Step 3: Sweep any remaining items out of the channel without running them.
	// Track the session of the last paste item we saw so that if our sweep closes
	// the paste session (1→0), we emit State:false to the right session.
	if macroQueue == nil {
		return
	}
	var discardedTotal int
	var discardedPaste int32
	var lastPasteSession *Session
	draining := true
	for draining {
		select {
		case item := <-macroQueue:
			discardedTotal++
			if item.isPaste {
				discardedPaste++
				lastPasteSession = item.session
			}
		default:
			draining = false
		}
	}
	if discardedTotal > 0 {
		logger.Info().Int("count", discardedTotal).Msg("drained queued keyboard macros")
	}
	if discardedPaste > 0 {
		logger.Debug().Int32("discarded_paste", discardedPaste).Msg("cancel sweep discarded paste macros")
		if pasteDepth.Add(-discardedPaste) == 0 {
			logger.Debug().Msg("paste-depth 1->0 (cancel sweep)")
			emitPasteState(lastPasteSession, false)
		}
	}
}
```

- [ ] **Step 1.6: Replace `rpcExecuteKeyboardMacro` — new signature, rollback-safe enqueue**

Find in `jsonrpc.go` (approximately lines 1109–1121):

```go
func rpcExecuteKeyboardMacro(macro []hidrpc.KeyboardMacroStep) error {
	macroID := keyboardMacroSequence.Add(1)
	logger.Info().Uint64("macro_id", macroID).Int("step_count", len(macro)).Msg("enqueuing keyboard macro")

	// Ensure queue is started (idempotent)
	startMacroQueue()

	// Blocking enqueue. If the channel is full (4096 batches), this blocks
	// until the drain goroutine frees a slot, creating backpressure through
	// the SCTP stack to the frontend's bufferedAmount flow control.
	macroQueue <- macro
	return nil
}
```

Replace with:

```go
func rpcExecuteKeyboardMacro(session *Session, steps []hidrpc.KeyboardMacroStep, isPaste bool) error {
	macroID := keyboardMacroSequence.Add(1)
	logger.Info().
		Uint64("macro_id", macroID).
		Int("step_count", len(steps)).
		Bool("is_paste", isPaste).
		Msg("enqueuing keyboard macro")

	// Ensure queue is started (idempotent)
	startMacroQueue()

	// Snapshot the current enqueue cancellation context. If
	// cancelAndDrainMacroQueue rotates the context while we're blocked on
	// send, the snapshot we hold still fires on the old Cancel and unblocks
	// us cleanly.
	ctx := currentEnqueueCtx()

	// Pre-increment: reserve a paste-depth slot BEFORE we attempt to enqueue.
	// Emit State:true if this Add is the 0→1 transition.
	if isPaste {
		if pasteDepth.Add(1) == 1 {
			logger.Debug().Uint64("macro_id", macroID).Msg("paste-depth 0->1 (enqueue)")
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
				logger.Debug().Uint64("macro_id", macroID).Msg("paste-depth 1->0 (enqueue rollback)")
				emitPasteState(session, false)
			}
		}
		return ctx.Err()
	}
}
```

`rpcCancelKeyboardMacro` (lines 1123–1125) stays exactly as-is — it just calls `cancelAndDrainMacroQueue()`.

- [ ] **Step 1.7: Update the dispatch call site in `hidrpc.go:37`**

Find in `hidrpc.go` (line 37, inside `handleHidRPCMessage`):

```go
	case hidrpc.TypeKeyboardMacroReport:
		keyboardMacroReport, err := message.KeyboardMacroReport()
		if err != nil {
			logger.Warn().Err(err).Msg("failed to get keyboard macro report")
			return
		}
		rpcErr = rpcExecuteKeyboardMacro(keyboardMacroReport.Steps)
```

Replace the last line of this case block:

```go
		rpcErr = rpcExecuteKeyboardMacro(session, keyboardMacroReport.Steps, keyboardMacroReport.IsPaste)
```

`session` is already in scope — it is the second parameter of `handleHidRPCMessage(message hidrpc.Message, session *Session)`. Confirm by re-reading `hidrpc.go:14`.

- [ ] **Step 1.8: Run `go build ./...`**

Run:
```bash
go build ./...
```

Expected: exit 0, no output. If you see an error about `*Session` not being in scope in `jsonrpc.go`, double-check that the `Session` type is declared in the same package (package `kvm` — it is, per `webrtc.go:25`). If you see `undefined: atomic.Int32`, double-check the `sync/atomic` import is present. If you see unused variable errors, check that `macroEnqueueCtx` is referenced by `currentEnqueueCtx`.

- [ ] **Step 1.9: Run `go vet ./...`**

Run:
```bash
go vet ./...
```

Expected: exit 0, no output. Pay particular attention to any `copylocks` warnings (accidental copies of `sync.Mutex`) or `nilctx` warnings (passing a nil context).

- [ ] **Step 1.10: Run `go test ./...` (build-only for untouched packages)**

Run:
```bash
go test ./...
```

Expected: all existing tests pass. `jsonrpc.go`, `hidrpc.go`, and `internal/usbgadget/` do not currently have unit tests that would exercise the new paths, so this is effectively a build-and-vet gate for those packages. If any unrelated test fails, stop and report — do not proceed.

- [ ] **Step 1.11: Commit**

Run:
```bash
git add jsonrpc.go hidrpc.go
git commit -m "$(cat <<'EOF'
fix(paste): paste-depth semantics + shallow 64-slot queue (#42, #48)

Replace per-macro State:true/State:false emission in drainMacroQueue with
edge-triggered semantics driven by an atomic pasteDepth counter. State:true
now fires exactly on the 0->1 transition (from rpcExecuteKeyboardMacro's
pre-increment); State:false fires exactly on the 1->0 transition (from
drain post-run, enqueue rollback, or cancel sweep). Non-paste macros
(button bindings, on-screen keyboard combos) no longer touch pasteDepth
or produce state-message traffic at all, fixing the live bug where such
macros were toggling the frontend's isPasteInProgress mid-paste.

rpcExecuteKeyboardMacro now takes (session *Session, steps, isPaste) and
uses a macro-queue-scoped enqueue cancellation context, rotated by
cancelAndDrainMacroQueue so that blocked enqueuers wake cleanly on user
cancel. Every queuedMacro carries its origin session so state emits go
to the session that started the paste, not whichever global currentSession
happens to be live when the edge fires.

macroQueue capacity drops from 4096 to a named macroQueueDepth = 64
constant, per the approved pipeline spec, so the frontend's bufferedAmount
flow control actually provides backpressure instead of being masked by a
deep queue.

hidrpc.go:37 dispatch updated to thread session and IsPaste through.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Run `git log --oneline -1` to confirm the commit landed.

**Rollback condition for Task 1:** if `go build` or `go vet` still fails after three corrective attempts, or if `go test ./...` shows a regression in an untouched package, run `git reset --hard HEAD~1` to discard the commit and report the failure with the full build output. Do not proceed to Task 2.

---

## Task 2: Backend — `onHidMessage` goroutine-leak safety + keyboard-macro log downgrade

**Files:**
- Modify: `hidrpc.go:66-104` (the `onHidMessage` function)

**Why this is separate from Task 1:** the `onHidMessage` fix is logically independent (goroutine leak safety, not paste-depth semantics) and lives in a different function of the same file. Splitting keeps the Task 1 commit focused on the paste-depth change and makes this commit easy to review in isolation or revert on its own.

**Scope lock for this task:**
- ✅ Modify `hidrpc.go` only inside `onHidMessage` (lines 66–104).
- ❌ Do NOT touch `handleHidRPCMessage` (lines 14–64).
- ❌ Do NOT touch `reportHidRPCKeyboardMacroState` (line 255).
- ❌ Do NOT touch any other file.

### Steps

- [ ] **Step 2.1: Read the current `onHidMessage`**

Run:
```
Read hidrpc.go lines 66-104
```

Confirm the shape: `r := make(chan interface{})` (unbuffered), `go func() { handleHidRPCMessage(...); r <- nil }()`, `select { case <-time.After(1 * time.Second): Warn; case <-r: Debug }`.

- [ ] **Step 2.2: Confirm `hidrpc.TypeKeyboardMacroReport` identifier is reachable**

Run:
```
Grep for "TypeKeyboardMacroReport" in hidrpc.go and internal/hidrpc/
```

Expected: defined in `internal/hidrpc/message.go` as a `Type` constant, already used at `hidrpc.go:31`. The identifier is `hidrpc.TypeKeyboardMacroReport`.

- [ ] **Step 2.3: Apply the buffered-channel and log-downgrade fix**

Find in `hidrpc.go` (lines 93–103):

```go
	r := make(chan interface{})
	go func() {
		handleHidRPCMessage(message, session)
		r <- nil
	}()
	select {
	case <-time.After(1 * time.Second):
		scopedLogger.Warn().Msg("HID RPC message timed out")
	case <-r:
		scopedLogger.Debug().Dur("duration", time.Since(t)).Msg("HID RPC message handled")
	}
```

Replace with:

```go
	// Buffered completion channel so the worker goroutine's send never blocks.
	// With the shallow 64-slot macroQueue and blocking backpressure on full,
	// handleHidRPCMessage can legitimately take longer than the 1-second
	// timeout below. If we left this unbuffered, the worker would block forever
	// on the done-send once the timeout fired, leaking a goroutine per
	// timed-out message.
	//
	// chan struct{} rather than chan interface{} — the channel is a pure
	// done-signal, no payload ever flows through it.
	r := make(chan struct{}, 1)
	go func() {
		handleHidRPCMessage(message, session)
		r <- struct{}{}
	}()
	select {
	case <-time.After(1 * time.Second):
		// Downgrade the timeout log for keyboard-macro messages: with blocking
		// backpressure from the shallow macroQueue, enqueue taking >1s is an
		// expected, benign signal that the backend is absorbing flow control,
		// not a fault.
		if message.Type() == hidrpc.TypeKeyboardMacroReport {
			scopedLogger.Debug().Msg("HID RPC keyboard-macro handler took >1s (backpressure)")
		} else {
			scopedLogger.Warn().Msg("HID RPC message timed out")
		}
	case <-r:
		scopedLogger.Debug().Dur("duration", time.Since(t)).Msg("HID RPC message handled")
	}
```

- [ ] **Step 2.4: Run `go build ./...`**

Run:
```bash
go build ./...
```

Expected: exit 0, no output.

- [ ] **Step 2.5: Run `go vet ./...`**

Run:
```bash
go vet ./...
```

Expected: exit 0, no output.

- [ ] **Step 2.6: Run `go test ./...`**

Run:
```bash
go test ./...
```

Expected: all existing tests pass.

- [ ] **Step 2.7: Commit**

Run:
```bash
git add hidrpc.go
git commit -m "$(cat <<'EOF'
fix(hid): buffer onHidMessage completion channel and downgrade keyboard-macro timeout log (#48)

The onHidMessage worker previously sent into an unbuffered completion
channel. If the 1-second handler timeout won the race, the worker would
block forever on the done-send because nothing was reading — a
goroutine leak per timed-out message.

This was latent under the 4096-slot queue because enqueue rarely blocked
longer than 1s. With the new 64-slot queue from the paste-depth change,
blocking-enqueue-as-backpressure makes >1s handler durations routine on
a busy host, so the leak would become measurable.

Fix:
- Buffer the completion channel (capacity 1) so the worker's send is
  always non-blocking, even after the timeout branch has taken over.
- Change the channel type from chan interface{} to chan struct{} to
  make the "done signal, no payload" intent obvious.
- Downgrade the timeout log to Debug for TypeKeyboardMacroReport
  messages specifically — a >1s enqueue under backpressure is expected,
  not a fault. Other HID RPC message types still log Warn on timeout.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Run `git log --oneline -1` to confirm.

**Rollback condition for Task 2:** if build, vet, or tests fail, run `git reset --hard HEAD~1` and report. Do not proceed to Task 3.

---

## Task 3: Backend — `UpdateKeysDown` early return on failed HID write (#34)

**Files:**
- Modify: `internal/usbgadget/hid_keyboard.go` (the `KeyboardReport` function at line 365)

**Scope lock for this task:**
- ✅ Modify only `KeyboardReport` (lines 365–383).
- ❌ Do NOT touch `UpdateKeysDown` itself (lines ~335–363).
- ❌ Do NOT touch the write path (`keyboardWriteHidFile`).
- ❌ Do NOT touch any other function in this file.

### Steps

- [ ] **Step 3.1: Read the current `KeyboardReport` function**

Run:
```
Read internal/usbgadget/hid_keyboard.go lines 365-385
```

Confirm the current shape: `err := u.keyboardWriteHidFile(modifier, keys)`, then `u.RecordWriteResult(err)`, then an `if err != nil` block that only logs, then `u.UpdateKeysDown(modifier, keys)` called unconditionally, then `return err`.

- [ ] **Step 3.2: Apply the early-return fix**

Find in `internal/usbgadget/hid_keyboard.go` (lines 365–383):

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
	}

	u.UpdateKeysDown(modifier, keys)
	return err
}
```

Replace with:

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
		// Do NOT update internal key state on a failed write — otherwise
		// keysDownState diverges from what the host actually received and
		// subsequent reports will be based on a poisoned snapshot.
		return err
	}

	u.UpdateKeysDown(modifier, keys)
	return nil
}
```

Three lines changed: the `if err != nil` block gains a `return err` (and an explanatory comment), and the final `return err` becomes `return nil` since the error path has already returned.

- [ ] **Step 3.3: Run `go build ./...`**

Run:
```bash
go build ./...
```

Expected: exit 0, no output.

- [ ] **Step 3.4: Run `go vet ./...`**

Run:
```bash
go vet ./...
```

Expected: exit 0, no output.

- [ ] **Step 3.5: Run `go test ./...`**

Run:
```bash
go test ./...
```

Expected: all existing tests pass. The `internal/usbgadget` package may or may not ship with tests — either way, `go test` exercises the build of the package and the rest of the repo's tests.

- [ ] **Step 3.6: Commit**

Run:
```bash
git add internal/usbgadget/hid_keyboard.go
git commit -m "$(cat <<'EOF'
fix(usb): do not UpdateKeysDown on failed HID write (#34)

KeyboardReport previously called u.UpdateKeysDown(modifier, keys)
unconditionally after the HID write, even when keyboardWriteHidFile
returned an error. That caused u.keysDownState to diverge from what
the host actually received — a successful write later would then be
computed from a poisoned snapshot, producing stuck keys or out-of-order
press/release sequences on the host.

Fix: early-return on write error. If the write fails, log the warning
and return without touching keysDownState. Internal state now always
reflects what the host saw.

This is the correctness fix cherry-picked from PR #37 without pulling
in the rest of that PR's pre-pipeline ACK-per-batch model.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Run `git log --oneline -1` to confirm.

**Rollback condition for Task 3:** if build, vet, or tests fail, run `git reset --hard HEAD~1` and report. Do not proceed to Task 4.

---

## Task 4: Frontend — `waitForPasteDrain` helper + `executePasteText` call-site swap

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts` — add a module-scoped `waitForPasteDrain` helper above the `useKeyboard` hook, and replace the inline drain-wait block inside `executePasteText` (lines ~475–508) with a single call to the helper.

**Scope lock for this task:**
- ✅ Add a new module-scoped function (`waitForPasteDrain`) and a new type alias (`PasteDrainMode`) above the `useKeyboard` hook.
- ✅ Replace the inline drain-wait block inside `executePasteText`.
- ❌ Do NOT touch `executeMacroRemote`, `executeMacroClientSide`, or any other callback in this file.
- ❌ Do NOT touch `PASTE_LOW_WATERMARK`, `PASTE_HIGH_WATERMARK`, the `waitForDrain` local helper (that's bufferedAmount flow control, not paste drain), the `bufferedamountlow` listener, or the `channel.bufferedAmountLowThreshold` assignments.
- ❌ Do NOT change the `drainTimeoutMs` computation — preserve `Math.max(finalSettleMs, batches.length * 1000)` exactly.
- ❌ Do NOT touch `ui/src/utils/pasteMacro.ts` or `ui/src/utils/pasteBatches.ts`.
- ❌ Do NOT touch `useHidStore` definitions in `ui/src/hooks/stores.ts` — `isPasteInProgress` is already declared there.

### Steps

- [ ] **Step 4.1: Read the current `executePasteText` drain-wait block**

Run:
```
Read ui/src/hooks/useKeyboard.ts lines 400-520
```

Confirm: `executePasteText` starts at line 404, the batch send loop is lines 447–473, the inline drain-wait block is lines 475–508, the `finally` block is 509–512.

- [ ] **Step 4.2: Read the top of `useKeyboard.ts` to find the import block and module-scoped declarations**

Run:
```
Read ui/src/hooks/useKeyboard.ts lines 1-80
```

Identify the import block and any existing module-scoped constants (so the new helper can be placed consistently).

- [ ] **Step 4.3: Add the module-scoped `waitForPasteDrain` helper**

Add the following block above the `useKeyboard` hook declaration (directly above the `export function useKeyboard(...)` line, or directly above the nearest module-scoped helper already in the file). This helper must live at module scope, NOT inside `useKeyboard`, because it doesn't use React state.

**Critical correctness note — the `seenTrue` latch.** `useHidStore.subscribe((state) => ...)` without a selector fires on **every** store mutation, not just `isPasteInProgress` changes. If we resolved whenever a subscription update arrived with `isPasteInProgress === false`, an unrelated store update (e.g., a keyboard modifier, a USB status flag, any other slice) during the late-start window would resolve the wait early while the backend hasn't yet emitted `State:true`. The helper latches `seenTrue` — "have we ever observed `isPasteInProgress === true` during this wait?" — and only takes the clean-drain exit once we've actually seen a paste become active. This is the difference between "fast-return on false" (wrong) and "transition-true-then-false" (right).

```typescript
type PasteDrainMode = "required" | "bestEffort";

const PASTE_DRAIN_DEFAULT_ARM_WINDOW_MS = 200;
const PASTE_DRAIN_DEFAULT_SETTLE_MS = 500;

/**
 * Wait for a paste session to drain from the backend macro queue.
 *
 * Modes:
 * - "bestEffort" — resolves on timeout or on the arm window (if no paste ever
 *   started). Preserves the existing final-settle UX from executePasteText.
 *   Used by Phase 1's final-drain call site.
 * - "required" — rejects on timeout, never takes the arm-window fast path.
 *   Reserved for #38's chunk boundaries in Phase 2. No Phase 1 call sites.
 *
 * Correctness: the helper subscribes to useHidStore BEFORE sampling the
 * current isPasteInProgress value, and latches a local `seenTrue` flag.
 * The clean-drain exit fires only when the subscription observes
 * isPasteInProgress transition to false AFTER we've already seen it be
 * true. Without the latch, any unrelated store mutation arriving while
 * isPasteInProgress is still in its late-start false window would resolve
 * the wait early — reintroducing a softer version of the race we are
 * trying to remove.
 *
 * In bestEffort mode, if the arm window elapses without isPasteInProgress
 * ever going true, we assume the paste never materialized (zero batches,
 * immediate error, send loop that did nothing) and resolve without
 * waiting for the full timeout.
 */
async function waitForPasteDrain(
  mode: PasteDrainMode,
  timeoutMs: number,
  signal?: AbortSignal,
  settleMs: number = PASTE_DRAIN_DEFAULT_SETTLE_MS,
  armWindowMs: number = PASTE_DRAIN_DEFAULT_ARM_WINDOW_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let seenTrue = false;
    let armHandle: ReturnType<typeof setTimeout> | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (armHandle !== undefined) clearTimeout(armHandle);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    };

    const resolveClean = () => {
      if (done) return;
      done = true;
      cleanup();
      // Observed drain → host USB settle delay before the caller resumes.
      setTimeout(resolve, settleMs);
    };

    const resolveImmediate = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    const rejectErr = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => rejectErr(new Error("Paste execution aborted"));

    // Subscribe FIRST. Every store update runs this callback; we update
    // the `seenTrue` latch on truthy updates and only take the clean-drain
    // exit on a falsy update AFTER seenTrue has been latched.
    const unsubscribe = useHidStore.subscribe((state) => {
      if (state.isPasteInProgress) {
        seenTrue = true;
        return;
      }
      if (seenTrue) {
        resolveClean();
      }
    });

    // Now sample the current value. If a state change happened between
    // subscribe() and getState(), the subscription callback above already
    // set seenTrue — this assignment is harmlessly redundant in that case.
    // If no change happened, we pick up whatever the store says right now.
    seenTrue = useHidStore.getState().isPasteInProgress;

    // Fast-reject if the caller already aborted before we even started.
    if (signal?.aborted) {
      rejectErr(new Error("Paste execution aborted"));
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    timeoutHandle = setTimeout(() => {
      if (mode === "required") {
        rejectErr(
          new Error(`waitForPasteDrain: required drain timed out after ${timeoutMs}ms`),
        );
      } else {
        // bestEffort: treat timeout as success, skip settle.
        resolveImmediate();
      }
    }, timeoutMs);

    // Arm window — bestEffort only, and only if we haven't yet seen a
    // paste become active. If after armWindowMs the store still says
    // isPasteInProgress === false AND seenTrue is still false, assume
    // the paste never materialized and resolve. If the store has gone
    // true during the window, flip seenTrue and defer to the subscription.
    if (mode === "bestEffort" && !seenTrue) {
      armHandle = setTimeout(() => {
        armHandle = undefined;
        if (useHidStore.getState().isPasteInProgress) {
          seenTrue = true;
          return;
        }
        if (!seenTrue) {
          resolveImmediate();
        }
      }, armWindowMs);
    }
  });
}
```

**Placement note:** put this directly above the `export function useKeyboard` declaration (or the equivalent `const useKeyboard = ...` if the file uses that style). It must be OUTSIDE the hook body.

**Why subscribe before getState:** Zustand's `.subscribe()` does not fire with the current value — it fires only on subsequent changes. Subscribing first, then reading `getState()`, closes the small window where a state change could otherwise slip between sampling and wiring the listener. If a mutation lands after subscribe but before getState, the callback runs and sets `seenTrue`; the getState read then picks up the new (still `true`) value and the redundant reassignment leaves `seenTrue` correct. If we reversed the order, a mutation in that window would be missed entirely.

- [ ] **Step 4.4: Replace the inline drain-wait block in `executePasteText`**

Find in `ui/src/hooks/useKeyboard.ts` (approximately lines 475–508):

```typescript
        // Wait for backend to finish draining all queued macros.
        // The drain goroutine sends State:false after each macro completes.
        // We wait for isPasteInProgress to become false (final completion signal),
        // with a generous timeout based on the number of batches.
        const drainTimeoutMs = Math.max(finalSettleMs, batches.length * 1000);
        await new Promise<void>((resolve, reject) => {
          // If paste is already not in progress (e.g. very small paste), resolve immediately
          if (!useHidStore.getState().isPasteInProgress) {
            resolve();
            return;
          }

          const timeout = setTimeout(() => {
            unsubscribe();
            resolve(); // Resolve on timeout rather than reject — batches were sent successfully
          }, drainTimeoutMs);

          const abortHandler = () => {
            clearTimeout(timeout);
            unsubscribe();
            reject(new Error("Paste execution aborted"));
          };
          signal?.addEventListener("abort", abortHandler, { once: true });

          const unsubscribe = useHidStore.subscribe(state => {
            if (!state.isPasteInProgress) {
              clearTimeout(timeout);
              signal?.removeEventListener("abort", abortHandler);
              unsubscribe();
              // Small settle delay after final completion for host USB consumption
              setTimeout(resolve, 500);
            }
          });
        });
```

Replace with:

```typescript
        // Wait for backend to finish draining all queued macros. The helper
        // subscribes first (no late-start race) and uses an arm window so a
        // paste that never materialized doesn't block for the full timeout.
        // bestEffort mode preserves the current final-settle UX — resolves on
        // timeout, resolves with a settle delay on clean drain, rejects only
        // on abort.
        const drainTimeoutMs = Math.max(finalSettleMs, batches.length * 1000);
        await waitForPasteDrain("bestEffort", drainTimeoutMs, signal);
```

The `drainTimeoutMs` calculation is preserved verbatim. The `finally` block at line 509 onwards (`channel.removeEventListener("bufferedamountlow", onLow)` and `channel.bufferedAmountLowThreshold = prevThreshold`) is left untouched — `waitForPasteDrain` lives inside the `try` block, so cleanup still runs on both the success and rejection paths.

- [ ] **Step 4.5: Run TypeScript type check**

Run:
```bash
cd ui && npx tsc --noEmit
```

Expected: exit 0, no output. If `waitForPasteDrain` references `useHidStore` and the import is missing, add it to the imports near the top of the file (it is almost certainly already imported — the old inline block used it too). If there are errors about `ReturnType<typeof setTimeout>` being `NodeJS.Timeout` vs. `number`, cast to `number` using `as ReturnType<typeof setTimeout>` — this is a known quirk of DOM types vs. Node types in the React build.

- [ ] **Step 4.6: Run ESLint**

Run:
```bash
cd ui && npx eslint './src/**/*.{ts,tsx}'
```

Expected: exit 0, no output. Pay attention to:
- `no-unused-vars` — the old inline block may have left a `resolve`/`reject` that's no longer used if you swapped imperfectly
- `react-hooks/exhaustive-deps` — `waitForPasteDrain` is module-scoped, not a hook dependency, so it should NOT appear in the `executePasteText` `useCallback` dependency array. If ESLint complains about `waitForPasteDrain` being missing from deps, that is a false positive to suppress via a comment — but verify first that the helper really is at module scope.

- [ ] **Step 4.7: Commit**

Run:
```bash
git add ui/src/hooks/useKeyboard.ts
git commit -m "$(cat <<'EOF'
feat(paste): waitForPasteDrain helper with subscribe-first seenTrue latch (#42)

Factor the inline drain-wait block inside executePasteText into a reusable
module-scoped helper waitForPasteDrain(mode, timeoutMs, signal). Mode is
"required" | "bestEffort":

- "bestEffort" preserves the existing final-settle UX: resolves on timeout,
  resolves with a 500ms settle delay on clean drain, rejects only on abort.
- "required" rejects on timeout. Reserved for #38 (Phase 2) chunk boundaries;
  no call sites in Phase 1.

Correctness: the helper latches a local `seenTrue` flag — "have we ever
observed isPasteInProgress === true during this wait?" — and only takes
the clean-drain exit after seenTrue has been set. useHidStore.subscribe()
without a selector fires on every store mutation, not just
isPasteInProgress changes, so without the latch an unrelated store update
during the late-start window would resolve the wait early while the
backend hasn't yet emitted State:true. The latch combined with a
subscribe-first-then-sample order closes both the "missed transition"
and "spurious unrelated update" races.

In bestEffort mode, if the arm window (200ms) elapses without
isPasteInProgress ever going true, the helper resolves immediately —
handles the "paste never materialized" case (zero batches, immediate
error) without waiting for the full timeout. required mode skips the
arm window and waits the full timeout budget.

executePasteText's inline drain wait is replaced with a single
`await waitForPasteDrain("bestEffort", drainTimeoutMs, signal)`. The
drainTimeoutMs calculation is preserved verbatim; flow control watermarks,
the bufferedamountlow listener, and the finally-block cleanup are
untouched.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Run `git log --oneline -1` to confirm.

**Rollback condition for Task 4:** if `tsc --noEmit` or ESLint fails after three corrective attempts, run `git reset --hard HEAD~1` and report. Do not try to paper over TypeScript errors with `any` or `@ts-ignore`.

---

## Post-implementation verification gate (performed by team lead, not by a teammate)

After all four tasks commit, the team lead runs the full verification loop before handing off to code review:

```bash
cd ui && npx tsc --noEmit
cd ui && npx eslint './src/**/*.{ts,tsx}'
cd ..
go build ./...
go vet ./...
go test ./...
git log --oneline -5
```

All must pass. The `git log` should show 4 new commits on top of the spec commit(s):

1. `fix(paste): paste-depth semantics + shallow 64-slot queue (#42, #48)` — Task 1
2. `fix(hid): buffer onHidMessage completion channel and downgrade keyboard-macro timeout log (#48)` — Task 2
3. `fix(usb): do not UpdateKeysDown on failed HID write (#34)` — Task 3
4. `feat(paste): waitForPasteDrain helper with subscribe-first arm window (#42)` — Task 4

If verification passes, proceed to Step 7 (code review) of the Phase 1 workflow. If any check fails, fix the issue and amend the relevant task's commit — do NOT create drive-by fix commits that muddy the per-task boundary.

## Runtime validation notes for the PR description

These are NOT run as part of implementation (they require a physical device with USB + HDMI attached). The PR description should list them as post-merge validation:

- 100k-char paste in both `reliable` and `fast` profiles — verify no stalls, no stuck `isPasteInProgress`, no corrupted text on the target
- Button macro (e.g., `MacroBar.tsx`) fired concurrently with a paste — verify the paste's drain wait does not resolve prematurely when the button macro completes
- Cancel mid-paste with the queue ≥32 items deep — verify blocked enqueuers wake and return errors, `State:false` fires exactly once, no goroutine leak (capture `curl localhost:9501/debug/pprof/goroutine?debug=2` before/after if the debug endpoint is reachable)
- `onHidMessage` 1-second timeout fires under heavy backpressure — verify no `Warn`-level logs flood for keyboard-macro messages (should be `Debug`), and no goroutine leak
- Trailing batches after cancel — confirm the "Known protocol limitation" section of the spec is accurate: a handful of post-cancel keystrokes may still reach the host, and this is expected without wire-level paste IDs

---

## Spec coverage self-check

Every requirement from `docs/superpowers/specs/2026-04-10-paste-depth-semantics-design.md` is implemented by exactly one of the tasks above:

| Spec requirement | Task |
|---|---|
| `const macroQueueDepth = 64` | 1 (Step 1.3) |
| `type queuedMacro struct { steps, isPaste, session }` | 1 (Step 1.3) |
| `pasteDepth atomic.Int32` | 1 (Step 1.3) |
| `macroEnqueueCtx/Cancel/Mu` plumbing | 1 (Step 1.3) |
| `startMacroQueue` inits both queue and enqueue ctx | 1 (Step 1.3) |
| `currentEnqueueCtx()` helper | 1 (Step 1.3) |
| `emitPasteState(session, state)` helper | 1 (Step 1.3) |
| `rpcExecuteKeyboardMacro(session, steps, isPaste)` rollback-safe enqueue | 1 (Step 1.6) |
| `drainMacroQueue` paste-depth decrement, deletes hardcoded emits | 1 (Step 1.4) |
| `cancelAndDrainMacroQueue` rotates enqueue ctx, sweeps with session tracking | 1 (Step 1.5) |
| `hidrpc.go:37` dispatch passes `session` and `IsPaste` | 1 (Step 1.7) |
| `onHidMessage` buffered completion channel | 2 (Step 2.3) |
| `onHidMessage` keyboard-macro timeout log downgrade | 2 (Step 2.3) |
| `KeyboardReport` early return on failed HID write | 3 (Step 3.2) |
| `waitForPasteDrain` helper with arm window and both modes | 4 (Step 4.3) |
| `executePasteText` uses `waitForPasteDrain("bestEffort", ...)` | 4 (Step 4.4) |
| Preserve 200ms inter-macro sleep in `drainMacroQueue` | 1 (Step 1.4) |
| Preserve `macroCurrentCancel` plumbing in `drainMacroQueue` | 1 (Step 1.4) |
| Preserve `PASTE_LOW_WATERMARK` / `PASTE_HIGH_WATERMARK` flow control | scope lock on Task 4 |
| Preserve `drainTimeoutMs = Math.max(finalSettleMs, batches.length * 1000)` | 4 (Step 4.4) |
| Preserve `finally`-block cleanup in `executePasteText` | scope lock on Task 4 |

No spec section is unimplemented. No task references code not defined in this plan or in the existing repo.
