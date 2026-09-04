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

// Configured maximum rates for ordinary characters (5ms press + reset):
// Reliable ~40 cps, Slow ~20 cps, Fast ~143 cps. Modified keys hold for 10ms;
// composed characters may need multiple steps. USB writes and scheduling add
// time. Paste pacing never catches up by shortening a subsequent phase.
// Robert reported clean use of PR #104 at 40 cps; that is not an exhaustive
// hardware certification. See docs/paste-reliability.md for evidence limits.
export const PASTE_PROFILES = {
  reliable: deriveProfile(128, 20),
  slow: deriveProfile(128, 45),
  fast: deriveProfile(256, 2),
} satisfies Record<string, PasteProfile>;

assertProfilesReachable(PASTE_PROFILES);

export type PasteProfileName = keyof typeof PASTE_PROFILES;

// Repair must not be faster than the failed delivery. Invalid debug delays use
// the encoder's 25ms fallback; the repair floor remains the Slow profile.
export function getPasteRepairDelayMs(activeDelayMs: number): number {
  const active = Number.isFinite(activeDelayMs) && activeDelayMs > 0 ? activeDelayMs : 25;
  return Math.max(PASTE_PROFILES.slow.keyDelayMs, active);
}
