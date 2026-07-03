import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { emptyErrorVector } from "./classifier.js";
import { renderDashboardHtml } from "./dashboard.js";
import {
  calculateClockOffsetMs,
  parseLedgerText,
  runOrchestrator,
  type FocusResult,
  type OrchestratorDeps,
  type OrchestratorOptions,
} from "./orchestrator.js";

function baseOptions(dir: string): OrchestratorOptions {
  return {
    ledgerPath: join(dir, "ledger.jsonl"),
    artifactsRoot: join(dir, "artifacts"),
    injectionPath: "synthetic",
    purpose: "unit",
    cellId: "F2-UNIT",
    corpus: {
      id: "synthetic:size=12",
      hash: "sha256:test",
      path: "synthetic.txt",
      size: 12,
    },
    watchdogMs: 100,
    focusPollMs: 25,
    syntheticDurationMs: 20,
  };
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  let focusProbeCount = 0;
  const passFocus: FocusResult = {
    ok: true,
    foregroundTitle: "recv.txt - Notepad",
    capsLock: false,
    events: [{ type: "confirmed", at: "2026-07-03T10:00:00.000Z", detail: "recv.txt - Notepad" }],
  };

  return {
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 6, 3, 10, 0, 0, tick++));
    })(),
    newRunId: () => "run-unit",
    getDevicePreflight: async () => ({
      ok: true,
      buildIdentity: "build-abc",
      expectedBuildIdentity: "build-abc",
      autoUpdateEnabled: false,
      deviceLayout: "en-UK",
    }),
    measureDeviceClockOffset: async () => 4.5,
    ensureFocus: async () => passFocus,
    probeFocus: async () => {
      focusProbeCount += 1;
      return focusProbeCount > 999 ? { ...passFocus, ok: false } : passFocus;
    },
    sampleCpu: async () => ({
      cpu_samples: 2,
      max_cpu_percent: 12,
      calm: true,
      cpu_over_threshold_samples: 0,
    }),
    getSinkState: async () => ({ processCount: 1, maxWorkingSetBytes: 42_000_000 }),
    readRecvSnapshot: async () => Buffer.from("recv snapshot", "utf8"),
    fetchTeeLog: async () => "tee snapshot",
    classifyRun: async () => ({
      per_class_error_vector: emptyErrorVector(),
      garble_events_pre_repair: 0,
    }),
    runInjection: async ({ signal, onProgress }) => {
      onProgress(0);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 10);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout);
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          },
          { once: true },
        );
      });
      onProgress(1);
      return { hidOutputReports: 0 };
    },
    ...overrides,
  };
}

