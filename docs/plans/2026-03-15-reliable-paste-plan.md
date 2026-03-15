# JetKVM Reliable Paste Implementation Plan

> **For Hermes:** Use subagent-driven-development to execute this plan task-by-task.

**Goal:** Improve the official JetKVM paste tool so large text/code pastes are more reliable on real devices by replacing monolithic macro submission with chunked, paced batch execution, while preserving a path to higher throughput after reliability is proven.

**Architecture:** Keep the existing frontend-driven paste workflow and HID macro transport, but add a batch scheduler in the UI layer. Instead of generating one huge macro for the entire pasted text, generate smaller macro batches, wait for batch completion via existing paste-state signals, and expose progress plus a reliability/speed tuning surface. Start with conservative defaults, then allow faster presets once validated on real hardware.

**Tech Stack:** React, TypeScript, existing JetKVM frontend hooks (`useKeyboard`, `useHidRpc`, `useJsonRpc`), existing HID macro state messages, official JetKVM dev deployment scripts.

---

## Why this is the right first patch

Current upstream paste flow appears to:
- build one large `macroSteps` list in `ui/src/components/popovers/PasteModal.tsx`
- call `executeMacro(macroSteps)` once
- send one large HID macro payload through `useKeyboard` / `useHidRpc`

That is probably acceptable for small pastes but fragile for large code payloads because there is no batching, pacing, or recovery boundary. We should fix reliability first, then tune speed.

---

## Throughput note: can we make it faster too?

Yes, likely — but **only after** we stop losing characters.

### Short answer
You being able to type 110 WPM does **not** mean the current JetKVM paste path should aim for human-like key intervals. Paste is not human typing; it is bulk macro execution over a device/control pipeline.

### Practical target
We should build two modes:
- **Reliable mode** — smaller batches, slightly safer timing, default for large pastes
- **Fast mode** — larger batches, lower delay, only after the reliable path works consistently

### Likely win
If the current failure is caused by giant macro payloads rather than purely per-key delay, then batching may actually improve **both reliability and effective speed**, because retries and corruption losses will drop.

---

## Files most likely to change

### Primary
- `ui/src/components/popovers/PasteModal.tsx`
- `ui/src/hooks/useKeyboard.ts`
- `ui/src/hooks/stores.ts` (if we add paste progress state)
- `ui/src/localization/messages/*` or equivalent generated message source if new copy is needed

### Secondary / inspect while implementing
- `ui/src/hooks/hidRpc.ts`
- `ui/src/components/InfoBar.tsx` (if surfacing paste progress/status there)

### Tests to add
- frontend unit tests near the paste modal / hook area if test infra exists
- if no frontend test infra is convenient, at minimum add pure helper-unit tests for batching logic in a new utility file

---

## Deployment plan to your JetKVM

Assume device reachable by SSH and browser.

### Preferred deployment command
```bash
cd /home/ethereal/projects/jetkvm-analysis/official-kvm
./dev_deploy.sh -r <YOUR_JETKVM_IP>
```

### Faster UI-only iteration
```bash
cd /home/ethereal/projects/jetkvm-analysis/official-kvm/ui
./dev_device.sh <YOUR_JETKVM_IP>
```

### Logs if needed
```bash
ssh root@<YOUR_JETKVM_IP>
tail -f /userdata/jetkvm/last.log
```

### Rollback safety
Keep the current device firmware/software state known before testing. If a UI patch is bad, redeploy a known-good commit with `./dev_deploy.sh -r <IP>` from that commit.

---

## Phase 1: Extract paste batching logic from the monolithic submit path

### Task 1: Create a pure helper for chunking paste text into macro batches

**Objective:** Make the batching strategy testable and not embedded inline in the modal component.

**Files:**
- Create: `ui/src/utils/pasteBatches.ts`
- Create: `ui/src/utils/pasteBatches.test.ts` (or existing frontend/unit test location)

**Step 1: Write failing tests**
Test cases:
- converts text into multiple batches with max characters per batch
- preserves character order
- keeps unsupported-character detection separate from batch slicing
- handles empty input

**Suggested helper shape:**
```ts
export interface PasteBatchConfig {
  maxCharsPerBatch: number;
}

export function chunkPasteText(text: string, config: PasteBatchConfig): string[]
```

**Acceptance criteria:**
- batching logic is pure and independently testable
- no UI dependencies in the helper

---

### Task 2: Create a helper that converts text to macro steps for a single batch

**Objective:** Separate text→macro conversion from UI event handling.

**Files:**
- Create: `ui/src/utils/pasteMacro.ts`
- Create: `ui/src/utils/pasteMacro.test.ts`

**Step 1: Write failing tests**
Test cases:
- valid ASCII text produces expected number of macro steps
- unsupported chars are reported explicitly
- accented/dead-key logic still works batch-locally

**Suggested result shape:**
```ts
export interface PasteMacroResult {
  steps: MacroStep[];
  invalidChars: string[];
}
```

**Acceptance criteria:**
- one batch of text can be converted without depending on component state
- invalid chars are returned, not silently skipped

---

## Phase 2: Add a batch scheduler over existing macro execution

### Task 3: Add a batch execution method in `useKeyboard`

**Objective:** Allow UI to execute one paste batch at a time and wait for completion between batches.

**Files:**
- Modify: `ui/src/hooks/useKeyboard.ts`

**Approach:**
Build a higher-level helper on top of existing `executeMacro(...)`, something like:
```ts
executePasteBatches(batches: MacroSteps[], options: { onProgress?: (done: number, total: number) => void })
```

