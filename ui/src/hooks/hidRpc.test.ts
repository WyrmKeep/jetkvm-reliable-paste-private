import { describe, expect, test } from "vitest";

import {
  HID_RPC_MESSAGE_TYPES,
  KeyboardMacroReportMessage,
  type KeyboardMacroStep,
} from "./hidRpc";

describe("KeyboardMacroReportMessage", () => {
  test("marshals short key arrays without mutating source steps", () => {
    const step: KeyboardMacroStep = {
      modifier: 2,
      keys: [4],
      delay: 25,
    };

    const data = new KeyboardMacroReportMessage(true, 1, [step]).marshal();

    expect(step.keys).toEqual([4]);
    expect(data).toEqual(
      new Uint8Array([
        HID_RPC_MESSAGE_TYPES.KeyboardMacroReport,
        1,
        0,
        0,
        0,
        1,
        2,
        4,
        0,
        0,
        0,
        0,
        0,
        0,
        25,
      ]),
    );
  });

  test("validates source keys without padding them first", () => {
    const step: KeyboardMacroStep = {
      modifier: 0,
      keys: [300],
      delay: 0,
    };

    expect(() => new KeyboardMacroReportMessage(true, 1, [step]).marshal()).toThrow(
      "Key 300 is not within the uint8 range",
    );
    expect(step.keys).toEqual([300]);
  });
});
