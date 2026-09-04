import { estimateBatchBytes } from "./pasteMacro";

interface PasteProfile {
  maxStepsPerBatch: number;
  maxBytesPerBatch: number;
  keyDelayMs: number;
}

const HEADROOM_BYTES = 8;

function deriveProfile(maxStepsPerBatch: number, keyDelayMs: number): PasteProfile {
  return {
    maxStepsPerBatch,
    maxBytesPerBatch: estimateBatchBytes(maxStepsPerBatch) + HEADROOM_BYTES,
    keyDelayMs,
  };
}

function assertProfilesReachable(profiles: Record<string, PasteProfile>): void {
  for (const [name, p] of Object.entries(profiles)) {
    if (!Number.isFinite(p.maxStepsPerBatch) || p.maxStepsPerBatch <= 0) {
      throw new Error(
        `PASTE_PROFILES["${name}"]: maxStepsPerBatch must be a positive finite number ` +
          `(got ${p.maxStepsPerBatch})`,
      );
    }
    if (!Number.isFinite(p.maxBytesPerBatch) || p.maxBytesPerBatch <= 0) {
      throw new Error(
        `PASTE_PROFILES["${name}"]: maxBytesPerBatch must be a positive finite number ` +
          `(got ${p.maxBytesPerBatch})`,
      );
    }
    if (!Number.isFinite(p.keyDelayMs)) {
      throw new Error(
        `PASTE_PROFILES["${name}"]: keyDelayMs must be a finite number ` + `(got ${p.keyDelayMs})`,
      );
    }
    const bytesAtCap = estimateBatchBytes(p.maxStepsPerBatch);
    if (bytesAtCap > p.maxBytesPerBatch) {
      throw new Error(
        `PASTE_PROFILES["${name}"]: step cap unreachable ` +
          `(${p.maxStepsPerBatch} steps = ${bytesAtCap} bytes, ` +
          `byte cap = ${p.maxBytesPerBatch} bytes)`,
      );
    }
  }
}

// Profile pacing is uniform per keystroke: the backend deadline-paces each
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
// restart/quiescence under otherwise identical conditions.
export const PASTE_PROFILES = {
  reliable: deriveProfile(128, 20),
  fast: deriveProfile(256, 2),
} satisfies Record<string, PasteProfile>;

assertProfilesReachable(PASTE_PROFILES);

export type PasteProfileName = keyof typeof PASTE_PROFILES;
