import { describe, expect, test } from "vitest";

import {
  buildPasteMacroBatches,
  buildPasteMacroSteps,
  type KeyboardLayoutLike,
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

describe("paste macro building", () => {
  test("normalizes whole input before splitting into macro steps", () => {
    const nfc = buildPasteMacroSteps("Caf\u00e9A@^", keyboard, 7);
    const nfd = buildPasteMacroSteps("Cafe\u0301A@^", keyboard, 7);

    expect(nfd.invalidChars).toEqual([]);
    expect(nfd.steps).toEqual(nfc.steps);
  });

  test("normalizes whole input before splitting into batches", () => {
    const nfc = buildPasteMacroBatches("Caf\u00e9A@^", keyboard, 7, 4, 78);
    const nfd = buildPasteMacroBatches("Cafe\u0301A@^", keyboard, 7, 4, 78);

    expect(nfd.invalidChars).toEqual([]);
    expect(nfd.batches).toEqual(nfc.batches);
    expect(nfd.batchStats).toEqual(nfc.batchStats);
  });

  test("reuses modifier arrays for repeated modifier combinations", () => {
    const { steps } = buildPasteMacroSteps("AA@@", keyboard, 7);

    expect(steps[0].modifiers).toEqual(["ShiftLeft"]);
    expect(steps[0].modifiers).toBe(steps[1].modifiers);
    expect(steps[2].modifiers).toEqual(["AltRight"]);
    expect(steps[2].modifiers).toBe(steps[3].modifiers);
  });
});
