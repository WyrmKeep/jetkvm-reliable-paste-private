import { describe, expect, test } from "vitest";

import { PASTE_PROFILES } from "./pasteBatches";
import { estimateBatchBytes } from "./pasteMacro";

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
});
