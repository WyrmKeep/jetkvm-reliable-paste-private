import type { MacroStep } from "@/hooks/useKeyboard";

export interface PasteBatchProfile {
  maxStepsPerBatch: number;
  keyDelayMs: number;
  batchPauseMs: number;
}

export const PASTE_PROFILES = {
  reliable: {
    maxStepsPerBatch: 128,
    keyDelayMs: 10,
    batchPauseMs: 0,
  },
  fast: {
    maxStepsPerBatch: 448,
    keyDelayMs: 3,
    batchPauseMs: 0,
  },
} satisfies Record<string, PasteBatchProfile>;

export type PasteProfileName = keyof typeof PASTE_PROFILES;

export interface BatchProgress {
  completedBatches: number;
  totalBatches: number;
}

export async function runPasteBatches(
  batches: MacroStep[][],
  executeBatch: (batch: MacroStep[]) => Promise<void>,
  options: {
    batchPauseMs?: number;
    signal?: AbortSignal;
    onProgress?: (progress: BatchProgress) => void;
  } = {},
): Promise<void> {
  const { batchPauseMs = 0, signal, onProgress } = options;

  for (let index = 0; index < batches.length; index += 1) {
    if (signal?.aborted) {
      throw new Error("Paste execution aborted");
    }

    const batch = batches[index];
    await executeBatch(batch);

    onProgress?.({
      completedBatches: index + 1,
      totalBatches: batches.length,
    });

    if (batchPauseMs > 0 && index < batches.length - 1) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, batchPauseMs);
        const abortHandler = () => {
          clearTimeout(timeout);
          reject(new Error("Paste execution aborted"));
        };

        signal?.addEventListener("abort", abortHandler, { once: true });
      });
    }
  }
}
