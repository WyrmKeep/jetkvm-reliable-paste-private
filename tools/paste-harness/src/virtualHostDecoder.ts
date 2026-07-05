import { parseTeeLog, type TeeRecord } from "./teePacing.js";

export type VirtualHostLayout = "uk" | "us" | "en-UK" | "en-US";

export interface TypematicCalibration {
  delayMs: number;
  intervalMs: number;
}

export interface DecodeTeeLogOptions {
  layout: VirtualHostLayout;
  typematic?: TypematicCalibration | false;
}

export interface VirtualHostDecodeResult {
  text: string;
  layout: "uk" | "us";
  recordsProcessed: number;
  ignoredReports: number;
  emittedKeypresses: number;
  emittedRepeats: number;
  unknownKeyReports: number;
}

export interface TypematicHoldCalibrationInput {
  heldCharacter: string;
  observedText: string;
  holdDurationMs: number;
  delayMs: number;
}

interface KeyOutput {
  normal: string;
  shift?: string;
  altRight?: string;
}

interface ActiveKeyState {
  pressedAtNs: number;
  emittedRepeats: number;
}

const MODIFIER_SHIFT_MASK = 0x02 | 0x20;
const MODIFIER_LEFT_CONTROL = 0x01;
const MODIFIER_LEFT_ALT = 0x04;
const MODIFIER_LEFT_GUI = 0x08;
const MODIFIER_RIGHT_CONTROL = 0x10;
const MODIFIER_RIGHT_ALT = 0x40;
const MODIFIER_RIGHT_GUI = 0x80;

const NON_TEXT_MODIFIER_MASK = MODIFIER_LEFT_ALT | MODIFIER_LEFT_GUI | MODIFIER_RIGHT_GUI;

export const DEFAULT_TYPEMATIC_CALIBRATION: TypematicCalibration = {
  delayMs: 500,
  intervalMs: 33,
};

const BASE_LAYOUT = new Map<number, KeyOutput>([
  [0x28, { normal: "\n" }],
  [0x2b, { normal: "\t" }],
  [0x2c, { normal: " " }],
  [0x2d, { normal: "-", shift: "_" }],
  [0x2e, { normal: "=", shift: "+" }],
  [0x2f, { normal: "[", shift: "{" }],
  [0x30, { normal: "]", shift: "}" }],
  [0x33, { normal: ";", shift: ":" }],
  [0x36, { normal: ",", shift: "<" }],
  [0x37, { normal: ".", shift: ">" }],
  [0x38, { normal: "/", shift: "?" }],
]);

const US_LAYOUT = new Map<number, KeyOutput>([
  ...letters(),
  ...digits({
    digit2Shift: "@",
    digit3Shift: "#",
  }),
  ...BASE_LAYOUT,
  [0x31, { normal: "\\", shift: "|" }],
  [0x34, { normal: "'", shift: '"' }],
  [0x35, { normal: "`", shift: "~" }],
  [0x64, { normal: "\\", shift: "|" }],
]);

const UK_LAYOUT = new Map<number, KeyOutput>([
  ...letters(),
  ...digits({
    digit2Shift: '"',
    digit3Shift: "£",
  }),
  ...BASE_LAYOUT,
  [0x21, { normal: "4", shift: "$", altRight: "€" }],
  [0x31, { normal: "#", shift: "~" }],
  [0x34, { normal: "'", shift: "@" }],
  [0x35, { normal: "`", shift: "¬" }],
  [0x64, { normal: "\\", shift: "|" }],
]);

export function decodeTeeLogText(teeLog: string, options: DecodeTeeLogOptions): string {
  return decodeTeeLog(teeLog, options).text;
}

export function decodeTeeLog(teeLog: string, options: DecodeTeeLogOptions): VirtualHostDecodeResult {
  return decodeTeeRecords(parseTeeLog(teeLog), options);
}

export function decodeTeeRecords(
  records: readonly TeeRecord[],
  options: DecodeTeeLogOptions,
): VirtualHostDecodeResult {
  const layout = normalizeLayout(options.layout);
  const typematic = normalizeTypematic(options.typematic);
  const activeKeys = new Map<number, ActiveKeyState>();
  let currentKeyOrder: number[] = [];
  let currentModifier = 0;
  let lastAppliedNs: number | undefined;
  let text = "";
  let ignoredReports = 0;
  let emittedKeypresses = 0;
  let emittedRepeats = 0;
  let unknownKeyReports = 0;

  const emitKey = (keyCode: number, modifier: number): boolean => {
    const decoded = decodeKeyCode(keyCode, modifier, layout);
    if (decoded === undefined) {
      unknownKeyReports += 1;
      return false;
    }
    text += decoded;
    return true;
  };

  const emitRepeats = (untilNs: number) => {
    if (typematic === false || lastAppliedNs === undefined) {
      return;
    }
    for (const keyCode of currentKeyOrder) {
      const state = activeKeys.get(keyCode);
      if (state === undefined) {
        continue;
      }
      const repeatsDue = countTypematicRepeats(untilNs - state.pressedAtNs, typematic);
      const newRepeats = repeatsDue - state.emittedRepeats;
      if (newRepeats <= 0) {
        continue;
      }
      const decoded = decodeKeyCode(keyCode, currentModifier, layout);
      if (decoded === undefined) {
        unknownKeyReports += newRepeats;
      } else {
        text += decoded.repeat(newRepeats);
        emittedRepeats += newRepeats;
      }
      state.emittedRepeats = repeatsDue;
    }
  };

  for (const record of records) {
    if (record.result !== "ok") {
      ignoredReports += 1;
      continue;
    }
    if (lastAppliedNs !== undefined) {
      if (record.monotonic_ns < lastAppliedNs) {
        throw new Error("tee monotonic_ns must not decrease across successful reports");
      }
      emitRepeats(record.monotonic_ns);
    }

    const previousKeySet = new Set(currentKeyOrder);
    const nextKeyOrder = normalizeReportKeys(record.keys);
    const nextKeySet = new Set(nextKeyOrder);

    for (const keyCode of currentKeyOrder) {
      if (!nextKeySet.has(keyCode)) {
        activeKeys.delete(keyCode);
      }
    }

    for (const keyCode of nextKeyOrder) {
      if (previousKeySet.has(keyCode)) {
        continue;
      }
      activeKeys.set(keyCode, {
        pressedAtNs: record.monotonic_ns,
        emittedRepeats: 0,
      });
      if (emitKey(keyCode, record.modifier)) {
        emittedKeypresses += 1;
      }
    }

    currentKeyOrder = nextKeyOrder;
    currentModifier = record.modifier;
    lastAppliedNs = record.monotonic_ns;
  }

  return {
    text,
    layout,
    recordsProcessed: records.length,
    ignoredReports,
    emittedKeypresses,
    emittedRepeats,
    unknownKeyReports,
  };
}

