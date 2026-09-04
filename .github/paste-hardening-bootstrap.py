# One-shot branch-local preparation; removed from the resulting source commit.
from pathlib import Path
import json
import os
import subprocess

assert os.environ.get('GITHUB_REF') == 'refs/heads/fix/reliable-paste-pacing-and-safe-profiles'
subprocess.run(['git', 'merge-base', '--is-ancestor', '968bfd5ab9e55261adf26ab29f5fd8e9966d1782', 'HEAD'], check=True)
changed = {'internal/pastepacing/pacing.go', 'internal/pastepacing/pacing_test.go', 'paste_pacing.go', 'paste_pacing_test.go', 'ui/src/hooks/useKeyboard.paste.test.ts', 'docs/paste-reliability.md', 'docs/tickets/PASTE-014.md'}
def record(path):
    changed.add(path)
    Path('/tmp/paste-hardening-files.json').write_text(json.dumps(sorted(changed)))
def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    if text.count(old) != count:
        raise RuntimeError(f'{path}: expected {count} matches, found {text.count(old)} for {old!r}')
    p.write_text(text.replace(old, new))
    record(path)
def append(path, text):
    p = Path(path)
    p.write_text(p.read_text() + '\n' + text)
    record(path)
record('docs/paste-reliability.md')

replace('jsonrpc.go', '\t\t\terr = rpcDoExecuteKeyboardMacro(ctx, item.generation, item.steps)', '''\t\t\tif item.isPaste {
\t\t\t\terr = rpcDoExecutePasteMacro(ctx, item.generation, item.steps)
\t\t\t} else {
\t\t\t\terr = rpcDoExecuteKeyboardMacro(ctx, item.generation, item.steps)
\t\t\t}''')
replace('jsonrpc.go', '// Paste macros are uniformly paced per-step at measured-safe rates and get', '// Paste macros preserve minimum per-step delays without catch-up and get')
replace('jsonrpc.go', '''\t\t// uniformly paced per-step at a measured-safe rate, and uniform pacing
\t\t// carries through batch boundaries because the final reset step's delay
\t\t// is slept inside rpcDoExecuteKeyboardMacro — adding a gap here would''', '''\t\t// paced with minimum per-step delays, including the final reset in
\t\t// rpcDoExecutePasteMacro. No deadline catch-up is permitted. Adding a
\t\t// gap here would''')
replace('hidrpc.go', '\tt := time.Now()\n\n\t// Buffered completion channel', '''\t// Macro admission must finish before the keyboard queue advances. The
\t// old one-second watchdog left a live worker behind, allowing later
\t// macros to race it into macroQueue. Enqueue is cancellable; explicit
\t// cancellation is routed separately (HID queue 3).
\tif message.Type() == hidrpc.TypeKeyboardMacroReport {
\t\tif msg.producer.Context().Err() == nil {
\t\t\thandleHidRPCMessage(message, session)
\t\t}
\t\treturn
\t}

\tt := time.Now()

\t// Buffered completion channel''')
replace('hidrpc.go', '''\t// With the shallow 64-slot macroQueue and blocking backpressure on full,
\t// handleHidRPCMessage can legitimately take longer than the 1-second
\t// timeout below. If we left this unbuffered, the worker would block forever
\t// on the done-send once the timeout fired, leaking a goroutine per
\t// timed-out message.''', '''\t// Non-macro handlers can still exceed the watchdog. Buffering lets their
\t// worker finish after the waiter times out, without leaking a goroutine.''')
replace('hidrpc.go', '''\t\t// Downgrade the timeout log for keyboard-macro messages: with blocking
\t\t// backpressure from the shallow macroQueue, enqueue taking >1s is an
\t\t// expected, benign signal that the backend is absorbing flow control,
\t\t// not a fault.
\t\tif message.Type() == hidrpc.TypeKeyboardMacroReport {
\t\t\tscopedLogger.Debug().Msg("HID RPC keyboard-macro handler took >1s (backpressure)")
\t\t} else {
\t\t\tscopedLogger.Warn().Msg("HID RPC message timed out")
\t\t}''', '\t\tscopedLogger.Warn().Msg("HID RPC message timed out")')