describe("run orchestrator", () => {
  test("aborts preflight failures before any HID output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-orch-preflight-"));
    let injectionStarted = false;
    try {
      const result = await runOrchestrator(
        baseOptions(dir),
        makeDeps({
          getDevicePreflight: async () => ({
            ok: false,
            buildIdentity: "build-abc",
            expectedBuildIdentity: "build-abc",
            autoUpdateEnabled: true,
            deviceLayout: "en-UK",
            reason: "auto_update_enabled=true",
          }),
          runInjection: async () => {
            injectionStarted = true;
            return { hidOutputReports: 1 };
          },
        }),
      );

      expect(result.outcome).toBe("abort:preflight");
      expect(injectionStarted).toBe(false);
      const parsed = parseLedgerText(await readFile(baseOptions(dir).ledgerPath, "utf8"));
      expect(parsed.records.some((record) => record.record_type === "run")).toBe(true);
      expect(JSON.stringify(parsed.records)).toContain('"hid_output_reports":0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("logs a refocus event and proceeds when calc.exe stole foreground", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-orch-refocus-"));
    try {
      const result = await runOrchestrator(
        baseOptions(dir),
        makeDeps({
          ensureFocus: async () => ({
            ok: true,
            foregroundTitle: "recv.txt - Notepad",
            capsLock: false,
            events: [
              { type: "wrong_foreground", at: "2026-07-03T10:00:00.000Z", detail: "Calculator" },
              { type: "refocused", at: "2026-07-03T10:00:00.100Z", detail: "recv.txt - Notepad" },
              { type: "confirmed", at: "2026-07-03T10:00:00.200Z", detail: "recv.txt - Notepad" },
            ],
          }),
        }),
      );

      expect(result.outcome).toBe("completed");
      const ledger = await readFile(baseOptions(dir).ledgerPath, "utf8");
      expect(ledger).toContain("wrong_foreground");
      expect(ledger).toContain("refocused");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("aborts focus failures before injection and records zero HID output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-orch-focus-"));
    let injectionStarted = false;
    try {
      const result = await runOrchestrator(
        baseOptions(dir),
        makeDeps({
          ensureFocus: async () => ({
            ok: false,
            foregroundTitle: "",
            capsLock: false,
            reason: "notepad_not_found",
            events: [{ type: "notepad_missing", at: "2026-07-03T10:00:00.000Z", detail: "" }],
          }),
          runInjection: async () => {
            injectionStarted = true;
            return { hidOutputReports: 1 };
          },
        }),
      );

      expect(result.outcome).toBe("abort:focus");
      expect(injectionStarted).toBe(false);
      expect(await readFile(join(baseOptions(dir).artifactsRoot, "run-unit", "tee.log"), "utf8")).toBe(
        "tee snapshot",
      );
      expect(JSON.stringify(parseLedgerText(await readFile(baseOptions(dir).ledgerPath, "utf8")).records)).toContain(
        '"hid_output_reports":0',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watchdog aborts a no-progress injection instead of hanging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-orch-watchdog-"));
    try {
      const result = await runOrchestrator(
        { ...baseOptions(dir), watchdogMs: 30 },
        makeDeps({
          runInjection: async ({ signal }) =>
            new Promise((_, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
                { once: true },
              );
            }),
        }),
      );

      expect(result.outcome).toBe("watchdog_abort");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("focus loss during a run fails fast", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-orch-focus-loss-"));
    let probes = 0;
    try {
      const result = await runOrchestrator(
        { ...baseOptions(dir), syntheticDurationMs: 150, focusPollMs: 10, watchdogMs: 500 },
        makeDeps({
          probeFocus: async () => {
            probes += 1;
            return probes < 2
              ? {
                  ok: true,
                  foregroundTitle: "recv.txt - Notepad",
                  capsLock: false,
                  events: [],
                }
              : {
                  ok: false,
                  foregroundTitle: "Calculator",
                  capsLock: false,
                  reason: "focus_lost",
                  events: [{ type: "focus_lost", at: "2026-07-03T10:00:00.050Z", detail: "Calculator" }],
                };
          },
          runInjection: async ({ signal, onProgress }) => {
            onProgress(1);
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(resolve, 100);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timeout);
                  reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
                },
                { once: true },
              );
            });
            return { hidOutputReports: 0 };
          },
        }),
      );

      expect(result.outcome).toBe("focus_lost");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates run artifacts and flags churny telemetry as excluded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-orch-artifacts-"));
    try {
      const result = await runOrchestrator(
        baseOptions(dir),
        makeDeps({
          sampleCpu: async () => ({
            cpu_samples: 2,
            max_cpu_percent: 99,
            calm: false,
            cpu_over_threshold_samples: 1,
          }),
        }),
      );

      expect(result.outcome).toBe("completed");
      expect(await readFile(join(baseOptions(dir).artifactsRoot, "run-unit", "tee.log"), "utf8")).toBe(
        "tee snapshot",
      );
      expect(await readFile(join(baseOptions(dir).artifactsRoot, "run-unit", "recv.txt"))).toEqual(
        Buffer.from("recv snapshot", "utf8"),
      );
      const parsed = parseLedgerText(await readFile(baseOptions(dir).ledgerPath, "utf8"));
      const html = renderDashboardHtml(parsed.records);
      expect(JSON.stringify(parsed.records)).toContain('"excluded_from_thresholds":true');
      expect(html).toContain("artifacts/run-unit/tee.log");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("calculates device to harness clock offset from midpoint samples", () => {
    expect(calculateClockOffsetMs({ beforeNs: 1_000_000_000n, deviceNs: 1_060_000_000n, afterNs: 1_020_000_000n })).toBe(
      50,
    );
  });
});
