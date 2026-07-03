import { describe, expect, test } from "vitest";

import { buildKeyboardMacroStepsForText } from "./hidrpcClient.js";
import {
  compareTeeLogToKeyboardMacro,
  isAllZeroReport,
  summarizeTeeBoundary,
} from "./teeCompare.js";

function teeLine(modifier: number, keys: number[], index: number): string {
  return JSON.stringify({
    monotonic_ns: index * 1_000_000,
    wall_ns: 1000 + index,
    modifier,
    keys,
    result: "ok",
  });
}

describe("tee compare", () => {
  test("asserts tee report sequence equals derived macro report sequence", () => {
    const steps = buildKeyboardMacroStepsForText("a\n", { delayMs: 6 });
    const tee = steps.map((step, index) => teeLine(step.modifier, step.keys, index)).join("\n");

    expect(compareTeeLogToKeyboardMacro(tee, steps)).toEqual({
      ok: true,
      expectedCount: 4,
      actualCount: 4,
      comparedCount: 4,
      violations: [],
    });
  });

  test("ignores the firmware wake-tap prefix before comparing macro reports", () => {
    const steps = buildKeyboardMacroStepsForText("a", { delayMs: 6 });
    const tee = [
      teeLine(0x02, [0, 0, 0, 0, 0, 0], 0),
      teeLine(0, [0, 0, 0, 0, 0, 0], 1),
      ...steps.map((step, index) => teeLine(step.modifier, step.keys, index + 2)),
    ].join("\n");

    expect(compareTeeLogToKeyboardMacro(tee, steps)).toMatchObject({
      ok: true,
      expectedCount: 2,
      actualCount: 2,
      ignoredPrefixCount: 2,
      violations: [],
    });
  });

  test("reports the first modifier or key mismatch with the failing index", () => {
    const steps = buildKeyboardMacroStepsForText("a", { delayMs: 6 });
    const tee = [
      teeLine(0, [0x04, 0, 0, 0, 0, 0], 0),
      teeLine(0x02, [0, 0, 0, 0, 0, 0], 1),
    ].join("\n");

    expect(compareTeeLogToKeyboardMacro(tee, steps)).toMatchObject({
      ok: false,
      firstMismatch: {
        index: 1,
        expected: { modifier: 0, keys: [0, 0, 0, 0, 0, 0] },
        actual: { modifier: 0x02, keys: [0, 0, 0, 0, 0, 0] },
      },
    });
  });

  test("checks all-zero report boundaries for hidtype clear discipline evidence", () => {
    expect(isAllZeroReport({ modifier: 0, keys: [0, 0, 0, 0, 0, 0] })).toBe(true);
    expect(isAllZeroReport({ modifier: 0, keys: [0, 0, 0, 0, 0, 4] })).toBe(false);

    const summary = summarizeTeeBoundary(
      [
        teeLine(0, [0, 0, 0, 0, 0, 0], 0),
        teeLine(0, [0x04, 0, 0, 0, 0, 0], 1),
        teeLine(0, [0, 0, 0, 0, 0, 0], 2),
      ].join("\n"),
    );
    expect(summary).toEqual({
      recordCount: 3,
      firstAllZero: true,
      lastAllZero: true,
    });
  });
});