replace('ui/src/utils/pasteBatches.ts', '  reliable: deriveProfile(128, 20),\n', '  reliable: deriveProfile(128, 20),\n  slow: deriveProfile(128, 45),\n')
replace('ui/src/utils/pasteBatches.ts', '''// Profile pacing is uniform per keystroke: the backend deadline-paces each
// wire step, so a plain character costs exactly (5ms press + keyDelayMs reset).
//
// Diagnostic host-capacity probe (2026-09-04):
//   reliable: 5+20 = 25ms/char = 40 chars/sec. This deliberately changes only
//             the per-key reset delay; the 128-step batch cap, transport,
//             chunking, and backend execution path remain unchanged. If this
//             rate is clean while the previous 5+6 = 11ms/char (~91 cps) rate
//             garbles, the receiving host/application's variable input ceiling
//             is implicated rather than raw USB throughput.
//   fast:     5+2 = 7ms/char ~= 143 chars/sec. Retained unchanged as a control.
//
// This is diagnostic tuning, not a claimed permanent production default. Keep
// it isolated until the same corpus has been compared before and after host
// restart/quiescence under otherwise identical conditions.''', '''// Configured maximum rates for ordinary characters (5ms press + reset):
// Reliable ~40 cps, Slow ~20 cps, Fast ~143 cps. Modified keys hold for 10ms;
// composed characters may need multiple steps. USB writes and scheduling add
// time. Paste pacing never catches up by shortening a subsequent phase.
// Robert reported clean use of PR #104 at 40 cps; that is not an exhaustive
// hardware certification. See docs/paste-reliability.md for evidence limits.''')
append('ui/src/utils/pasteBatches.ts', '''// Repair must not be faster than the failed delivery. Invalid debug delays use
// the encoder's 25ms fallback; the repair floor remains the Slow profile.
export function getPasteRepairDelayMs(activeDelayMs: number): number {
  const active = Number.isFinite(activeDelayMs) && activeDelayMs > 0 ? activeDelayMs : 25;
  return Math.max(PASTE_PROFILES.slow.keyDelayMs, active);
}
''')
replace('ui/src/utils/pasteBatches.test.ts', 'import { PASTE_PROFILES } from "./pasteBatches";', 'import { PASTE_PROFILES, getPasteRepairDelayMs } from "./pasteBatches";')
replace('ui/src/utils/pasteBatches.test.ts', 'isolates the host-capacity probe to Reliable pacing', 'keeps conservative Reliable pacing and unchanged Fast configuration')
append('ui/src/utils/pasteBatches.test.ts', '''describe("Slow and repair pacing", () => {
  test("keeps the 128-step Slow cap reachable and offers 20 cps nominally", () => {
    expect(PASTE_PROFILES.slow).toEqual({ maxStepsPerBatch: 128, maxBytesPerBatch: 2318, keyDelayMs: 45 });
    expect(1000 / (5 + PASTE_PROFILES.slow.keyDelayMs)).toBe(20);
  });
  test.each([2, 20, 45, 80, 0, NaN])("repair never speeds up delay %s", delay => {
    expect(getPasteRepairDelayMs(delay)).toBe(Number.isFinite(delay) && delay > 45 ? delay : 45);
  });
});
''')
replace('ui/src/utils/pasteMacro.ts', '  autoThresholdChars: 5000,\n  chunkChars: 5000,', '  autoThresholdChars: 1024,\n  chunkChars: 1024,')
replace('ui/src/utils/pasteMacro.ts', '''  // 2000ms when chunks were burst-shaped (the pause was the target's
  // catch-up window). With uniform deadline pacing at measured-safe rates
  // (2026-06-09 spec) the host never accumulates backlog, so the pause is
  // only boundary-jitter insurance. On a 100k-char paste (20 chunks) the
  // old value added ~38s of pure dead time.''', '''  // A small boundary pause supplements per-phase pacing. Neither this pause
  // nor backend drain proves that the target application received the text.''')
