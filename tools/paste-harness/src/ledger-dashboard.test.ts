import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { CLASSIFIER_VERSION, emptyErrorVector } from "./classifier.js";
import { renderDashboardHtml, writeDashboardFromLedger } from "./dashboard.js";
import {
  HARNESS_VERSION,
  LedgerWriter,
  collectManualExclusions,
  createManualExclusionAnnotation,
  isRunExcludedFromThresholds,
  lintLedgerRecords,
  parseLedgerText,
  thresholdExclusionReason,
  type LedgerRecord,
  type RunLedgerRecord,
} from "./ledger.js";

function sampleRun(overrides: Partial<RunLedgerRecord> = {}): RunLedgerRecord {
  return {
    schema_version: 1,
    record_type: "run",
    run_id: "run-001",
    timestamp: "2026-07-03T10:00:00.000Z",
    duration_ms: 1234,
    corpus: {
      id: "code:seed=1:size=200",
      hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      path: "artifacts/run-001/corpus.txt",
    },
    injection_path: "raw",
    build_sha: "abcdef123456",
    device_layout: "en-UK",
    host_decode_layout: "en-UK",
    focus_guard_result: "pass",
    telemetry_summary: {
      cpu_samples: 5,
      max_cpu_percent: 12.5,
      calm: true,
    },
    sink_rss_bytes: 42_000_000,
    harness_version: HARNESS_VERSION,
    device_clock_offset_ms: 3.25,
    cell_id: "M1-HARNESS-UNIT",
    purpose: "self_validation",
    outcome: "classified",
    per_class_error_vector: {
      ...emptyErrorVector(),
      drop: 2,
      "case-error": 1,
    },
    garble_events_pre_repair: 0,
    excluded_from_thresholds: false,
    classifier_version: CLASSIFIER_VERSION,
    preflight: {
      ok: true,
      reason: "ok",
      device: {
        ok: true,
        buildIdentity: "abcdef123456",
        expectedBuildIdentity: "abcdef123456",
        autoUpdateEnabled: false,
        deviceLayout: "en-UK",
      },
      caps_lock_off: true,
      focus_guard_confirmed: true,
    },
    artifacts: {
      tee_log_path: "artifacts/run-001/tee.log",
      recv_txt_path: "artifacts/run-001/recv.txt",
    },
    focus_guard_events: [],
    hid_output_reports: 0,
    ...overrides,
  };
}

const sampleStep: LedgerRecord = {
  schema_version: 1,
  record_type: "step",
  run_id: "run-001",
  step_id: "step-001",
  timestamp: "2026-07-03T10:00:00.250Z",
  duration_ms: 250,
  name: "classify",
  outcome: "ok",
  details: {
    rows: 1,
  },
};

const sampleManualExclusion = createManualExclusionAnnotation({
  runId: "run-001",
  excludedReason: "contaminated by stale sink content",
  source: "unit-test",
  timestamp: "2026-07-03T10:00:00.500Z",
  annotationId: "manual-exclusion:run-001:test",
});

describe("ledger and dashboard", () => {
  test("validates required run and step schema fields", () => {
    const valid = [sampleRun(), sampleStep, sampleManualExclusion];
    const invalid = [sampleRun({ classifier_version: "" })];

    expect(lintLedgerRecords(valid)).toEqual([]);
    expect(lintLedgerRecords(invalid).map((violation) => violation.field)).toContain(
      "classifier_version",
    );
  });

  test("writes append-only JSONL records with one complete line per record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-harness-ledger-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      const writer = new LedgerWriter(ledgerPath);

      await writer.append(sampleRun());
      await writer.append(sampleStep);
      await writer.append(sampleManualExclusion);

      const text = await readFile(ledgerPath, "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(text.trimEnd().split("\n")).toHaveLength(3);
      expect(parseLedgerText(text).records).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applies append-only manual exclusion annotations to threshold eligibility", () => {
    const run = sampleRun({ excluded_from_thresholds: false });
    const records: LedgerRecord[] = [run, sampleManualExclusion];
    const manualExclusions = collectManualExclusions(records);

    expect(lintLedgerRecords(records)).toEqual([]);
    expect(isRunExcludedFromThresholds(run, manualExclusions)).toBe(true);
    expect(thresholdExclusionReason(run, manualExclusions)).toBe(
      "contaminated by stale sink content",
    );
  });

  test("renders deterministic self-contained dashboard HTML from ledger records alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-harness-dashboard-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      const firstHtml = join(dir, "first.html");
      const secondHtml = join(dir, "second.html");
      const ledgerText = `${JSON.stringify(sampleRun())}\n${JSON.stringify(
        sampleStep,
      )}\n${JSON.stringify(sampleManualExclusion)}\n`;
      await writeFile(ledgerPath, ledgerText, "utf8");

      await writeDashboardFromLedger(ledgerPath, firstHtml);
      await writeDashboardFromLedger(ledgerPath, secondHtml);

      const first = await readFile(firstHtml, "utf8");
      const second = await readFile(secondHtml, "utf8");
      expect(first).toBe(second);
      expect(first).not.toMatch(/<script\b|https?:\/\//i);
      expect(first).toContain("run-001");
      expect(first).toContain("Threshold-eligible per-class error rates");
      expect(first).toContain("contaminated by stale sink content");
      expect(first).toContain("#run-run-001");
      expect(renderDashboardHtml(parseLedgerText(ledgerText).records)).toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parses a valid ledger prefix and warns on one truncated trailing line", () => {
    const text = `${JSON.stringify(sampleRun())}\n{"record_type":`;
    const parsed = parseLedgerText(text);

    expect(parsed.records).toHaveLength(1);
    expect(parsed.warnings).toHaveLength(1);
  });
});
