import type { MacroStep } from "@/hooks/useKeyboard";

export interface PasteBatchProfile {
  maxStepsPerBatch: number;
  maxBytesPerBatch: number;
  keyDelayMs: number;
  batchPauseMs: number;
}

export const PASTE_PROFILES = {
  reliable: {
    maxStepsPerBatch: 128,
    maxBytesPerBatch: 1200,
    keyDelayMs: 10,
    batchPauseMs: 0,
  },
  fast: {
    maxStepsPerBatch: 448,
    maxBytesPerBatch: 1400,
    keyDelayMs: 3,
    batchPauseMs: 0,
  },
} satisfies Record<string, PasteBatchProfile>;

export type PasteProfileName = keyof typeof PASTE_PROFILES;

export interface BatchProgress {
  completedBatches: number;
  totalBatches: number;
}

export interface PasteTraceEntry {
  batchIndex: number;
  totalBatches: number;
  stepCount: number;
  estimatedBytes: number;
  submittedAt: number;
  completedAt?: number;
  durationMs?: number;
}

export async function runPasteBatches(
  batches: MacroStep[][],
  executeBatch: (batch: MacroStep[]) => Promise<void>,
  options: {
    batchPauseMs?: number;
    signal?: AbortSignal;
    batchStats?: Array<{ stepCount: number; estimatedBytes: number }>;
    onProgress?: (progress: BatchProgress) => void;
    onTrace?: (entry: PasteTraceEntry) => void;
  } = {},
): Promise<void> {
  const { batchPauseMs = 0, signal, batchStats = [], onProgress, onTrace } = options;

  for (let index = 0; index < batches.length; index += 1) {
    if (signal?.aborted) {
      throw new Error("Paste execution aborted");
    }

    const batch = batches[index];
    const trace: PasteTraceEntry = {
      batchIndex: index + 1,
      totalBatches: batches.length,
      stepCount: batchStats[index]?.stepCount ?? batch.length,
      estimatedBytes: batchStats[index]?.estimatedBytes ?? 0,
      submittedAt: Date.now(),
    };

    await executeBatch(batch);

    trace.completedAt = Date.now();
    trace.durationMs = trace.completedAt - trace.submittedAt;
    onTrace?.(trace);

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