This helper should:
- execute batches sequentially
- await completion of each batch before starting the next
- support cancellation
- emit progress

**Important:** Reuse the existing paste-state plumbing (`KeyboardMacroStateMessage` with `isPaste`) if possible instead of inventing a second transport.

**Acceptance criteria:**
- one failed batch does not incorrectly mark the whole paste as complete
- cancellation stops future batches cleanly
- progress callback fires deterministically

---

### Task 4: Add a conservative default batch size and pacing profile

**Objective:** Make reliability the default for large pastes.

**Files:**
- Modify: `ui/src/components/popovers/PasteModal.tsx`
- Optionally create: `ui/src/constants/paste.ts`

**Suggested initial defaults:**
- `maxCharsPerBatch = 32` or `64`
- per-step delay stays near current values initially
- add internal profile constants:
  - `reliable`
  - `fast`

**Recommendation:**
Start with something intentionally conservative like:
```ts
const RELIABLE_PASTE_PROFILE = {
  maxCharsPerBatch: 32,
  delayMs: 35,
};
```

Then only raise speed after validation.

**Acceptance criteria:**
- large pastes are automatically split into multiple batches
- no more single massive macro send for large text

---

## Phase 3: Improve UI/UX for visibility and control

### Task 5: Add visible paste progress and mode selection

**Objective:** Make long pastes understandable and user-controllable.

**Files:**
- Modify: `ui/src/components/popovers/PasteModal.tsx`
- Optionally modify: `ui/src/components/InfoBar.tsx`
- Modify localization message files as needed

**Add UI elements:**
- progress indicator: `Batch X / Y`
- mode selector:
  - Reliable
  - Fast (experimental)
- optional cancel button behavior while in progress

**Acceptance criteria:**
- user can see whether the paste is still running
- user can choose a safer or faster mode
- invalid chars are shown before paste starts

---

### Task 6: Turn invalid characters into a hard block for reliable mode

**Objective:** Prevent silent corruption when exact text fidelity matters.

**Files:**
- Modify: `ui/src/components/popovers/PasteModal.tsx`

**Behavior:**
- if invalid chars exist, disable the confirm action in reliable mode
- optionally allow override in fast/manual mode later, but default should be strict

**Acceptance criteria:**
- exact-text workflows don’t proceed with known-invalid characters unnoticed

---

## Phase 4: Speed tuning after reliability works

### Task 7: Add a fast profile and tune effective throughput

**Objective:** Improve practical speed without regressing correctness.

**Files:**
- Modify: `ui/src/constants/paste.ts` or `PasteModal.tsx`

**Suggested initial profiles:**
```ts
const PASTE_PROFILES = {
  reliable: { maxCharsPerBatch: 32, delayMs: 35 },
  fast: { maxCharsPerBatch: 96, delayMs: 20 },
};
```

**Important note:**
The effective speed gain may come more from **batching** than from reducing inter-key delay. Do not optimize for theoretical WPM first; optimize for end-to-end successful text throughput.

**Acceptance criteria:**
- fast mode is clearly labeled as experimental/tunable if needed
- reliable mode remains the default until real-device results prove otherwise

---

## Phase 5: Real-device validation on your JetKVM

### Task 8: Validate with structured real-world payloads

**Objective:** Confirm actual improvement on the device that matters.

**Test matrix:**
1. short paste (1-2 lines)
2. medium paste (~20-50 lines)
3. large code file snippet
4. repeated large paste back-to-back
5. punctuation-heavy code
6. layout-sensitive characters

**Metrics to record:**
- characters dropped
- whether failures happen only on large payloads
- total paste duration
- whether fast mode remains accurate
- whether cancellation works

**Acceptance criteria:**
- reliable mode no longer drops characters in your typical code/file workflow, or drops them far less frequently than current upstream
- progress and cancellation behavior make long pastes operationally usable

---

## Phase 6: Plan how to get it onto your JetKVM long-term

### Path A: Local custom deployment (fastest)
Use your local patched clone and deploy directly:
```bash
cd /home/ethereal/projects/jetkvm-analysis/official-kvm
./dev_deploy.sh -r <YOUR_JETKVM_IP>
```

Best for:
- immediate testing
- iterative tuning
- private custom workflow

### Path B: Keep a private fork / branch
Create a private or personal branch/fork with the reliable-paste patch and redeploy from there whenever needed.

Best for:
- preserving your custom behavior
- easy rebase onto upstream
- audit/history

### Path C: Upstream contribution
If the patch is broadly useful and cleanly generalized, submit a PR upstream.

Best for:
- long-term maintenance if accepted
- helping all users

**My recommendation:**
Do A first, B second, and only consider C after real-device validation proves the design.

---

## What I recommend we implement first

### Narrow first patch scope
Implement only this in the first coding pass:
1. extract text→macro helper
2. add chunking helper
3. execute batches sequentially
4. show progress
5. keep a conservative default profile

Do **not** attempt in the first patch:
- backend protocol redesign
- resume/retry across device reconnects
- complicated adaptive timing logic
- exact WPM optimization

That keeps the first patch likely to work.

---

## Expected outcome

If this patch is correct, the official JetKVM paste tool should become:
- slower per batch than a naive giant send
- but **much more reliable for large text/code pastes**
- and likely **faster in practice** for your workflow because fewer corrupt runs means less manual retry

---

## After this patch

If reliable paste still isn’t good enough for your use case, then the next architectural step is not “more tiny tweaks.” It becomes:
- custom inbound transfer tooling
- or an OptiGap-inspired/reverse OptiGap approach

But first, this patch is the right thing to try.
