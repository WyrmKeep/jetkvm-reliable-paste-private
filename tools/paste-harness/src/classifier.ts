import { compareNormalizedText } from "./normalize.js";

export const CLASSIFIER_VERSION = "paste-harness-classifier/1.0.0";

export const FAULT_LABELS = [
  "drop",
  "insertion",
  "same-length-substitution",
  "case-error",
  "stuck-modifier-run",
  "layout-swap-signature",
] as const;

export type FaultLabel = (typeof FAULT_LABELS)[number];
export type ErrorVector = Record<FaultLabel, number>;

export const MINIMAL_EDIT_TIE_BREAK =
  "Trim common prefix/suffix, then choose a minimal edit script; ties prefer same-index substitution before drop before insertion so same-length corruptions are not split into delete+insert.";

export interface DifferenceEvent {
  label: FaultLabel;
  expectedIndex?: number;
  actualIndex?: number;
  expected?: string;
  actual?: string;
  length?: number;
}

export interface LayoutSwapDetail {
  pair: string;
  from: string;
  to: string;
  count: number;
}

export interface ClassificationResult {
  classifier_version: string;
  expectedLength: number;
  actualLength: number;
  labels: FaultLabel[];
  errorVector: ErrorVector;
  events: DifferenceEvent[];
  layoutSwapDetails: LayoutSwapDetail[];
  tieBreak: string;
}

type DiffOp =
  | { kind: "equal"; expectedIndex: number; actualIndex: number; expected: string; actual: string }
  | {
      kind: "substitute";
      expectedIndex: number;
      actualIndex: number;
      expected: string;
      actual: string;
    }
  | { kind: "drop"; expectedIndex: number; expected: string }
  | { kind: "insert"; actualIndex: number; actual: string };

const SHIFT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["a", "A"],
  ["b", "B"],
  ["c", "C"],
  ["d", "D"],
  ["e", "E"],
  ["f", "F"],
  ["g", "G"],
  ["h", "H"],
  ["i", "I"],
  ["j", "J"],
  ["k", "K"],
  ["l", "L"],
  ["m", "M"],
  ["n", "N"],
  ["o", "O"],
  ["p", "P"],
  ["q", "Q"],
  ["r", "R"],
  ["s", "S"],
  ["t", "T"],
  ["u", "U"],
  ["v", "V"],
  ["w", "W"],
  ["x", "X"],
  ["y", "Y"],
  ["z", "Z"],
  ["1", "!"],
  ["2", '"'],
  ["3", "£"],
  ["4", "$"],
  ["5", "%"],
  ["6", "^"],
  ["7", "&"],
  ["8", "*"],
  ["9", "("],
  ["0", ")"],
  ["-", "_"],
  ["=", "+"],
  ["'", "@"],
  [",", "<"],
  ["/", "?"],
  [".", ">"],
  [";", ":"],
  ["[", "{"],
  ["]", "}"],
  ["#", "~"],
  ["\\", "|"],
];

const LAYOUT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["@", '"'],
  ["#", "£"],
  ["#", "\\"],
  ["~", "|"],
  ["~", "¬"],
];

const shiftCounterpart = makeBidirectionalMap(SHIFT_PAIRS);

export function emptyErrorVector(): ErrorVector {
  return {
    drop: 0,
    insertion: 0,
    "same-length-substitution": 0,
    "case-error": 0,
    "stuck-modifier-run": 0,
    "layout-swap-signature": 0,
  };
}

export function classifyDifference(
  expectedInput: Buffer | Uint8Array | string,
  actualInput: Buffer | Uint8Array | string,
): ClassificationResult {
  const comparison = compareNormalizedText(expectedInput, actualInput);
  const ops = diffCodePoints(comparison.expectedCodePoints, comparison.actualCodePoints);
  const events = classifyOps(ops);
  const errorVector = emptyErrorVector();
  for (const event of events) {
    errorVector[event.label] += event.length ?? 1;
  }

  return {
    classifier_version: CLASSIFIER_VERSION,
    expectedLength: comparison.expectedCodePoints.length,
    actualLength: comparison.actualCodePoints.length,
    labels: FAULT_LABELS.filter((label) => errorVector[label] > 0),
    errorVector,
    events,
    layoutSwapDetails: summarizeLayoutSwaps(events),
    tieBreak: MINIMAL_EDIT_TIE_BREAK,
  };
}