replace('ui/src/hooks/useHidRpc.ts', '      sendHidRpcMessage(\n', '      return sendHidRpcMessage(\n')
replace('ui/src/hooks/useHidRpc.ts', '      sendMessage(new KeyboardMacroReportMessage(isPaste, steps.length, steps));', '      return sendMessage(new KeyboardMacroReportMessage(isPaste, steps.length, steps));')
replace('ui/src/hooks/useKeyboard.ts', 'import { sleep } from "@/utils";', 'import { sleep } from "@/utils";\nimport { getPasteRepairDelayMs } from "@/utils/pasteBatches";')
replace('ui/src/hooks/useKeyboard.ts', '      sendKeyboardMacroEventHidRpc(macro, isPaste);', '''      if (!sendKeyboardMacroEventHidRpc(macro, isPaste)) {
        throw new Error("Keyboard macro was not sent: HID RPC is not ready");
      }''')
replace('ui/src/hooks/useKeyboard.ts', '''      if (executePasteTextInFlight) {
        throw new Error("A paste is already in progress");
      }
      executePasteTextInFlight = true;''', '''      if (executePasteTextInFlight) {
        throw new Error("A paste is already in progress");
      }
      // Profile pacing is implemented on the device. Do not silently replace
      // it with legacy JSON-RPC typing while HID is disabled or handshaking.
      if (!rpcHidReady) {
        throw new Error("Paste requires ready HID RPC; reconnect or wait for the handshake");
      }
      executePasteTextInFlight = true;''')
replace('ui/src/hooks/useKeyboard.ts', '''        const pasteStateSupportedForChannel =
          syncPasteStateSupportChannel(channel) || pasteStateSupportCapability;''', '''        const assertPasteChannel = () => {
          const current = useRTCStore.getState();
          if (channel.readyState !== "open" || current.rpcHidChannel !== channel ||
              current.hidRpcDisabled || current.rpcHidProtocolVersion === null) {
            throw new Error("Paste HID channel changed or became unavailable");
          }
        };
        assertPasteChannel();
        const pasteStateSupportedForChannel =
          syncPasteStateSupportChannel(channel) || pasteStateSupportCapability;''')
replace('ui/src/hooks/useKeyboard.ts', '''              const batch = batches[b];
              await executePasteMacro(batch);''', '''              assertPasteChannel();
              const batch = batches[b];
              await executePasteMacro(batch);''')
replace('ui/src/hooks/useKeyboard.ts', '''            drainResolve = resolve;
            drainReject = reject;''', '''            if (channel.readyState !== "open") {
              reject(new Error("Paste HID channel closed during backpressure"));
              return;
            }
            if (channel.bufferedAmount < PASTE_HIGH_WATERMARK) {
              resolve();
              return;
            }
            drainResolve = resolve;
            drainReject = reject;''')
replace('ui/src/hooks/useKeyboard.ts', '''        channel.addEventListener("bufferedamountlow", onLow);
        signal?.addEventListener("abort", onBufferedDrainAbort);''', '''        const onBufferedDrainChannelLoss = () => {
          const rejecter = drainReject;
          drainResolve = null;
          drainReject = null;
          rejecter?.(new Error("Paste HID channel closed during backpressure"));
        };
        channel.addEventListener("bufferedamountlow", onLow);
        channel.addEventListener("close", onBufferedDrainChannelLoss);
        channel.addEventListener("error", onBufferedDrainChannelLoss);
        signal?.addEventListener("abort", onBufferedDrainAbort);''')
