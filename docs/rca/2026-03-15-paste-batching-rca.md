# JetKVM Reliable Paste Patch RCA

Date: 2026-03-15
Repo: `WyrmKeep/jetkvm-reliable-paste-private`
Context: first-pass reliable paste patch was deployed to JetKVM `192.168.1.36`. User reported:
- menu showed Reliable / Fast and progress UI
- pasted characters appeared in the wrong order / were corrupted
- cancel no longer worked
- batching felt effectively huge for a single block of test text
- after SSH/dev deployment session ended, the JetKVM rebooted and came back on the old version with a downgrade/revert-style prompt

---

## Executive summary

The first-pass patch improved the **shape** of the UI but did **not** correctly change the execution semantics of paste.

### Primary root cause
The patch assumed that `await executeMacro(batch)` meant **"this batch has finished on the device"**.
That assumption is false on the HID-RPC path.

In reality:
- remote `executeMacro()` returns after **sending** the macro to the device
- it does **not** wait for the device to finish executing the macro
- the next batch is therefore sent while the previous one is still running
- the backend cancels the currently running macro whenever a new macro arrives

This causes:
- truncation at batch boundaries
- apparent reordering/corruption
- ineffective cancel behavior
- misleading progress reporting

### Secondary root cause
The deployment method (`./dev_deploy.sh` in debug/dev mode) runs `jetkvm_app_debug` attached to the live SSH session rather than installing through the normal OTA/update path. If that debug process dies uncleanly, the watchdog can reboot the device, and the device will return to the installed version on reboot.

---

## Evidence and code trace

## 1. The patch sends multiple batches, but does not truly await completion

### Patched code
In the first-pass patch, `PasteModal.tsx` builds batches and then does roughly:

```ts
await runPasteBatches(stepsBatches, executeMacro, {
  batchPauseMs: profile.batchPauseMs,
  onProgress: ...,
});
```

`runPasteBatches()` in `ui/src/utils/pasteBatches.ts` awaits only the Promise returned by `executeBatch(batch)`.

### Problem
On the HID-RPC path, `executeMacroRemote()` in `ui/src/hooks/useKeyboard.ts` only does:

```ts
sendKeyboardMacroEventHidRpc(macro);
```

and then returns.

It does **not** wait for any backend completion signal.

### Result
The batching loop treated “message sent” as “batch finished”, which is incorrect.

---

## 2. Backend cancels currently running macro when a new one arrives

In `jsonrpc.go`:

```go
func rpcExecuteKeyboardMacro(macro []hidrpc.KeyboardMacroStep) error {
    cancelKeyboardMacro()
    ...
}
```

Every new keyboard macro request starts by canceling the current macro.

### Consequence
Once batch N+1 arrives before batch N completes, batch N is canceled.

This means the first-pass patch likely produced this pattern:
1. send batch 1
2. return immediately on client
3. sleep 120ms / 60ms
4. send batch 2
5. backend cancels batch 1
6. repeat

That exactly matches the user-observed symptoms.

---

## 3. The configured “Reliable” key delay was effectively ignored

The patch called:

```ts
buildPasteMacroSteps(batch, selectedKeyboard, delay || profile.keyDelayMs)
```

But `delay` came from `delayValue`, whose default is `20`, so it is truthy.

### Consequence
Even in Reliable mode, the effective per-key delay stayed at the old default rather than switching to the safer profile delay.

This made Reliable mode far less conservative than intended.

---

## 4. Batch size was based on text characters, not real macro cost

The patch chunked by character count, e.g. `32` chars for reliable mode.

However:
- one character can become multiple macro steps
- dead-key/accent handling expands further
- each logical key becomes two remote macro steps in `executeMacroRemote()`:
  - press step with hardcoded `delay: 20`
  - reset step with `delay: step.delay || 100`

### Consequence
Even “small” text batches can still be large, long-running device macros.

This explains why the user felt the batches were still huge.

---

## 5. Cancel became ineffective for the same reason

The patch introduced client-side batch scheduling but did not add a client-side abort signal to stop the scheduling loop.

Existing `cancelExecuteMacro()` behavior on HID-RPC only cancels the **current backend macro**.
It does not cancel already-submitted future batches, and the loop itself had no proper abort gate.

### Consequence
Cancel would stop the current macro, but later batches could still arrive or the loop could continue submitting more work.

---

## 6. Progress UI was misleading

The patch updated progress after each `await executeBatch(batch)`.

Because remote batch completion was not actually awaited, progress meant:
- “batch submitted”
not
- “batch finished on the device”

### Consequence
The UI could imply forward progress even while the device was still working on — or canceling — previous batches.

---

## 7. Deployment/reboot RCA

The reboot/revert behavior is most likely explained by the deployment method, not the paste logic itself.

### `dev_deploy.sh` behavior
Without `--install`, the official script:
- kills the normal app
- copies `jetkvm_app_debug`
- launches it directly in the live SSH session

It does **not** install through the OTA/update path.

### Why that matters
The app uses the hardware watchdog. If the debug app dies uncleanly when the SSH-attached session ends, the watchdog can reboot the device.

After reboot, the device comes back on the installed version, not the debug binary.

### Consequence
This explains why the patched UI could disappear and the device could appear to “downgrade” or revert after reboot.

---

## Root cause hierarchy

### Root cause A — semantic bug in batching design
**Severity:** Critical

The patch used the wrong completion boundary.
It treated “macro request sent” as “macro completed”.

This is the main reason for corruption, ordering issues, and broken cancel.

### Root cause B — wrong batching metric
**Severity:** High

Chunking by characters rather than macro cost / payload size made the batches operationally larger than expected.

### Root cause C — profile delay bug
**Severity:** Medium

Reliable mode did not actually use its intended slower key delay by default.

### Root cause D — unsafe deployment/testing workflow
**Severity:** High for device stability

Using `dev_deploy.sh` debug mode on the live JetKVM made it easy for the patched build to vanish on reboot and made the watchdog/revert behavior look like a patch crash.

---

## What the next patch must do

## Patch v2 requirements

### 1. Introduce a real completion-aware paste scheduler
`executeMacroRemote()` must not resolve until the device signals paste/macro completion.

Use the existing `KeyboardMacroStateMessage` / `isPasteInProgress` state transitions as the completion signal, or add a stricter completion primitive if needed.

### 2. Add true client-side cancellation
The scheduler must stop:
- before sending the next batch
- during inter-batch waits
- when the user presses cancel

### 3. Batch by macro size / step count, not just text chars
We should compute actual macro step count and cap by a safer operational limit.

### 4. Apply Reliable/Fast profile delays correctly
Reliable mode must actually slow down the macro when selected.

### 5. Keep progress, but only report completed batches after confirmed device completion

---

## Recommended deployment/testing changes

### Avoid debug-session-only deploy for validation when possible
For device stability, prefer a safer deploy/install path for serious validation, or at minimum treat debug deploy as ephemeral.

### Always verify deployment success on-device
Do not rely on whether the deploy command exits cleanly. Verify by:
- UI changes visible in browser
- app process state
- remote binary timestamps

---

## Status

The first-pass patch should be treated as a failed-but-useful prototype.
It validated that the UI shape (mode selector, progress, batching concept) is useful, but it also exposed the real hidden contract bug in the JetKVM paste pipeline.

That means the next work should be a proper v2 fix, not incremental tuning of the broken first version.