function classifyOps(ops: DiffOp[]): DifferenceEvent[] {
  const events: DifferenceEvent[] = [];
  const substitutions = ops
    .map((op, opIndex) => ({ op, opIndex }))
    .filter(
      (
        entry,
      ): entry is {
        op: Extract<DiffOp, { kind: "substitute" }>;
        opIndex: number;
      } => entry.op.kind === "substitute",
    );
  const stuckOpIndexes = new Set<number>();

  for (let index = 0; index < substitutions.length; ) {
    const first = substitutions[index];
    if (!first) {
      break;
    }
    const run = [first];
    let cursor = index + 1;
    let current = substitutions[cursor];
    while (
      current &&
      isConsecutiveSubstitution(run[run.length - 1]?.op, current.op) &&
      isWrongShift(current.op.expected, current.op.actual)
    ) {
      run.push(current);
      cursor += 1;
      current = substitutions[cursor];
    }
    if (
      run.length >= 2 &&
      run.every((entry) => isWrongShift(entry?.op.expected, entry?.op.actual))
    ) {
      for (const entry of run) {
        stuckOpIndexes.add(entry.opIndex);
      }
    }
    index = Math.max(cursor, index + 1);
  }

  const layoutCandidateIndexes = new Set<number>();
  for (const { op, opIndex } of substitutions) {
    if (!stuckOpIndexes.has(opIndex) && isLayoutSwapCandidate(op.expected, op.actual)) {
      layoutCandidateIndexes.add(opIndex);
    }
  }
  const hasSystematicLayoutSignature = layoutCandidateIndexes.size >= 2;

  for (const [opIndex, op] of ops.entries()) {
    switch (op.kind) {
      case "equal":
        break;
      case "drop":
        events.push({
          label: "drop",
          expectedIndex: op.expectedIndex,
          expected: op.expected,
        });
        break;
      case "insert":
        events.push({
          label: "insertion",
          actualIndex: op.actualIndex,
          actual: op.actual,
        });
        break;
      case "substitute":
        if (stuckOpIndexes.has(opIndex)) {
          events.push(substitutionEvent("stuck-modifier-run", op));
        } else if (hasSystematicLayoutSignature && layoutCandidateIndexes.has(opIndex)) {
          events.push(substitutionEvent("layout-swap-signature", op));
        } else if (isCaseError(op.expected, op.actual)) {
          events.push(substitutionEvent("case-error", op));
        } else {
          events.push(substitutionEvent("same-length-substitution", op));
        }
        break;
    }
  }
  return coalesceRuns(events);
}

function substitutionEvent(
  label: FaultLabel,
  op: Extract<DiffOp, { kind: "substitute" }>,
): DifferenceEvent {
  return {
    label,
    expectedIndex: op.expectedIndex,
    actualIndex: op.actualIndex,
    expected: op.expected,
    actual: op.actual,
  };
}

function coalesceRuns(events: DifferenceEvent[]): DifferenceEvent[] {
  const coalesced: DifferenceEvent[] = [];
  for (const event of events) {
    const previous = coalesced[coalesced.length - 1];
    if (
      previous &&
      previous.label === event.label &&
      previous.expectedIndex !== undefined &&
      event.expectedIndex !== undefined &&
      previous.actualIndex !== undefined &&
      event.actualIndex !== undefined &&
      previous.expectedIndex + (previous.length ?? 1) === event.expectedIndex &&
      previous.actualIndex + (previous.length ?? 1) === event.actualIndex
    ) {
      previous.length = (previous.length ?? 1) + 1;
      previous.expected = `${previous.expected ?? ""}${event.expected ?? ""}`;
      previous.actual = `${previous.actual ?? ""}${event.actual ?? ""}`;
      continue;
    }
    coalesced.push({ ...event, length: event.length ?? 1 });
  }
  return coalesced;
}

