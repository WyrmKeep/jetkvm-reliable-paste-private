import { appendFile, readFile } from "node:fs/promises";

import { FAULT_LABELS, type ErrorVector } from "./classifier.js";

export const HARNESS_VERSION = "paste-harness/0.1.0";

export type InjectionPath = "raw" | "hidrpc" | "product" | "synthetic" | string;

export interface CorpusLedgerInfo {
  id: string;
  hash: string;
  path: string;
}

export interface TelemetrySummary {
  cpu_samples: number;
  max_cpu_percent: number;
  calm: boolean;
  [key: string]: unknown;
}

export interface RunLedgerRecord {
  schema_version: 1;
  record_type: "run";
  run_id: string;
  timestamp: string;
  duration_ms: number;
  corpus: CorpusLedgerInfo;
  injection_path: InjectionPath;
  build_sha: string;
  device_layout: string;
  host_decode_layout: string;
  focus_guard_result: string;
  telemetry_summary: TelemetrySummary;
  sink_rss_bytes: number;
  harness_version: string;
  device_clock_offset_ms: number;
  cell_id: string;
  purpose: string;
  outcome: string;
  per_class_error_vector: ErrorVector;
  garble_events_pre_repair: number;
  excluded_from_thresholds: boolean;
  classifier_version: string;
  [key: string]: unknown;
}

export interface StepLedgerRecord {
  schema_version: 1;
  record_type: "step";
  run_id: string;
  step_id: string;
  timestamp: string;
  duration_ms: number;
  name: string;
  outcome: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export type LedgerRecord = RunLedgerRecord | StepLedgerRecord;

export interface LedgerParseResult {
  records: LedgerRecord[];
  warnings: string[];
}

export interface LedgerViolation {
  line?: number;
  recordIndex?: number;
  field: string;
  message: string;
}

export class LedgerWriter {
  constructor(private readonly ledgerPath: string) {}

