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
    keyDelayMs: 3,
    batchPauseMs: 0,
  },
  fast: {
    maxStepsPerBatch: 320,
    maxBytesPerBatch: 1100,
    keyDelayMs: 2,
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
  appliedPauseMs?: number;
  tailMode?: boolean;
  stressMode?: boolean;
}

export async function runPasteBatches(
  batches: MacroStep[][],
  executeBatch: (batch: MacroStep[]) => Promise<void>,
  options: {
    batchPauseMs?: number;
    finalSettleMs?: number;
    tailBatchCount?: number;
    tailPauseMs?: number;
    longRunThreshold?: number;
    longRunPauseMs?: number;
    stressDurationMs?: number;
    stressPauseMs?: number;
    signal?: AbortSignal;
    batchStats?: Array<{ stepCount: number; estimatedBytes: number }>;
    onProgress?: (progress: BatchProgress) => void;
    onTrace?: (entry: PasteTraceEntry) => void;
  } = {},
): Promise<void> {
  const {
    batchPauseMs = 0,
    finalSettleMs = 0,
    tailBatchCount = 0,
    tailPauseMs = 0,
    longRunThreshold = Number.POSITIVE_INFINITY,
    longRunPauseMs = 0,
    stressDurationMs = Number.POSITIVE_INFINITY,
    stressPauseMs = 0,
    signal,
    batchStats = [],
    onProgress,
    onTrace,
  } = options;

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

    const batchesRemaining = batches.length - (index + 1);
    const tailMode = tailBatchCount > 0 && batchesRemaining < tailBatchCount;
    const longRunMode = index + 1 >= longRunThreshold;
    const stressMode = (trace.durationMs ?? 0) >= stressDurationMs;
    const appliedPauseMs = Math.max(
      batchPauseMs,
      tailMode ? tailPauseMs : 0,
      longRunMode ? longRunPauseMs : 0,
      stressMode ? stressPauseMs : 0,
    );

    trace.tailMode = tailMode;
    trace.stressMode = stressMode;
    trace.appliedPauseMs = appliedPauseMs;
    onTrace?.(trace);

    onProgress?.({
      completedBatches: index + 1,
      totalBatches: batches.length,
    });

    if (appliedPauseMs > 0 && index < batches.length - 1) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, appliedPauseMs);
        const abortHandler = () => {
          clearTimeout(timeout);
          reject(new Error("Paste execution aborted"));
        };

        signal?.addEventListener("abort", abortHandler, { once: true });
      });
    }
  }

  if (finalSettleMs > 0) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, finalSettleMs);
      const abortHandler = () => {
        clearTimeout(timeout);
        reject(new Error("Paste execution aborted"));
      };

      signal?.addEventListener("abort", abortHandler, { once: true });
    });
  }
}
