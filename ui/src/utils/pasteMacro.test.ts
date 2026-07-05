import { describe, expect, test } from "vitest";

import {
  buildPasteMacroBatches,
  buildPasteMacroSteps,
  estimatePasteDrainTimeoutMs,
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

  test("derives final paste-drain timeout from total queued paste work", () => {
    const timeoutMs = estimatePasteDrainTimeoutMs(
      [
        { stepCount: 128, estimatedBytes: 2310, sourceChars: 128 },
        { stepCount: 112, estimatedBytes: 2022, sourceChars: 112 },
      ],
      6,
      3000,
    );

    expect(timeoutMs).toBe(11080);
    expect(timeoutMs).toBeGreaterThan(3000);
  });

  test("uses the macro reset-delay fallback when estimating paste-drain timeout", () => {
    const batchStats = [{ stepCount: 4, estimatedBytes: 78, sourceChars: 4 }];

    expect(estimatePasteDrainTimeoutMs(batchStats, 0, 3000)).toBe(
      estimatePasteDrainTimeoutMs(batchStats, 25, 3000),
    );
    expect(estimatePasteDrainTimeoutMs(batchStats, Number.NaN, 3000)).toBe(
      estimatePasteDrainTimeoutMs(batchStats, 25, 3000),
    );
  });

  test("keeps empty paste-drain timeout at the caller floor", () => {
    expect(estimatePasteDrainTimeoutMs([], 6, 3000)).toBe(3000);
  });
});