replace('ui/src/hooks/useKeyboard.ts', '''          channel.removeEventListener("bufferedamountlow", onLow);
          signal?.removeEventListener("abort", onBufferedDrainAbort);''', '''          channel.removeEventListener("bufferedamountlow", onLow);
          channel.removeEventListener("close", onBufferedDrainChannelLoss);
          channel.removeEventListener("error", onBufferedDrainChannelLoss);
          signal?.removeEventListener("abort", onBufferedDrainAbort);''')
replace('ui/src/hooks/useKeyboard.ts', '''                const drainAfterRepair = () =>
                  waitForPasteDrain(
                    "required",
                    chunkDrainTimeoutMs,''', '''                const slowRepairDelayMs = getPasteRepairDelayMs(delayMs);
                const repairDrainTimeoutMs = estimatePasteDrainTimeoutMs(
                  batchStats.slice(chunk.batchStartIndex, chunk.batchEndIndex),
                  slowRepairDelayMs,
                  policy.chunkDrainTimeoutFloorMs,
                );
                const drainAfterRepair = () =>
                  waitForPasteDrain(
                    "required",
                    repairDrainTimeoutMs,''')
replace('ui/src/hooks/useKeyboard.ts', '''                // Repair typing runs SLOW (≈40 cps: 5ms press + 20ms reset),
                // not at the paste's profile rate. The whole point of repair
                // is to recover from loss; re-typing at the same rate that
                // just lost characters re-loses ~as many and never converges.
                // A near-lossless slow re-type converges in one pass. Repairs
                // are rare (only lossy chunks), so the slowdown is bounded.
                const SLOW_REPAIR_DELAY_MS = 20;''', '''                // Repair is opt-in and bounded by the caller. It must never
                // accelerate relative to the selected mode; convergence is
                // not guaranteed and count checks do not verify content.''')
replace('ui/src/hooks/useKeyboard.ts', 'SLOW_REPAIR_DELAY_MS', 'slowRepairDelayMs', 2)
replace('ui/src/hooks/useKeyboard.ts', '''  // IMPORTANT: See the keyPressReportApiAvailable comment above for the reason this exists
  function simulateDeviceSideKeyHandlingForLegacyDevices(''', '''  // Browser focus changes must not inject an all-clear into an active paste
  // press. The macro owns release; explicit cancel/error safety paths remain
  // independent. Always stop the interactive keepalive on browser blur.
  const resetKeyboardStateOnBlur = useCallback(async () => {
    cancelKeepAlive();
    if (executePasteTextInFlight || useHidStore.getState().isPasteInProgress) return;
    await resetKeyboardState();
  }, [cancelKeepAlive, resetKeyboardState]);

  // IMPORTANT: See the keyPressReportApiAvailable comment above for the reason this exists
  function simulateDeviceSideKeyHandlingForLegacyDevices(''')
replace('ui/src/hooks/useKeyboard.ts', '    resetKeyboardState,\n    executeMacro,', '    resetKeyboardState,\n    resetKeyboardStateOnBlur,\n    executeMacro,')
replace('ui/src/components/WebRTCVideo.tsx', 'resetKeyboardState', 'resetKeyboardStateOnBlur', 4)

replace('ui/src/components/popovers/PasteModal.tsx', '    description: "Smaller batches with target catch-up pacing.",', '    description: "Up to about 40 cps; conservative default.",')
replace('ui/src/components/popovers/PasteModal.tsx', '  {\n    value: "fast",', '''  {
    value: "slow",
    label: "Slow",
    description: "Up to about 20 cps for difficult targets.",
    Icon: LuShieldCheck,
    selectedClassName:
      "border-blue-500/70 bg-blue-50 text-blue-950 shadow-xs dark:border-blue-400/60 dark:bg-blue-950/30 dark:text-blue-100",
    iconClassName: "text-blue-600 dark:text-blue-300",
  },
  {
    value: "fast",''')
