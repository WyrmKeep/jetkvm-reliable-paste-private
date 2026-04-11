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

export const PASTE_PROFILES = {
  reliable: deriveProfile(128, 3),
  fast: deriveProfile(256, 2),
} satisfies Record<string, PasteProfile>;

assertProfilesReachable(PASTE_PROFILES);

export type PasteProfileName = keyof typeof PASTE_PROFILES;
