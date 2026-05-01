import { bench, describe } from "vitest";

import type { MacroStep } from "@/hooks/useKeyboard";

import {
  buildPasteMacroBatches,
  estimateBatchBytes,
  type KeyboardLayoutLike,
  type PasteBatchStat,
  type PasteMacroBatchResult,
} from "./pasteMacro";

const keyboard: KeyboardLayoutLike = {
  chars: {
    C: { key: "KeyC", shift: true },
    a: { key: "KeyA" },
    f: { key: "KeyF" },
    e: { key: "KeyE" },
    "\u00e9": { key: "KeyE", accentKey: { key: "Quote" } },
    A: { key: "KeyA", shift: true },
    "@": { key: "Digit2", altRight: true },
    "^": { key: "Equal", deadKey: true },
  },
};

const largePaste = "Cafe\u0301A@^".repeat(2000);

describe("paste macro hot path", () => {
  bench("optimized buildPasteMacroBatches large mixed input", () => {
    buildPasteMacroBatches(largePaste, keyboard, 7, 128, 2310);
  });

  bench("legacy buildPasteMacroBatches large mixed input", () => {
    buildPasteMacroBatchesLegacy(largePaste, keyboard, 7, 128, 2310);
  });
});

function buildPasteMacroBatchesLegacy(
  text: string,
  keyboard: KeyboardLayoutLike,
  delay: number,
  maxStepsPerBatch: number,
  maxBytesPerBatch: number,
): PasteMacroBatchResult {
  const batches = [] as ReturnType<typeof buildPasteMacroBatches>["batches"];
  const batchStats: PasteBatchStat[] = [];
  const invalidChars = new Set<string>();
  let currentBatch = [] as ReturnType<typeof buildPasteMacroBatches>["batches"][number];
  let currentBatchSourceChars = 0;

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

  for (const char of text) {
    const normalizedChar = char.normalize("NFC");
    const charSteps = buildStepsForCharLegacy(normalizedChar, keyboard, delay);
    if (!charSteps) {
      invalidChars.add(normalizedChar);
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

    currentBatch.push(...charSteps);
    currentBatchSourceChars += 1;
  }

  flushBatch();

  return {
    batches,
    invalidChars: Array.from(invalidChars),
    batchStats,
  };
}

function buildStepsForCharLegacy(
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
    const accentModifiers: string[] = [];
    if (accentKey.shift) accentModifiers.push("ShiftLeft");
    if (accentKey.altRight) accentModifiers.push("AltRight");

    steps.push({
      keys: [String(accentKey.key)],
      modifiers: accentModifiers.length > 0 ? accentModifiers : null,
      delay,
    });
  }

  const modifiers: string[] = [];
  if (shift) modifiers.push("ShiftLeft");
  if (altRight) modifiers.push("AltRight");

  steps.push({
    keys: [String(key)],
    modifiers: modifiers.length > 0 ? modifiers : null,
    delay,
  });

  if (deadKey) {
    steps.push({ keys: ["Space"], modifiers: null, delay });
  }

  return steps;
}