replace('ui/src/components/popovers/PasteModal.tsx', '    description: "Larger batches for devices already validated.",', '    description: "Opt-in for validated targets; delivery can lose text.",')
replace('ui/src/components/popovers/PasteModal.tsx', 'className="grid grid-cols-1 gap-2 sm:grid-cols-2"', 'className="grid grid-cols-1 gap-2 sm:grid-cols-3"')
replace('ui/src/components/popovers/PasteModal.tsx', '          chunkCharsOverride: autoVerify ? 1500 : undefined,', '          chunkCharsOverride: autoVerify ? DEFAULT_LARGE_PASTE_POLICY.chunkChars : undefined,')
replace('ui/src/components/popovers/PasteModal.tsx', '''          `profile=${pasteProfile} source=${selectedFile ? `file:${selectedFile.name}` : "textarea"} chars=${totalChars}${startOffset > 0 ? ` resume_from=${startOffset}` : ""}`,''', '''          `profile=${pasteProfile} source=${selectedFile ? `file:${selectedFile.name}` : "textarea"} chars=${totalChars}${startOffset > 0 ? ` resume_from=${startOffset}` : ""}`,
          `transport=hidrpc-required reset_gap_ms=${effectiveDelay || 25} press_ms=5 modified_press_ms=10 debug_override=${debugMode} batch_steps=${profile.maxStepsPerBatch} chunk_chars=${DEFAULT_LARGE_PASTE_POLICY.chunkChars}`,
          "completion=backend-drain-only; target content requires readback",''')
replace('ui/src/components/popovers/PasteModal.tsx', '''                  return `${chars.toLocaleString()} characters — ≈${reliableEta} on Reliable, ≈${fastEta} on Fast`;''', '''                  const slowEta = formatDuration(
                    estimatePasteSeconds(chars, PASTE_PROFILES.slow.keyDelayMs),
                  );
                  return `${chars.toLocaleString()} characters — nominal minimum: ${reliableEta} Reliable, ${slowEta} Slow, ${fastEta} Fast; modified keys, USB and verification add time`;''')
replace('ui/src/components/popovers/PasteModal.tsx', '''// Uniform deadline pacing makes paste time deterministic: (5ms press +
// keyDelayMs reset) per char, plus inter-chunk pauses and ~2s of wake-tap/
// settle overhead. See the 2026-06-09 throughput spec.''', '''// Nominal ordinary-character estimate only. Modified/composed characters,
// USB write time, scheduling and verification increase actual duration.''')

replace('ui/src/automation/paste.ts', '    const terminal = Promise.withResolvers<AutomationPasteResult>();', '''    const minimumTypingMs = build.batches.reduce(
      (total, batch) => total + encodeBatch(batch).reduce((ms, step) => ms + step.delay, 0),
      0,
    );
    if (minimumTypingMs >= timeoutMs) {
      // No bytes or acceptance callback: splitting is the caller's decision.
      // Real USB/scheduler overhead may still exhaust a larger budget.
      throw new PasteTransportFailure("DEADLINE_EXCEEDED");
    }

    const terminal = Promise.withResolvers<AutomationPasteResult>();''')
replace('ui/src/automation/paste.test.ts', '''      "a".repeat(129),
      new AbortController().signal,
      () => undefined,
      1000,''', '''      "a".repeat(129),
      new AbortController().signal,
      () => undefined,
      10000,''')
