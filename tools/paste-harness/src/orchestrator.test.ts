import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { emptyErrorVector } from "./classifier.js";
import { renderDashboardHtml } from "./dashboard.js";
import {
  calculateClockOffsetMs,
  getDevicePreflight,
  parseLedgerText,
  resetTeeLog,
  runOrchestrator,
  type FocusResult,
  type OrchestratorDeps,
  type OrchestratorOptions,
} from "./orchestrator.js";
import { buildProductPathLedgerDetails } from "./productPath.js";

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
    resetTeeLog: async () => undefined,
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
      expect(await readFile(join(baseOptions(dir).artifactsRoot, "run-unit", "tee.disabled"), "utf8")).toContain(
        "HID tee disabled",
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
      expect(await readFile(join(baseOptions(dir).artifactsRoot, "run-unit", "tee.disabled"), "utf8")).toContain(
        "HID tee disabled",
      );
      expect(await readFile(join(baseOptions(dir).artifactsRoot, "run-unit", "recv.txt"))).toEqual(
        Buffer.from("recv snapshot", "utf8"),
      );
      const parsed = parseLedgerText(await readFile(baseOptions(dir).ledgerPath, "utf8"));
      const html = renderDashboardHtml(parsed.records);
      expect(JSON.stringify(parsed.records)).toContain('"excluded_from_thresholds":true');
      expect(html).toContain("artifacts/run-unit/tee.disabled");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips device tee fetch when tee is disabled and writes a disabled marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-orch-tee-disabled-"));
    let fetchCalls = 0;
    let resetCalls = 0;
    try {
      const result = await runOrchestrator(
        baseOptions(dir),
        makeDeps({
          fetchTeeLog: async () => {
            fetchCalls += 1;
            return "stale tee that must not be copied";
          },
          resetTeeLog: async () => {
            resetCalls += 1;
          },
        }),
      );

      expect(result.outcome).toBe("completed");
      expect(fetchCalls).toBe(0);
      expect(resetCalls).toBe(0);
      const markerPath = join(baseOptions(dir).artifactsRoot, "run-unit", "tee.disabled");
      expect(await readFile(markerPath, "utf8")).toContain("device tee log intentionally not fetched");
      await expect(readFile(join(baseOptions(dir).artifactsRoot, "run-unit", "tee.log"), "utf8")).rejects.toThrow();
      const parsed = parseLedgerText(await readFile(baseOptions(dir).ledgerPath, "utf8"));
      const run = parsed.records.find(record => record.record_type === "run");
      expect(run).toMatchObject({
        artifacts: {
          tee_enabled: false,
          tee_log_path: "artifacts/run-unit/tee.disabled",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resets device tee before injection and fetches tee log only for tee-enabled runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-orch-tee-enabled-"));
    const events: string[] = [];
    try {
      const result = await runOrchestrator(
        { ...baseOptions(dir), enableTee: true },
        makeDeps({
          resetTeeLog: async () => {
            events.push("reset");
          },
          runInjection: async ({ onProgress }) => {
            events.push("inject");
            onProgress(1);
            return { hidOutputReports: 2 };
          },
          fetchTeeLog: async () => {
            events.push("fetch");
            return "fresh tee snapshot";
          },
        }),
      );

      expect(result.outcome).toBe("completed");
      expect(events).toEqual(["reset", "inject", "fetch"]);
      expect(await readFile(join(baseOptions(dir).artifactsRoot, "run-unit", "tee.log"), "utf8")).toBe(
        "fresh tee snapshot",
      );
      const parsed = parseLedgerText(await readFile(baseOptions(dir).ledgerPath, "utf8"));
      const run = parsed.records.find(record => record.record_type === "run");
      expect(run).toMatchObject({
        artifacts: {
          tee_enabled: true,
          tee_log_path: "artifacts/run-unit/tee.log",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preflight attributes build identity to the running binary when it differs from production", async () => {
    const productionHash = `${"a".repeat(64)}`;
    const runningHash = `${"b".repeat(64)}`;
    const preflight = await getDevicePreflight(
      {
        KVM_PRIMARY: "192.0.2.10",
        KVM_SECONDARY: "192.0.2.11",
        WIN_TARGET: "192.0.2.12",
        WIN_RECV: "C:\\recv.txt",
      },
      undefined,
      async () => ({
        command: "ssh",
        args: [],
        stdout: [
          "hostname=worklaptopjetkvm",
          `production_app_sha256=${productionHash}`,
          "running_pid=4242",
          "running_exe=/userdata/jetkvm/bin/jetkvm_app_debug",
          `running_app_sha256=${runningHash}`,
          "auto_update_enabled=false",
          "keyboard_layout=en-UK",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
    );

    expect(preflight.ok).toBe(true);
    expect(preflight.buildIdentity).toBe("worklaptopjetkvm:bbbbbbbbbbbb");
    expect(preflight.runningBuildIdentity).toBe("worklaptopjetkvm:bbbbbbbbbbbb");
    expect(preflight.productionBuildIdentity).toBe("worklaptopjetkvm:aaaaaaaaaaaa");
    expect(preflight.runningBinaryPath).toBe("/userdata/jetkvm/bin/jetkvm_app_debug");
    expect(preflight.productionBinaryPath).toBe("/userdata/jetkvm/bin/jetkvm_app");
    expect(preflight.productionRunningMismatch).toBe(true);
  });

  test("resetTeeLog truncates the current device tee and removes the rotated tee through ssh", async () => {
    let observedTarget = "";
    let observedCommand = "";

    await resetTeeLog(
      {
        KVM_PRIMARY: "192.0.2.10",
        KVM_SECONDARY: "192.0.2.11",
        WIN_TARGET: "192.0.2.12",
        WIN_RECV: "C:\\recv.txt",
      },
      async (target, command) => {
        observedTarget = target;
        observedCommand = command;
        return {
          command: "ssh",
          args: [],
          stdout: "",
          stderr: "",
          exitCode: 0,
          signal: null,
          timedOut: false,
        };
      },
    );

    expect(observedTarget).toBe("root@192.0.2.10");
    expect(observedCommand).toContain(": > /tmp/jetkvm-hid-tee.log");
    expect(observedCommand).toContain("rm -f /tmp/jetkvm-hid-tee.log.1");
  });

  test("records product path completion and verification details on run rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-orch-product-"));
    try {
      const result = await runOrchestrator(
        {
          ...baseOptions(dir),
          injectionPath: "product",
          purpose: "a-h4-product-path",
          cellId: "A-H4",
        },
        makeDeps({
          runInjection: async ({ onProgress }) => {
            onProgress(1);
            return {
              hidOutputReports: 24,
              details: {
                product_path: buildProductPathLedgerDetails({
                  doneLine: "done: chars=12 elapsed=1.0s effective=12.0cps",
                  manualConfirmContinuations: 0,
                  traceLineCount: 4,
                }),
              },
            };
          },
        }),
      );

      expect(result.outcome).toBe("completed");
      const parsed = parseLedgerText(await readFile(baseOptions(dir).ledgerPath, "utf8"));
      const run = parsed.records.find(record => record.record_type === "run");
      expect(run).toMatchObject({
        injection_path: "product",
        product_path: {
          completion_signal: "done-trace",
          verification_mode: "auto-verify-off",
          manual_confirm_continuations: 0,
        },
      });
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
