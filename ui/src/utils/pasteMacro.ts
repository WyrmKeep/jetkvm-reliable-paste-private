import type { MacroStep } from "@/hooks/useKeyboard";

interface KeyboardCharMapping {
  key?: string;
  shift?: boolean;
  altRight?: boolean;
  deadKey?: boolean;
  accentKey?: {
    key: string;
    shift?: boolean;
    altRight?: boolean;
  };
}

export interface KeyboardLayoutLike {
  chars: Record<string, KeyboardCharMapping | undefined>;
}

const MODS_SHIFT = Object.freeze(["ShiftLeft"]);
const MODS_ALT_RIGHT = Object.freeze(["AltRight"]);
const MODS_SHIFT_ALT_RIGHT = Object.freeze(["ShiftLeft", "AltRight"]);

function pickModifiers(shift?: boolean, altRight?: boolean): MacroStep["modifiers"] {
  if (shift && altRight) return MODS_SHIFT_ALT_RIGHT as string[];
  if (shift) return MODS_SHIFT as string[];
  if (altRight) return MODS_ALT_RIGHT as string[];
  return null;
}

export interface PasteMacroBuildResult {
  steps: MacroStep[];
  invalidChars: string[];
}

export interface PasteBatchStat {
  stepCount: number;
  estimatedBytes: number;
  sourceChars: number;
}

export interface PasteMacroBatchResult {
  batches: MacroStep[][];
  invalidChars: string[];
  batchStats: PasteBatchStat[];
}

export function estimateBatchBytes(stepCount: number): number {
  // Wire-byte estimate for HID macro report:
  // 6-byte header + 18 bytes per MacroStep.
  // Each MacroStep expands to 2 KeyboardMacroSteps (press + reset)
  // in executeMacroRemote, and each KeyboardMacroStep is 9 bytes.
  return 6 + stepCount * 18;
}

export function buildStepsForChar(
  normalizedChar: string,
  keyboard: KeyboardLayoutLike,
  delay: number,
): MacroStep[] | null {
  const keyprops = keyboard.chars[normalizedChar];
  if (!keyprops || !keyprops.key) {
    return null;
  }

  const { key, shift, altRight, deadKey, accentKey } = keyprops;
  const steps: MacroStep[] = [];

  if (accentKey) {
    steps.push({
      keys: [String(accentKey.key)],
      modifiers: pickModifiers(accentKey.shift, accentKey.altRight),
      delay,
    });
  }

  steps.push({
    keys: [String(key)],
    modifiers: pickModifiers(shift, altRight),
    delay,
  });

  if (deadKey) {
    steps.push({ keys: ["Space"], modifiers: null, delay });
  }

  return steps;
}

export function buildPasteMacroSteps(
  text: string,
  keyboard: KeyboardLayoutLike,
  delay: number,
): PasteMacroBuildResult {
  const steps: MacroStep[] = [];
  const invalidChars = new Set<string>();
  const normalizedText = text.normalize("NFC");

  for (const char of normalizedText) {
    const charSteps = buildStepsForChar(char, keyboard, delay);
    if (!charSteps) {
      invalidChars.add(char);
      continue;
    }

    for (const step of charSteps) {
      steps.push(step);
    }
  }

  return {
    steps,
    invalidChars: Array.from(invalidChars),
  };
}

export function buildPasteMacroBatches(
  text: string,
  keyboard: KeyboardLayoutLike,
  delay: number,
  maxStepsPerBatch: number,
  maxBytesPerBatch: number,
): PasteMacroBatchResult {
  if (maxStepsPerBatch <= 0) {
    throw new Error("maxStepsPerBatch must be greater than zero");
  }
  if (maxBytesPerBatch <= 0) {
    throw new Error("maxBytesPerBatch must be greater than zero");
  }

  const batches: MacroStep[][] = [];
  const batchStats: PasteBatchStat[] = [];
  const invalidChars = new Set<string>();
  let currentBatch: MacroStep[] = [];
  let currentBatchSourceChars = 0;
  const normalizedText = text.normalize("NFC");

  const flushBatch = () => {
    if (currentBatch.length === 0) return;
    batches.push(currentBatch);
    batchStats.push({
      stepCount: currentBatch.length,
      estimatedBytes: estimateBatchBytes(currentBatch.length),
      sourceChars: currentBatchSourceChars,
    });
    currentBatch = [];
    currentBatchSourceChars = 0;
  };

  for (const char of normalizedText) {
    const charSteps = buildStepsForChar(char, keyboard, delay);
    if (!charSteps) {
      invalidChars.add(char);
      continue;
    }

    const projectedStepCount = currentBatch.length + charSteps.length;
    const projectedBytes = estimateBatchBytes(projectedStepCount);

    if (
      currentBatch.length > 0 &&
      (projectedStepCount > maxStepsPerBatch || projectedBytes > maxBytesPerBatch)
    ) {
      flushBatch();
    }

    for (const step of charSteps) {
      currentBatch.push(step);
    }
    currentBatchSourceChars += 1;
  }

  flushBatch();

  return {
    batches,
    invalidChars: Array.from(invalidChars),
    batchStats,
  };
}

export interface LargePastePolicy {
  autoThresholdChars: number;
  chunkChars: number;
  chunkPauseMs: number;
  // Floor for the per-chunk derived drain timeout. The actual timeout
  // used by waitForPasteDrain("required", ...) is computed inside
  // executePasteText from the chunk's step count and batch count, then
  // max'd against this floor. A flat timeout would be wrong: a
  // reliable-profile 5000-char chunk takes ~55s end-to-end on current
  // pacing, so the derivation gives each chunk ~2x its measured worst
  // case.
  chunkDrainTimeoutFloorMs: number;
}

export const DEFAULT_LARGE_PASTE_POLICY: LargePastePolicy = {
  autoThresholdChars: 5000,
  chunkChars: 5000,
  chunkPauseMs: 2000,
  chunkDrainTimeoutFloorMs: 60000,
};

export interface PasteChunkPlan {
  chunkIndex: number; // 0-based
  batchStartIndex: number; // inclusive
  batchEndIndex: number; // exclusive
  sourceChars: number;
}

export function partitionBatchesByChunkChars(
  batchStats: PasteBatchStat[],
  chunkChars: number,
): PasteChunkPlan[] {
  if (chunkChars <= 0) {
    throw new Error("chunkChars must be greater than zero");
  }
  if (batchStats.length === 0) {
    return [];
  }

  const chunks: PasteChunkPlan[] = [];
  let chunkIndex = 0;
  let chunkStart = 0;
  let chunkSourceChars = 0;

  for (let i = 0; i < batchStats.length; i++) {
    const batchChars = batchStats[i].sourceChars;
    // Commit the current chunk before starting a new one. This keeps
    // batches whole and aligns chunk boundaries to real batch edges —
    // we never split a batch in the middle. A single batch whose
    // sourceChars exceeds chunkChars becomes its own oversized chunk,
    // which is acceptable fallback behavior; the required drain still
    // runs at the chunk boundary.
    if (chunkSourceChars > 0 && chunkSourceChars + batchChars > chunkChars) {
      chunks.push({
        chunkIndex,
        batchStartIndex: chunkStart,
        batchEndIndex: i,
        sourceChars: chunkSourceChars,
      });
      chunkIndex += 1;
      chunkStart = i;
      chunkSourceChars = 0;
    }
    chunkSourceChars += batchChars;
  }

  // Flush the final chunk.
  chunks.push({
    chunkIndex,
    batchStartIndex: chunkStart,
    batchEndIndex: batchStats.length,
    sourceChars: chunkSourceChars,
  });

  return chunks;
}
