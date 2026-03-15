# JetKVM Reliable Paste v2 Plan

> For Hermes: do not implement until the completion/wait semantics are fixed. The v1 prototype is useful evidence but should not be tuned further.

## Goal
Build a second paste patch that preserves ordering and restores cancellation by waiting for real on-device completion between batches.

## Scope
- Replace submit-based batching with completion-aware scheduling
- Restore true cancel behavior
- Batch by macro cost / step count, not just character count
- Correctly apply Reliable/Fast timing profiles
- Keep progress UI, but only report completed batches after device completion

## Core design changes

### 1. Completion-aware remote macro execution
`executeMacroRemote()` must resolve only after paste completion is observed from the HID RPC macro state path.

### 2. Browser-side scheduler abort signal
The batch runner must stop sending future batches as soon as the user cancels.

### 3. Batch size metric
Batch by generated macro step count and/or encoded macro payload size, not raw text length.

### 4. Profile timing correctness
Reliable mode must truly use slower/default-safe timing. Fast mode must remain explicit and experimental.

## Primary files to revisit
- `ui/src/hooks/useKeyboard.ts`
- `ui/src/components/popovers/PasteModal.tsx`
- `ui/src/utils/pasteBatches.ts`
- `ui/src/utils/pasteMacro.ts`
- possibly `ui/src/hooks/stores.ts` if explicit paste phase/progress state is needed

## Validation targets
- exact ordering preserved on medium and large code pastes
- cancel stops the current batch and prevents future batches
- reliable mode materially improves accuracy
- fast mode only enabled after reliable mode passes on the real device

## Deployment/testing note
Avoid treating `dev_deploy.sh` debug mode as durable deployment. Confirm success via on-device UI, binary timestamps, and running processes after each test cycle.
