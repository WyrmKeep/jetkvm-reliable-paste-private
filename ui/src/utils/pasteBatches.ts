interface PasteProfile {
  maxStepsPerBatch: number;
  maxBytesPerBatch: number;
  keyDelayMs: number;
}

export const PASTE_PROFILES = {
  reliable: { maxStepsPerBatch: 128, maxBytesPerBatch: 1200, keyDelayMs: 3 },
  fast: { maxStepsPerBatch: 320, maxBytesPerBatch: 1100, keyDelayMs: 2 },
} satisfies Record<string, PasteProfile>;

export type PasteProfileName = keyof typeof PASTE_PROFILES;
