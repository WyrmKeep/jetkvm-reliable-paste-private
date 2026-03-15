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

export interface PasteMacroBuildResult {
  steps: MacroStep[];
  invalidChars: string[];
}

export interface PasteMacroBatchResult {
  batches: MacroStep[][];
  invalidChars: string[];
}

function buildStepsForChar(
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

export function buildPasteMacroSteps(
  text: string,
  keyboard: KeyboardLayoutLike,
  delay: number,
): PasteMacroBuildResult {
  const steps: MacroStep[] = [];
  const invalidChars = new Set<string>();

  for (const char of text) {
    const normalizedChar = char.normalize("NFC");
    const charSteps = buildStepsForChar(normalizedChar, keyboard, delay);
    if (!charSteps) {
      invalidChars.add(normalizedChar);
      continue;
    }

    steps.push(...charSteps);
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
): PasteMacroBatchResult {
  if (maxStepsPerBatch <= 0) {
    throw new Error("maxStepsPerBatch must be greater than zero");
  }

  const batches: MacroStep[][] = [];
  const invalidChars = new Set<string>();
  let currentBatch: MacroStep[] = [];

  for (const char of text) {
    const normalizedChar = char.normalize("NFC");
    const charSteps = buildStepsForChar(normalizedChar, keyboard, delay);
    if (!charSteps) {
      invalidChars.add(normalizedChar);
      continue;
    }

    if (currentBatch.length > 0 && currentBatch.length + charSteps.length > maxStepsPerBatch) {
      batches.push(currentBatch);
      currentBatch = [];
    }

    currentBatch.push(...charSteps);
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return {
    batches,
    invalidChars: Array.from(invalidChars),
  };
}
