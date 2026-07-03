import { describe, expect, test } from "vitest";

import {
  buildScheduledTaskRegistrationScript,
  decodeRecvSnapshot,
  isFreshSink,
  makeNucBoxRigScripts,
  parsePowerShellJson,
  summarizeCpuSamples,
  WINDOWS_RIG_DIR,
} from "./rig.js";

describe("NucBox rig control helpers", () => {
  test("defines all scripts under the paste-rig directory", () => {
    const scripts = makeNucBoxRigScripts();

    expect(WINDOWS_RIG_DIR).toBe("C:\\Users\\Robert\\paste-rig");
    expect(Object.keys(scripts).sort()).toEqual([
      "common.ps1",
      "cpu-sample.ps1",
      "focus-guard.ps1",
      "foreground-probe.ps1",
      "layout-pin.ps1",
      "read-recv.ps1",
      "reset-notepad.ps1",
      "save-landed.ps1",
    ]);
    expect(scripts["focus-guard.ps1"]).toContain("Invoke-PasteRigFocusGuard");
    expect(scripts["layout-pin.ps1"]).toContain("00000809");
    expect(scripts["read-recv.ps1"]).toContain("ToBase64String");
  });

  test("registers persistent interactive scheduled tasks as Robert", () => {
    const script = buildScheduledTaskRegistrationScript();

    expect(script).toContain("NUCBOX_K15\\Robert");
    expect(script).toContain("LogonType Interactive");
    expect(script).toContain("PasteRigFocusGuard");
    expect(script).toContain("PasteRigForegroundProbe");
    expect(script).toContain("PasteRigResetNotepad");
    expect(script).toContain("PasteRigLayoutPin");
  });

  test("parses JSON from noisy PowerShell output", () => {
    expect(
      parsePowerShellJson<{ ok: boolean }>(`#< CLIXML\n<Objs>noise</Objs>\n{"ok":true}\n`),
    ).toEqual({ ok: true });
  });

  test("summarizes calm-host CPU telemetry and flags churn", () => {
    expect(summarizeCpuSamples([2, 17.5, 39.9])).toEqual({
      cpu_samples: 3,
      max_cpu_percent: 39.9,
      calm: true,
      cpu_over_threshold_samples: 0,
    });
    expect(summarizeCpuSamples([12, 41, 7])).toEqual({
      cpu_samples: 3,
      max_cpu_percent: 41,
      calm: false,
      cpu_over_threshold_samples: 1,
    });
  });

  test("decodes recv.txt base64 snapshots as raw bytes", () => {
    const snapshot = decodeRecvSnapshot({
      ok: true,
      base64: Buffer.from("hello £", "utf8").toString("base64"),
      lastWriteTimeUtc: "2026-07-03T10:00:00.000Z",
      length: 8,
    });

    expect(snapshot.bytes.toString("utf8")).toBe("hello £");
    expect(snapshot.lastWriteTimeUtc).toBe("2026-07-03T10:00:00.000Z");
  });

  test("fresh sink requires one small Notepad process", () => {
    expect(isFreshSink({ processCount: 1, maxWorkingSetBytes: 99_000_000 })).toBe(true);
    expect(isFreshSink({ processCount: 2, maxWorkingSetBytes: 10_000_000 })).toBe(false);
    expect(isFreshSink({ processCount: 1, maxWorkingSetBytes: 101_000_000 })).toBe(false);
  });
});