export function calibrateTypematicFromHold(input: TypematicHoldCalibrationInput): TypematicCalibration {
  const observed = Array.from(input.observedText);
  const held = Array.from(input.heldCharacter);
  if (held.length !== 1) {
    throw new Error("heldCharacter must be exactly one Unicode code point");
  }
  if (observed.length === 0 || observed.some((char) => char !== held[0])) {
    throw new Error("observedText must contain only repeats of heldCharacter");
  }
  const repeatCount = observed.length - 1;
  if (repeatCount <= 0) {
    throw new Error("observedText must include at least one typematic repeat");
  }
  assertNonNegativeFinite(input.delayMs, "delayMs");
  assertPositiveFinite(input.holdDurationMs, "holdDurationMs");
  if (input.holdDurationMs <= input.delayMs) {
    throw new Error("holdDurationMs must exceed delayMs to calibrate typematic repeats");
  }
  return {
    delayMs: input.delayMs,
    intervalMs: (input.holdDurationMs - input.delayMs) / repeatCount,
  };
}

function normalizeLayout(layout: VirtualHostLayout): "uk" | "us" {
  switch (layout) {
    case "uk":
    case "en-UK":
      return "uk";
    case "us":
    case "en-US":
      return "us";
    default:
      throw new Error(`unsupported virtual host layout ${String(layout)}`);
  }
}

function normalizeTypematic(typematic: TypematicCalibration | false | undefined): TypematicCalibration | false {
  if (typematic === false) {
    return false;
  }
  const calibration = typematic ?? DEFAULT_TYPEMATIC_CALIBRATION;
  assertNonNegativeFinite(calibration.delayMs, "typematic.delayMs");
  assertPositiveFinite(calibration.intervalMs, "typematic.intervalMs");
  return calibration;
}

function normalizeReportKeys(keys: readonly number[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const key of keys) {
    if (key === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(key);
  }
  return result;
}

function decodeKeyCode(keyCode: number, modifier: number, layout: "uk" | "us"): string | undefined {
  const table = layout === "uk" ? UK_LAYOUT : US_LAYOUT;
  const output = table.get(keyCode);
  if (output === undefined) {
    return undefined;
  }
  if ((modifier & NON_TEXT_MODIFIER_MASK) !== 0) {
    return undefined;
  }

  const altRight = (modifier & MODIFIER_RIGHT_ALT) !== 0;
  const control = (modifier & (MODIFIER_LEFT_CONTROL | MODIFIER_RIGHT_CONTROL)) !== 0;
  if (altRight) {
    return output.altRight;
  }
  if (control) {
    return undefined;
  }

  return (modifier & MODIFIER_SHIFT_MASK) !== 0 ? (output.shift ?? output.normal) : output.normal;
}

function countTypematicRepeats(heldNs: number, calibration: TypematicCalibration): number {
  const heldMs = heldNs / 1_000_000;
  if (heldMs <= calibration.delayMs) {
    return 0;
  }
  return Math.ceil((heldMs - calibration.delayMs) / calibration.intervalMs);
}

function letters(): [number, KeyOutput][] {
  const entries: [number, KeyOutput][] = [];
  for (let index = 0; index < 26; index += 1) {
    const lower = String.fromCharCode("a".charCodeAt(0) + index);
    entries.push([0x04 + index, { normal: lower, shift: lower.toUpperCase() }]);
  }
  return entries;
}

function digits(overrides: { digit2Shift: string; digit3Shift: string }): [number, KeyOutput][] {
  return [
    [0x1e, { normal: "1", shift: "!" }],
    [0x1f, { normal: "2", shift: overrides.digit2Shift }],
    [0x20, { normal: "3", shift: overrides.digit3Shift }],
    [0x21, { normal: "4", shift: "$" }],
    [0x22, { normal: "5", shift: "%" }],
    [0x23, { normal: "6", shift: "^" }],
    [0x24, { normal: "7", shift: "&" }],
    [0x25, { normal: "8", shift: "*" }],
    [0x26, { normal: "9", shift: "(" }],
    [0x27, { normal: "0", shift: ")" }],
  ];
}

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
}