  async append(record: LedgerRecord): Promise<void> {
    const violations = lintLedgerRecords([record]);
    if (violations.length > 0) {
      throw new Error(`ledger record failed lint: ${JSON.stringify(violations)}`);
    }
    await appendFile(this.ledgerPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }
}

export async function appendLedgerRecord(ledgerPath: string, record: LedgerRecord): Promise<void> {
  await new LedgerWriter(ledgerPath).append(record);
}

export async function parseLedgerFile(ledgerPath: string): Promise<LedgerParseResult> {
  return parseLedgerText(await readFile(ledgerPath, "utf8"));
}

export async function lintLedgerFile(ledgerPath: string): Promise<LedgerViolation[]> {
  const parsed = await parseLedgerFile(ledgerPath);
  const violations = lintLedgerRecords(parsed.records);
  for (const warning of parsed.warnings) {
    violations.push({ field: "jsonl", message: warning });
  }
  return violations;
}

export function parseLedgerText(text: string): LedgerParseResult {
  const records: LedgerRecord[] = [];
  const warnings: string[] = [];
  const lines = text.split("\n");
  const lastNonEmptyIndex = findLastNonEmptyIndex(lines);

  lines.forEach((line, index) => {
    if (line.trim() === "") {
      return;
    }
    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch (error) {
      if (index === lastNonEmptyIndex) {
        warnings.push(`skipped truncated trailing JSONL line ${index + 1}: ${String(error)}`);
      } else {
        warnings.push(`invalid JSONL line ${index + 1}: ${String(error)}`);
      }
    }
  });

  return { records, warnings };
}

export function lintLedgerRecords(records: readonly unknown[]): LedgerViolation[] {
  const violations: LedgerViolation[] = [];
  records.forEach((record, recordIndex) => {
    if (!isRecord(record)) {
      violations.push({ recordIndex, field: "record", message: "record must be an object" });
      return;
    }
    requireNumber(record, "schema_version", violations, recordIndex, 1);
    requireString(record, "record_type", violations, recordIndex);
    requireString(record, "timestamp", violations, recordIndex);
    requireDuration(record, violations, recordIndex);
    if (typeof record.timestamp === "string" && !isIsoTimestamp(record.timestamp)) {
      violations.push({
        recordIndex,
        field: "timestamp",
        message: "timestamp must be ISO-8601 UTC with milliseconds",
      });
    }

    if (record.record_type === "run") {
      lintRunRecord(record, violations, recordIndex);
    } else if (record.record_type === "step") {
      lintStepRecord(record, violations, recordIndex);
    } else {
      violations.push({
        recordIndex,
        field: "record_type",
        message: "record_type must be run or step",
      });
    }
  });
  return violations;
}

function lintRunRecord(
  record: Record<string, unknown>,
  violations: LedgerViolation[],
  recordIndex: number,
): void {
  for (const field of [
    "run_id",
    "injection_path",
    "build_sha",
    "device_layout",
    "host_decode_layout",
    "focus_guard_result",
    "harness_version",
    "cell_id",
    "purpose",
    "outcome",
    "classifier_version",
  ]) {
    requireString(record, field, violations, recordIndex);
  }
  requireNumber(record, "sink_rss_bytes", violations, recordIndex);
  requireNumber(record, "device_clock_offset_ms", violations, recordIndex);
  requireNumber(record, "garble_events_pre_repair", violations, recordIndex);
  requireBoolean(record, "excluded_from_thresholds", violations, recordIndex);

  if (!isRecord(record.corpus)) {
    violations.push({ recordIndex, field: "corpus", message: "corpus must be an object" });
  } else {
    requireString(record.corpus, "id", violations, recordIndex, "corpus.id");
    requireString(record.corpus, "hash", violations, recordIndex, "corpus.hash");
    requireString(record.corpus, "path", violations, recordIndex, "corpus.path");
  }

  if (!isRecord(record.telemetry_summary)) {
    violations.push({
      recordIndex,
      field: "telemetry_summary",
      message: "telemetry_summary must be an object",
    });
  } else {
    requireNumber(record.telemetry_summary, "cpu_samples", violations, recordIndex, "telemetry_summary.cpu_samples");
    requireNumber(
      record.telemetry_summary,
      "max_cpu_percent",
      violations,
      recordIndex,
      "telemetry_summary.max_cpu_percent",
    );
    requireBoolean(record.telemetry_summary, "calm", violations, recordIndex, "telemetry_summary.calm");
  }

  if (!isRecord(record.per_class_error_vector)) {
    violations.push({
      recordIndex,
      field: "per_class_error_vector",
      message: "per_class_error_vector must be an object",
    });
  } else {
    for (const label of FAULT_LABELS) {
      requireNumber(
        record.per_class_error_vector,
        label,
        violations,
        recordIndex,
        `per_class_error_vector.${label}`,
      );
    }
  }
}

function lintStepRecord(
  record: Record<string, unknown>,
  violations: LedgerViolation[],
  recordIndex: number,
): void {
  for (const field of ["run_id", "step_id", "name", "outcome"]) {
    requireString(record, field, violations, recordIndex);
  }
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  violations: LedgerViolation[],
  recordIndex: number,
  reportedField = field,
): void {
  if (typeof record[field] !== "string" || record[field] === "") {
    violations.push({ recordIndex, field: reportedField, message: "must be a non-empty string" });
  }
}

function requireNumber(
  record: Record<string, unknown>,
  field: string,
  violations: LedgerViolation[],
  recordIndex: number,
  expected?: number,
): void;
function requireNumber(
  record: Record<string, unknown>,
  field: string,
  violations: LedgerViolation[],
  recordIndex: number,
  reportedField?: string,
): void;
function requireNumber(
  record: Record<string, unknown>,
  field: string,
  violations: LedgerViolation[],
  recordIndex: number,
  expectedOrReportedField?: number | string,
): void {
  const reportedField = typeof expectedOrReportedField === "string" ? expectedOrReportedField : field;
  const expected = typeof expectedOrReportedField === "number" ? expectedOrReportedField : undefined;
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    violations.push({ recordIndex, field: reportedField, message: "must be a finite number" });
  } else if (expected !== undefined && value !== expected) {
    violations.push({ recordIndex, field: reportedField, message: `must equal ${expected}` });
  }
}

function requireBoolean(
  record: Record<string, unknown>,
  field: string,
  violations: LedgerViolation[],
  recordIndex: number,
  reportedField = field,
): void {
  if (typeof record[field] !== "boolean") {
    violations.push({ recordIndex, field: reportedField, message: "must be a boolean" });
  }
}

function requireDuration(
  record: Record<string, unknown>,
  violations: LedgerViolation[],
  recordIndex: number,
): void {
  requireNumber(record, "duration_ms", violations, recordIndex);
  if (typeof record.duration_ms === "number" && record.duration_ms < 0) {
    violations.push({ recordIndex, field: "duration_ms", message: "must be non-negative" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function findLastNonEmptyIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() !== "") {
      return index;
    }
  }
  return -1;
}
