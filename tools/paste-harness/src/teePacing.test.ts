import { describe, expect, test } from "vitest";

import { analyzeTeePacing, parseTeeLog } from "./teePacing.js";

function teeLine(monotonicMs: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    monotonic_ns: Math.round(monotonicMs * 1_000_000),
    wall_ns: 1_800_000_000_000_000_000 + Math.round(monotonicMs * 1_000_000),
    modifier: 0,
    keys: [0, 0, 0, 0, 0, 0],
    result: "ok",
    ...overrides,
  });
}

describe("tee pacing analyzer", () => {
  test("accepts reliable 11ms cadence from monotonic timestamps", () => {
    const text = Array.from({ length: 101 }, (_, index) => teeLine(index * 11)).join("\n");

    const result = analyzeTeePacing(text, { expectMs: 11 });

    expect(result.ok).toBe(true);
    expect(result.reportCount).toBe(101);
    expect(result.intervalCount).toBe(100);
    expect(result.meanMs).toBe(11);
    expect(result.p99OvershootMs).toBe(0);
    expect(result.resultCounts).toEqual({ ok: 101 });
  });

  test("rejects mean drift and p99 overshoot outside the contract", () => {
    const monotonicMs = [0];
    for (let index = 0; index < 100; index += 1) {
      const previous = monotonicMs.at(-1);
      if (previous === undefined) {
        throw new Error("missing previous timestamp");
      }
      monotonicMs.push(previous + (index >= 98 ? 14 : 12));
    }
    const text = monotonicMs.map((value) => teeLine(value)).join("\n");

    const result = analyzeTeePacing(text, { expectMs: 11 });

    expect(result.ok).toBe(false);
    expect(result.meanMs).toBeCloseTo(12.04, 5);
    expect(result.p99OvershootMs).toBe(3);
    expect(result.violations).toContain("mean interval 12.040ms outside 11±0.5ms");
    expect(result.violations).toContain("p99 overshoot 3.000ms is not <2ms");
  });

  test("rejects malformed tee records", () => {
    const text = teeLine(0, { keys: [1, 2, 3] });

    expect(() => parseTeeLog(text)).toThrow(/keys must contain 6 bytes/);
  });
});
