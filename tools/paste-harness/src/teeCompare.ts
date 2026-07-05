import { parseTeeLog, type TeeRecord } from "./teePacing.js";
import type { KeyboardMacroStep } from "./hidrpcClient.js";

export interface TeeReportPair {
  modifier: number;
  keys: number[];
}

export interface TeeMismatch {
  index: number;
  expected: TeeReportPair;
  actual: TeeReportPair;
}

export interface TeeCompareResult {
  ok: boolean;
  expectedCount: number;
  actualCount: number;
  comparedCount: number;
  ignoredPrefixCount?: number;
  firstMismatch?: TeeMismatch;
  violations: string[];
}

export interface TeeBoundarySummary {
  recordCount: number;
  firstAllZero: boolean;
  lastAllZero: boolean;
}

export function compareTeeLogToKeyboardMacro(
  teeLog: string,
  expectedSteps: readonly KeyboardMacroStep[],
): TeeCompareResult {
  const rawActual = parseTeeLog(teeLog).map(recordToPair);
  const { pairs: actual, ignoredPrefixCount } = trimWakeTapPrefix(rawActual);
  const expected = expectedSteps.map(stepToPair);
  const comparedCount = Math.min(actual.length, expected.length);
  const violations: string[] = [];
  let firstMismatch: TeeMismatch | undefined;

  if (actual.length !== expected.length) {
    violations.push(`record count mismatch: expected ${expected.length}, actual ${actual.length}`);
  }

  for (let index = 0; index < comparedCount; index += 1) {
    const actualPair = actual[index];
    const expectedPair = expected[index];
    if (actualPair === undefined || expectedPair === undefined) {
      continue;
    }
    if (!pairsEqual(actualPair, expectedPair)) {
      firstMismatch = {
        index,
        expected: expectedPair,
        actual: actualPair,
      };
      violations.push(`first mismatch at report ${index}`);
      break;
    }
  }

  return {
    ok: violations.length === 0,
    expectedCount: expected.length,
    actualCount: actual.length,
    comparedCount,
    ...(ignoredPrefixCount === 0 ? {} : { ignoredPrefixCount }),
    ...(firstMismatch === undefined ? {} : { firstMismatch }),
    violations,
  };
}

export function summarizeTeeBoundary(teeLog: string): TeeBoundarySummary {
  const records = parseTeeLog(teeLog);
  const first = records[0];
  const last = records[records.length - 1];
  return {
    recordCount: records.length,
    firstAllZero: first === undefined ? false : isAllZeroReport(first),
    lastAllZero: last === undefined ? false : isAllZeroReport(last),
  };
}

export function isAllZeroReport(report: Pick<TeeRecord, "modifier" | "keys">): boolean {
  return report.modifier === 0 && report.keys.length === 6 && report.keys.every((key) => key === 0);
}

function recordToPair(record: TeeRecord): TeeReportPair {
  return {
    modifier: record.modifier,
    keys: [...record.keys],
  };
}

function stepToPair(step: KeyboardMacroStep): TeeReportPair {
  return {
    modifier: step.modifier,
    keys: [...step.keys],
  };
}

function pairsEqual(a: TeeReportPair, b: TeeReportPair): boolean {
  if (a.modifier !== b.modifier || a.keys.length !== b.keys.length) {
    return false;
  }
  for (let index = 0; index < a.keys.length; index += 1) {
    if (a.keys[index] !== b.keys[index]) {
      return false;
    }
  }
  return true;
}

function trimWakeTapPrefix(pairs: readonly TeeReportPair[]): { pairs: TeeReportPair[]; ignoredPrefixCount: number } {
  const first = pairs[0];
  const second = pairs[1];
  if (
    first !== undefined &&
    second !== undefined &&
    first.modifier === 0x02 &&
    first.keys.every((key) => key === 0) &&
    second.modifier === 0 &&
    second.keys.every((key) => key === 0)
  ) {
    return { pairs: pairs.slice(2).map(clonePair), ignoredPrefixCount: 2 };
  }
  return { pairs: pairs.map(clonePair), ignoredPrefixCount: 0 };
}

function clonePair(pair: TeeReportPair): TeeReportPair {
  return {
    modifier: pair.modifier,
    keys: [...pair.keys],
  };
}
