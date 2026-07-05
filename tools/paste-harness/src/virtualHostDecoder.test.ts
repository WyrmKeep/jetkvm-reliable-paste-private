import { describe, expect, test } from "vitest";

import {
  calibrateTypematicFromHold,
  decodeTeeLogText,
  type TypematicCalibration,
} from "./virtualHostDecoder.js";

const ZERO_KEYS = [0, 0, 0, 0, 0, 0] as const;

const HID = {
  KeyA: 0x04,
  KeyB: 0x05,
  KeyC: 0x06,
  Digit2: 0x1f,
  Digit3: 0x20,
  Delete: 0x4c,
  Enter: 0x28,
  Quote: 0x34,
} as const;

const MOD = {
  ControlLeft: 0x01,
  ShiftLeft: 0x02,
} as const;

function teeLog(
  reports: readonly {
    atMs: number;
    modifier: number;
    keys?: readonly number[];
    result?: string;
  }[],
): string {
  return reports
    .map((report) =>
      JSON.stringify({
        monotonic_ns: report.atMs * 1_000_000,
        wall_ns: 1_780_000_000_000_000_000 + report.atMs * 1_000_000,
        modifier: report.modifier,
        keys: padKeys(report.keys ?? ZERO_KEYS),
        result: report.result ?? "ok",
      }),
    )
    .join("\n");
}

function padKeys(keys: readonly number[]): number[] {
  return [...keys, ...ZERO_KEYS].slice(0, 6);
}

describe("virtual host decoder", () => {
  test("decodes a 1s hold as an initial key plus calibrated typematic repeats", () => {
    const calibration = calibrateTypematicFromHold({
      heldCharacter: "a",
      observedText: "aaaa",
      holdDurationMs: 1_000,
      delayMs: 250,
    });

    expect(calibration).toEqual<TypematicCalibration>({
      delayMs: 250,
      intervalMs: 250,
    });
    expect(
      decodeTeeLogText(
        teeLog([
          { atMs: 0, modifier: 0, keys: [HID.KeyA] },
          { atMs: 1_000, modifier: 0 },
        ]),
        { layout: "uk", typematic: calibration },
      ),
    ).toBe("aaaa");
  });

  test("uses the modifier in the same report as the key press", () => {
    expect(
      decodeTeeLogText(
        teeLog([
          { atMs: 0, modifier: MOD.ShiftLeft, keys: [HID.KeyA] },
          { atMs: 20, modifier: 0 },
        ]),
        { layout: "uk", typematic: false },
      ),
    ).toBe("A");
  });

  test("keeps Shift active across reports for a shifted run", () => {
    expect(
      decodeTeeLogText(
        teeLog([
          { atMs: 0, modifier: MOD.ShiftLeft, keys: [HID.KeyA] },
          { atMs: 20, modifier: MOD.ShiftLeft },
          { atMs: 40, modifier: MOD.ShiftLeft, keys: [HID.KeyB] },
          { atMs: 60, modifier: MOD.ShiftLeft },
          { atMs: 80, modifier: MOD.ShiftLeft, keys: [HID.KeyC] },
          { atMs: 100, modifier: 0 },
        ]),
        { layout: "uk", typematic: false },
      ),
    ).toBe("ABC");
  });

  test("decodes a stuck-shift tee sequence as a shifted region followed by normal text", () => {
    expect(
      decodeTeeLogText(
        teeLog([
          { atMs: 0, modifier: MOD.ShiftLeft, keys: [HID.KeyA] },
          { atMs: 20, modifier: MOD.ShiftLeft },
          { atMs: 40, modifier: MOD.ShiftLeft, keys: [HID.KeyB] },
          { atMs: 60, modifier: MOD.ShiftLeft },
          { atMs: 80, modifier: 0, keys: [HID.KeyC] },
          { atMs: 100, modifier: 0 },
        ]),
        { layout: "uk", typematic: false },
      ),
    ).toBe("ABc");
  });

  test("shows UK-intended reports under the US host layout as deterministic symbol swaps", () => {
    const ukIntendedSymbols = teeLog([
      { atMs: 0, modifier: MOD.ShiftLeft, keys: [HID.Quote] },
      { atMs: 10, modifier: 0 },
      { atMs: 20, modifier: MOD.ShiftLeft, keys: [HID.Digit2] },
      { atMs: 30, modifier: 0 },
      { atMs: 40, modifier: MOD.ShiftLeft, keys: [HID.Digit3] },
      { atMs: 50, modifier: 0 },
    ]);

    expect(decodeTeeLogText(ukIntendedSymbols, { layout: "uk", typematic: false })).toBe('@"£');
    expect(decodeTeeLogText(ukIntendedSymbols, { layout: "us", typematic: false })).toBe('"@#');
  });

  test("ignores control chords and non-printing keys around text reports", () => {
    expect(
      decodeTeeLogText(
        teeLog([
          { atMs: 0, modifier: MOD.ControlLeft, keys: [HID.KeyA] },
          { atMs: 20, modifier: 0 },
          { atMs: 40, modifier: 0, keys: [HID.Delete] },
          { atMs: 60, modifier: 0 },
          { atMs: 80, modifier: 0, keys: [HID.KeyA] },
          { atMs: 100, modifier: 0 },
          { atMs: 120, modifier: 0, keys: [HID.Enter] },
          { atMs: 140, modifier: 0 },
          { atMs: 160, modifier: MOD.ControlLeft, keys: [HID.KeyC] },
          { atMs: 180, modifier: 0 },
        ]),
        { layout: "uk", typematic: false },
      ),
    ).toBe("a\n");
  });
});
