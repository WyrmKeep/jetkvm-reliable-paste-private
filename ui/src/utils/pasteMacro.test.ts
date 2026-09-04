import { describe, expect, test } from "vitest";

import {
  DEFAULT_LARGE_PASTE_POLICY,
  partitionBatchesByChunkChars,
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

describe("bounded paste checkpoints", () => {
  test("pins the default threshold and source-character chunk budget", () => {
    expect(DEFAULT_LARGE_PASTE_POLICY).toEqual({
      autoThresholdChars: 1024,
      chunkChars: 1024,
      chunkPauseMs: 250,
      chunkDrainTimeoutFloorMs: 60000,
    });
  });
  test.each([127, 128, 129, 1023, 1024, 1025, 4999, 5000, 5001])(
    "preserves every character and batch at size %s",
    length => {
      const build = buildPasteMacroBatches("a".repeat(length), keyboard, 20, 128, 2318);
      const chunks = partitionBatchesByChunkChars(
        build.batchStats,
        DEFAULT_LARGE_PASTE_POLICY.chunkChars,
      );
      expect(build.invalidChars).toEqual([]);
      expect(chunks.reduce((sum, chunk) => sum + chunk.sourceChars, 0)).toBe(length);
      expect(chunks.every(chunk => chunk.sourceChars > 0 && chunk.sourceChars <= 1024)).toBe(true);
      expect(chunks[0].batchStartIndex).toBe(0);
      expect(chunks.at(-1)?.batchEndIndex).toBe(build.batches.length);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].batchStartIndex).toBe(chunks[i - 1].batchEndIndex);
      }
      if (length === 1025) expect(chunks.map(chunk => chunk.sourceChars)).toEqual([1024, 1]);
    },
  );
  test("keeps expanded mappings intact across batch and checkpoint boundaries", () => {
    const text = ("a".repeat(127) + "é^").repeat(10);
    const build = buildPasteMacroBatches(text, keyboard, 45, 128, 2318);
    const chunks = partitionBatchesByChunkChars(build.batchStats, 1024);
    expect(build.batches.flat()).toEqual(buildPasteMacroSteps(text, keyboard, 45).steps);
    expect(chunks.reduce((sum, chunk) => sum + chunk.sourceChars, 0)).toBe(text.length);
    expect(
      build.batchStats.every(stat => stat.stepCount <= 128 && stat.estimatedBytes <= 2318),
    ).toBe(true);
    expect(chunks.every(chunk => chunk.sourceChars <= 1024)).toBe(true);
    // The 127 ordinary keys leave too little room for the two-step accent.
    expect(build.batches[0]).toHaveLength(127);
    expect(build.batches[1][0].keys).toEqual(["Quote"]);
    expect(build.batches[1][1].keys).toEqual(["KeyE"]);
  });
  test("budgets slow repair beyond the old profile timeout", () => {
    const build = buildPasteMacroBatches("a".repeat(1024), keyboard, 45, 128, 2318);
    const original = estimatePasteDrainTimeoutMs(build.batchStats, 20, 60000);
    const repair = estimatePasteDrainTimeoutMs(build.batchStats, 45, 60000);
    expect(repair).toBeGreaterThan(original);
    expect(repair).toBeGreaterThan(1024 * (10 + 45));
  });
});
