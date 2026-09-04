import { describe, expect, test } from "vitest";

import { PASTE_PROFILES, getPasteRepairDelayMs } from "./pasteBatches";
import { estimateBatchBytes } from "./pasteMacro";

const PLAIN_KEY_PRESS_HOLD_MS = 5;

describe("PASTE_PROFILES", () => {
  test("keeps every step cap reachable under its byte cap", () => {
    for (const [name, profile] of Object.entries(PASTE_PROFILES)) {
      expect(Number.isFinite(profile.maxStepsPerBatch), name).toBe(true);
      expect(Number.isFinite(profile.maxBytesPerBatch), name).toBe(true);
      expect(Number.isFinite(profile.keyDelayMs), name).toBe(true);
      expect(estimateBatchBytes(profile.maxStepsPerBatch), name).toBeLessThanOrEqual(
        profile.maxBytesPerBatch,
      );
    }
  });

  test("keeps conservative Reliable pacing and unchanged Fast configuration", () => {
    const reliableCps = 1000 / (PLAIN_KEY_PRESS_HOLD_MS + PASTE_PROFILES.reliable.keyDelayMs);
    const fastCps = 1000 / (PLAIN_KEY_PRESS_HOLD_MS + PASTE_PROFILES.fast.keyDelayMs);

    expect(PASTE_PROFILES.reliable).toMatchObject({
      maxStepsPerBatch: 128,
      keyDelayMs: 20,
    });
    expect(reliableCps).toBe(40);

    expect(PASTE_PROFILES.fast).toMatchObject({
      maxStepsPerBatch: 256,
      keyDelayMs: 2,
    });
    expect(fastCps).toBeCloseTo(142.857, 3);
  });
});

describe("Slow and repair pacing", () => {
  test("keeps the 128-step Slow cap reachable and offers 20 cps nominally", () => {
    expect(PASTE_PROFILES.slow).toEqual({
      maxStepsPerBatch: 128,
      maxBytesPerBatch: 2318,
      keyDelayMs: 45,
    });
    expect(1000 / (5 + PASTE_PROFILES.slow.keyDelayMs)).toBe(20);
  });
  test.each([2, 20, 45, 80, 0, NaN])("repair never speeds up delay %s", delay => {
    expect(getPasteRepairDelayMs(delay)).toBe(Number.isFinite(delay) && delay > 45 ? delay : 45);
  });
});