function summarizeLayoutSwaps(events: DifferenceEvent[]): LayoutSwapDetail[] {
  const counts = new Map<string, LayoutSwapDetail>();
  for (const event of events) {
    if (event.label !== "layout-swap-signature") {
      continue;
    }
    const expectedChars = [...(event.expected ?? "")];
    const actualChars = [...(event.actual ?? "")];
    for (let index = 0; index < expectedChars.length; index += 1) {
      const from = expectedChars[index];
      const to = actualChars[index];
      if (from === undefined || to === undefined) {
        continue;
      }
      const pair = layoutPairName(from, to);
      const key = `${pair}:${from}->${to}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { pair, from, to, count: 1 });
      }
    }
  }
  return [...counts.values()].sort((a, b) => `${a.pair}${a.from}${a.to}`.localeCompare(`${b.pair}${b.from}${b.to}`));
}

function diffCodePoints(expected: string[], actual: string[]): DiffOp[] {
  let prefixLength = 0;
  while (
    prefixLength < expected.length &&
    prefixLength < actual.length &&
    expected[prefixLength] === actual[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < expected.length - prefixLength &&
    suffixLength < actual.length - prefixLength &&
    expected[expected.length - 1 - suffixLength] === actual[actual.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const ops: DiffOp[] = [];
  for (let index = 0; index < prefixLength; index += 1) {
    ops.push({
      kind: "equal",
      expectedIndex: index,
      actualIndex: index,
      expected: expected[index] as string,
      actual: actual[index] as string,
    });
  }

  const expectedMiddle = expected.slice(prefixLength, expected.length - suffixLength);
  const actualMiddle = actual.slice(prefixLength, actual.length - suffixLength);
  const middleOps =
    expectedMiddle.length * actualMiddle.length <= 2_000_000
      ? diffWithDynamicProgramming(expectedMiddle, actualMiddle, prefixLength, prefixLength)
      : diffWithGreedyLookahead(expectedMiddle, actualMiddle, prefixLength, prefixLength);
  ops.push(...middleOps);

  for (let index = suffixLength; index > 0; index -= 1) {
    const expectedIndex = expected.length - index;
    const actualIndex = actual.length - index;
    ops.push({
      kind: "equal",
      expectedIndex,
      actualIndex,
      expected: expected[expectedIndex] as string,
      actual: actual[actualIndex] as string,
    });
  }
  return ops;
}

function diffWithDynamicProgramming(
  expected: string[],
  actual: string[],
  expectedOffset: number,
  actualOffset: number,
): DiffOp[] {
  const width = actual.length + 1;
  const costs = Array.from({ length: expected.length + 1 }, () => Array<number>(width).fill(0));
  const prev = Array.from({ length: expected.length + 1 }, () => Array<"diag" | "drop" | "insert" | ""> (width).fill(""));

  for (let i = 1; i <= expected.length; i += 1) {
    costs[i]![0] = i;
    prev[i]![0] = "drop";
  }
  for (let j = 1; j <= actual.length; j += 1) {
    costs[0]![j] = j;
    prev[0]![j] = "insert";
  }

  for (let i = 1; i <= expected.length; i += 1) {
    for (let j = 1; j <= actual.length; j += 1) {
      const diagonalCost = costs[i - 1]![j - 1]! + (expected[i - 1] === actual[j - 1] ? 0 : 1);
      const dropCost = costs[i - 1]![j]! + 1;
      const insertCost = costs[i]![j - 1]! + 1;
      const best = Math.min(diagonalCost, dropCost, insertCost);

      costs[i]![j] = best;
      if (diagonalCost === best) {
        prev[i]![j] = "diag";
      } else if (dropCost === best) {
        prev[i]![j] = "drop";
      } else {
        prev[i]![j] = "insert";
      }
    }
  }

  const reversed: DiffOp[] = [];
  let i = expected.length;
  let j = actual.length;
  while (i > 0 || j > 0) {
    const step = prev[i]![j]!;
    if (step === "diag") {
      const expectedChar = expected[i - 1] as string;
      const actualChar = actual[j - 1] as string;
      reversed.push({
        kind: expectedChar === actualChar ? "equal" : "substitute",
        expectedIndex: expectedOffset + i - 1,
        actualIndex: actualOffset + j - 1,
        expected: expectedChar,
        actual: actualChar,
      });
      i -= 1;
      j -= 1;
    } else if (step === "drop") {
      reversed.push({
        kind: "drop",
        expectedIndex: expectedOffset + i - 1,
        expected: expected[i - 1] as string,
      });
      i -= 1;
    } else {
      reversed.push({
        kind: "insert",
        actualIndex: actualOffset + j - 1,
        actual: actual[j - 1] as string,
      });
      j -= 1;
    }
  }

  return reversed.reverse();
}

function diffWithGreedyLookahead(
  expected: string[],
  actual: string[],
  expectedOffset: number,
  actualOffset: number,
): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  const lookahead = 64;

  while (i < expected.length || j < actual.length) {
    if (i < expected.length && j < actual.length && expected[i] === actual[j]) {
      ops.push({
        kind: "equal",
        expectedIndex: expectedOffset + i,
        actualIndex: actualOffset + j,
        expected: expected[i] as string,
        actual: actual[j] as string,
      });
      i += 1;
      j += 1;
      continue;
    }

    const actualMatch = i < expected.length ? findNext(actual, expected[i] as string, j + 1, lookahead) : -1;
    const expectedMatch = j < actual.length ? findNext(expected, actual[j] as string, i + 1, lookahead) : -1;

    if (actualMatch !== -1 && (expectedMatch === -1 || actualMatch - j <= expectedMatch - i)) {
      while (j < actualMatch) {
        ops.push({
          kind: "insert",
          actualIndex: actualOffset + j,
          actual: actual[j] as string,
        });
        j += 1;
      }
      continue;
    }

    if (expectedMatch !== -1) {
      while (i < expectedMatch) {
        ops.push({
          kind: "drop",
          expectedIndex: expectedOffset + i,
          expected: expected[i] as string,
        });
        i += 1;
      }
      continue;
    }

    if (i < expected.length && j < actual.length) {
      ops.push({
        kind: "substitute",
        expectedIndex: expectedOffset + i,
        actualIndex: actualOffset + j,
        expected: expected[i] as string,
        actual: actual[j] as string,
      });
      i += 1;
      j += 1;
    } else if (i < expected.length) {
      ops.push({
        kind: "drop",
        expectedIndex: expectedOffset + i,
        expected: expected[i] as string,
      });
      i += 1;
    } else {
      ops.push({
        kind: "insert",
        actualIndex: actualOffset + j,
        actual: actual[j] as string,
      });
      j += 1;
    }
  }

  return ops;
}

function findNext(items: string[], target: string, start: number, maxDistance: number): number {
  const end = Math.min(items.length, start + maxDistance);
  for (let index = start; index < end; index += 1) {
    if (items[index] === target) {
      return index;
    }
  }
  return -1;
}

function isConsecutiveSubstitution(
  previous: Extract<DiffOp, { kind: "substitute" }> | undefined,
  current: Extract<DiffOp, { kind: "substitute" }> | undefined,
): boolean {
  return (
    previous !== undefined &&
    current !== undefined &&
    previous.expectedIndex + 1 === current.expectedIndex &&
    previous.actualIndex + 1 === current.actualIndex
  );
}

function isWrongShift(expected: string | undefined, actual: string | undefined): boolean {
  if (expected === undefined || actual === undefined) {
    return false;
  }
  return shiftCounterpart.get(expected) === actual;
}

function isCaseError(expected: string, actual: string): boolean {
  return (
    expected !== actual &&
    expected.length === 1 &&
    actual.length === 1 &&
    /[A-Za-z]/.test(expected) &&
    expected.toLocaleLowerCase("en-GB") === actual.toLocaleLowerCase("en-GB")
  );
}

function isLayoutSwapCandidate(expected: string, actual: string): boolean {
  return LAYOUT_PAIRS.some(
    ([left, right]) => (left === expected && right === actual) || (right === expected && left === actual),
  );
}

function layoutPairName(from: string, to: string): string {
  for (const [left, right] of LAYOUT_PAIRS) {
    if ((left === from && right === to) || (left === to && right === from)) {
      return `${left}<->${right}`;
    }
  }
  return `${from}<->${to}`;
}

function makeBidirectionalMap(pairs: ReadonlyArray<readonly [string, string]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [left, right] of pairs) {
    map.set(left, right);
    map.set(right, left);
  }
  return map;
}
