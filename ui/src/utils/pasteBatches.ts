import type { MacroStep } from "@/hooks/useKeyboard";

export interface PasteBatchProfile {
  maxCharsPerBatch: number;
  keyDelayMs: number;
  batchPauseMs: number;
}

export const PASTE_PROFILES = {
  reliable: {
    maxCharsPerBatch: 32,
    keyDelayMs: 35,
    batchPauseMs: 120,
  },
  fast: {
    maxCharsPerBatch: 96,
    keyDelayMs: 20,
    batchPauseMs: 60,
  },
} satisfies Record<string, PasteBatchProfile>;

export type PasteProfileName = keyof typeof PASTE_PROFILES;

export function chunkPasteText(text: string, maxCharsPerBatch: number): string[] {
  if (!text) return [];
  if (maxCharsPerBatch <= 0) {
    throw new Error("maxCharsPerBatch must be greater than zero");
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxCharsPerBatch) {
    chunks.push(text.slice(index, index + maxCharsPerBatch));
  }
  return chunks;
}

export interface BatchProgress {
  completedBatches: number;
  totalBatches: number;
  currentBatchText: string;
}

export async function runPasteBatches(
  batches: MacroStep[][],
  executeBatch: (batch: MacroStep[]) => Promise<void>,
  options: {
    batchPauseMs?: number;
    onProgress?: (progress: BatchProgress) => void;
  } = {},
): Promise<void> {
  const { batchPauseMs = 0, onProgress } = options;

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    await executeBatch(batch);
    onProgress?.({
      completedBatches: index + 1,
      totalBatches: batches.length,
      currentBatchText: "",
    });

    if (batchPauseMs > 0 && index < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, batchPauseMs));
    }
  }
}
