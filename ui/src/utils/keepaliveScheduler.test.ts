import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createKeepaliveScheduler } from "./keepaliveScheduler";

describe("createKeepaliveScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("maintains a 50ms cadence through a 33ms repeated-keydown storm", () => {
    const tickTimes: number[] = [];
    const scheduler = createKeepaliveScheduler({
      intervalMs: 50,
      onTick: () => tickTimes.push(Date.now()),
    });

    scheduler.handleKeyChange(4, true);
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(33);
      scheduler.handleKeyChange(4, true);
    }

    expect(tickTimes).toEqual([50, 100, 150]);

    vi.advanceTimersByTime(2);
    expect(tickTimes).toEqual([50, 100, 150, 200]);

    scheduler.reset();
  });

  test("keeps ticking until the last held key is released", () => {
    const tickTimes: number[] = [];
    const scheduler = createKeepaliveScheduler({
      intervalMs: 50,
      onTick: () => tickTimes.push(Date.now()),
    });

    scheduler.handleKeyChange(4, true);
    vi.advanceTimersByTime(50);
    scheduler.handleKeyChange(5, true);
    scheduler.handleKeyChange(4, false);
    vi.advanceTimersByTime(50);
    scheduler.handleKeyChange(5, false);
    vi.advanceTimersByTime(100);

    expect(tickTimes).toEqual([50, 100]);
    expect(scheduler.heldKeyCount()).toBe(0);
  });

  test("uses the latest tick handler without restarting the interval", () => {
    const ticks: string[] = [];
    const scheduler = createKeepaliveScheduler({
      intervalMs: 50,
      onTick: () => ticks.push(`old:${Date.now()}`),
    });

    scheduler.handleKeyChange(4, true);
    vi.advanceTimersByTime(50);
    scheduler.setTickHandler(() => ticks.push(`new:${Date.now()}`));
    vi.advanceTimersByTime(50);

    expect(ticks).toEqual(["old:50", "new:100"]);

    scheduler.reset();
  });
});
