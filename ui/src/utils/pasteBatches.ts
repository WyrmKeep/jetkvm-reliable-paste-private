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
// wire step, so a char costs exactly (5ms press + keyDelayMs reset).
// Rates were measured against a Win11 Notepad target on 2026-06-09 (see
// docs/superpowers/specs/2026-06-09-paste-throughput-ceiling-investigation.md):
//   reliable: 5+6 = 11ms/char ≈ 91 chars/sec — zero loss across all
//             measured runs (multiple 2448-key sustained runs); 100 cps was
//             also mostly clean but showed rare ~0.04% drops under host
//             load, so reliable keeps margin below it. Matches the OLD
//             pipeline's average throughput while removing its burst shape
//             (bursts were the actual cause of loss).
//   fast:     5+2 = 7ms/char ≈ 143 chars/sec — at the loss threshold of slow
//             sinks (Win11 Notepad was measured losing keys from ~125 cps);
//             fine for faster consumers. Loss is host-app-layer and invisible
//             to USB-level feedback, so there is no closed-loop guard here.
export const PASTE_PROFILES = {
  reliable: deriveProfile(128, 6),
  fast: deriveProfile(256, 2),
} satisfies Record<string, PasteProfile>;

assertProfilesReachable(PASTE_PROFILES);

export type PasteProfileName = keyof typeof PASTE_PROFILES;
