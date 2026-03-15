import type { MacroStep } from "@/hooks/useKeyboard";

type KeyboardCharMapping = {
  key?: string;
  shift?: boolean;
  altRight?: boolean;
  deadKey?: boolean;
  accentKey?: {
    key: string;
    shift?: boolean;
    altRight?: boolean;
  };
};

export interface KeyboardLayoutLike {
  chars: Record<string, KeyboardCharMapping | undefined>;
}

export interface PasteMacroBuildResult {
  steps: MacroStep[];
  invalidChars: string[];
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
    const keyprops = keyboard.chars[normalizedChar];
    if (!keyprops || !keyprops.key) {
      invalidChars.add(normalizedChar);
      continue;
    }

    const { key, shift, altRight, deadKey, accentKey } = keyprops;

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
  }

  return {
    steps,
    invalidChars: Array.from(invalidChars),
  };
}
