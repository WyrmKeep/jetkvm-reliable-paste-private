export interface TeeRecord {
  monotonic_ns: number;
  wall_ns: number;
  modifier: number;
  keys: number[];
  result: string;
}

export interface TeePacingOptions {
  expectMs: number;
  meanToleranceMs?: number;
  p99OvershootLimitMs?: number;
}

export interface TeePacingResult {
  ok: boolean;
  reportCount: number;
  intervalCount: number;
  expectedMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p99OvershootMs: number;
  resultCounts: Record<string, number>;
  violations: string[];
}

const DEFAULT_MEAN_TOLERANCE_MS = 0.5;
const DEFAULT_P99_OVERSHOOT_LIMIT_MS = 2;

function asObject(value: unknown, lineNumber: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`line ${lineNumber}: record must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredFiniteNumber(
  record: Record<string, unknown>,
  field: keyof TeeRecord,
  lineNumber: number,
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`line ${lineNumber}: ${field} must be a finite number`);
  }
  return value;
}

function parseTeeRecord(value: unknown, lineNumber: number): TeeRecord {
  const record = asObject(value, lineNumber);
  const keysValue = record.keys;
  if (!Array.isArray(keysValue) || keysValue.length !== 6) {
    throw new Error(`line ${lineNumber}: keys must contain 6 bytes`);
  }

  const keys: number[] = [];
  for (const key of keysValue) {
    if (typeof key !== "number" || !Number.isInteger(key) || key < 0 || key > 255) {
      throw new Error(`line ${lineNumber}: keys must contain byte values`);
    }
    keys.push(key);
  }

  const result = record.result;
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`line ${lineNumber}: result must be a non-empty string`);
  }

  const modifier = requiredFiniteNumber(record, "modifier", lineNumber);
  if (!Number.isInteger(modifier) || modifier < 0 || modifier > 255) {
    throw new Error(`line ${lineNumber}: modifier must be a byte value`);
  }

  return {
    monotonic_ns: requiredFiniteNumber(record, "monotonic_ns", lineNumber),
    wall_ns: requiredFiniteNumber(record, "wall_ns", lineNumber),
    modifier,
    keys,
    result,
  };
}

export function parseTeeLog(text: string): TeeRecord[] {
  const records: TeeRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLeadingRotationPadding(lines[index] ?? "");
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`line ${index + 1}: invalid JSON: ${message}`);
    }
    records.push(parseTeeRecord(parsed, index + 1));
  }
  return records;
}

function stripLeadingRotationPadding(rawLine: string): string {
  return rawLine.replace(/^[\u0000\s]+/u, "");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function formatMs(value: number): string {
  return value.toFixed(3);
}

function formatExpectation(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

export function analyzeTeePacing(text: string, options: TeePacingOptions): TeePacingResult {
  const expectMs = options.expectMs;
  if (!Number.isFinite(expectMs) || expectMs <= 0) {
    throw new Error("--expect must be a positive millisecond value");
  }
  const meanToleranceMs = options.meanToleranceMs ?? DEFAULT_MEAN_TOLERANCE_MS;
  const p99OvershootLimitMs = options.p99OvershootLimitMs ?? DEFAULT_P99_OVERSHOOT_LIMIT_MS;
  const records = parseTeeLog(text);
  const resultCounts: Record<string, number> = {};
  for (const record of records) {
    resultCounts[record.result] = (resultCounts[record.result] ?? 0) + 1;
  }

  const intervalsMs: number[] = [];
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (!previous || !current) {
      continue;
    }
    const intervalMs = (current.monotonic_ns - previous.monotonic_ns) / 1_000_000;
    if (intervalMs <= 0) {
      throw new Error(`line ${index + 1}: monotonic_ns must strictly increase`);
    }
    intervalsMs.push(intervalMs);
  }

  const intervalCount = intervalsMs.length;
  const meanMs =
    intervalCount > 0 ? intervalsMs.reduce((sum, interval) => sum + interval, 0) / intervalCount : 0;
  const minMs = intervalCount > 0 ? Math.min(...intervalsMs) : 0;
  const maxMs = intervalCount > 0 ? Math.max(...intervalsMs) : 0;
  const overshootsMs = intervalsMs.map((interval) => Math.max(0, interval - expectMs));
  const p99OvershootMs = percentile(overshootsMs, 0.99);

  const violations: string[] = [];
  if (intervalCount === 0) {
    violations.push("need at least two tee records to analyze pacing");
  }
  if (intervalCount > 0 && Math.abs(meanMs - expectMs) > meanToleranceMs) {
    violations.push(
      `mean interval ${formatMs(meanMs)}ms outside ${formatExpectation(expectMs)}±${formatExpectation(
        meanToleranceMs,
      )}ms`,
    );
  }
  if (intervalCount > 0 && p99OvershootMs >= p99OvershootLimitMs) {
    violations.push(
      `p99 overshoot ${formatMs(p99OvershootMs)}ms is not <${formatExpectation(
        p99OvershootLimitMs,
      )}ms`,
    );
  }

  return {
    ok: violations.length === 0,
    reportCount: records.length,
    intervalCount,
    expectedMs: expectMs,
    meanMs,
    minMs,
    maxMs,
    p99OvershootMs,
    resultCounts,
    violations,
  };
}
