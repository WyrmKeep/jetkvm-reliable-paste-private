import { describe, expect, it } from "vitest";

import { normalizeControlledTraceValue } from "./controlledTrace.js";

describe("normalizeControlledTraceValue", () => {
  it("removes runtime duration without collapsing provenance facts", () => {
    const value = normalizeControlledTraceValue({
      duration_ms: 17,
      observed_at: null,
      signal: {
        age_ms: 7,
        observed_at: "2026-07-14T00:00:07.000Z",
      },
      resolution: {
        age_ms: 8,
        observed_at: "2026-07-14T00:00:08.000Z",
      },
      fps: {
        age_ms: 9,
        observed_at: "2026-07-14T00:00:09.000Z",
      },
    });

    expect(value).toEqual({
      duration_ms: 0,
      observed_at: null,
      signal: {
        age_ms: 7,
        observed_at: "2026-07-14T00:00:07.000Z",
      },
      resolution: {
        age_ms: 8,
        observed_at: "2026-07-14T00:00:08.000Z",
      },
      fps: {
        age_ms: 9,
        observed_at: "2026-07-14T00:00:09.000Z",
      },
    });
  });
});