append('ui/src/automation/paste.test.ts', '''describe("paste deadline admission", () => {
  it.each(["a".repeat(12000), "A".repeat(10000)])("rejects an impossible 300-second paste before sending", async text => {
    const channel = new FakePasteChannel();
    const transport = new ProductReliablePasteTransport(channel, keyboard);
    const accepted = vi.fn();
    await expect(transport.execute(text, new AbortController().signal, accepted, 300000))
      .rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(channel.writes).toHaveLength(0);
    expect(accepted).not.toHaveBeenCalled();
    transport.close();
  });
});
''')
replace('.github/workflows/jetkvm-mcp-foundation.yml', '      - name: Run UI Phase 3 focused gate\n        run: npm run test:phase3', '      - name: Run complete UI unit suite\n        run: npm run test:unit')
replace('.github/workflows/jetkvm-mcp-foundation.yml', 'run: go test -race -tags=hosttest . ./internal/atx ./internal/native ./internal/controlsession ./internal/usbgadget', 'run: go test -race -tags=hosttest . ./internal/atx ./internal/native ./internal/controlsession ./internal/usbgadget ./internal/pastepacing ./internal/regression')

replace('CLAUDE.md', '## Verification (no unit test framework)', '## Verification')
replace('CLAUDE.md', '''Frontend has no vitest/jest — verify changes with:

```bash
cd ui && npx tsc --noEmit && npx eslint './src/**/*.{ts,tsx}'
```''', '''The UI has Vitest. Run the complete unit suite and typecheck:

```bash
cd ui && npm ci && npm run test:unit && npm run typecheck
```

For paste work, use `docs/paste-reliability.md` as the current contract. Host-safe
Go tests use `go test -race -tags=hosttest . ./internal/pastepacing
./internal/controlsession ./internal/usbgadget ./internal/regression` (one command).''')
replace('CLAUDE.md', '''- **`ui-lint` CI has been failing on main since 2026-03-15** (pre-existing drift in `Button.tsx`, `PasteModal.tsx`, `pasteMacro.ts`, `stores.ts`). `golangci-lint` is the real merge gate. Don't block on ui-lint red.''', '''- **Check the current CI result, not a historical exemption.** Attribute failures
  against the base branch before calling them pre-existing. Do not ignore a red
  check or weaken tests to make a paste change appear validated.''')
replace('CLAUDE.md', '''- **`rpcDoExecuteKeyboardMacro` uses absolute-deadline pacing** — per-step `timer.Reset(delay)`-after-write accumulates ~1ms/step overshoot (~20% rate error). Don't revert to sleep-after-write; profile rates are calibrated as exact.''', '''- **Paste pacing must not catch up after lateness.** `rpcDoExecutePasteMacro`
  preserves minimum post-write delays through `internal/pastepacing`; rates are
  upper bounds, not exact throughput guarantees. The older deadline scheduler
  remains only for non-paste macros.''')
replace('CLAUDE.md', '''- **`waitForPasteDrain("required", ...)` ships with zero call sites** — reserved for #38 Phase 2 chunk boundaries. Don't delete as dead code.''', '''- **`waitForPasteDrain("required", ...)` is active** at chunk and repair
  boundaries. Preserve paste-depth edges and cancellation; backend completion
  must never be presented as target-content verification.''')
replace('CLAUDE.md', 'Paste macros are uniformly deadline-paced per-step at measured-safe rates;', 'Paste macros preserve minimum per-step spacing without catch-up;')
replace('CLAUDE.md', '## Phased paste patch rollout', '## Historical phased paste patch rollout (not current status)')
for path in ['docs/superpowers/specs/2026-06-09-paste-throughput-ceiling-investigation.md', 'docs/tickets/PASTE-002.md', 'docs/tickets/PASTE-008.md']:
    p = Path(path)
    notice = '> Historical record: preserve these measurements, but use `docs/paste-reliability.md` for current configuration and evidence limits. Claims below of exact timing, universal losslessness, or exclusive host-layer attribution are not current guarantees.\n\n'
    p.write_text(notice + p.read_text())
    record(path)

# No deployment, merge, workflow-setting or secret changes. Only the explicit
# manifest is committed after automated tests pass, without force push.
Path('.github/paste-hardening-bootstrap.py').unlink()
Path('.github/workflows/paste-hardening-bootstrap.yml').unlink()
