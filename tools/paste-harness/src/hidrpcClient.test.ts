import { describe, expect, test } from "vitest";

import {
  HID_RPC_MESSAGE_TYPES,
  buildHidRpcSignalingUrl,
  buildClearDocumentMacroSteps,
  buildKeyboardMacroStepsForText,
  decodeCliText,
  marshalKeyboardMacroReport,
  parseHidRpcMessage,
} from "./hidrpcClient.js";

describe("hidrpc client macro helpers", () => {
  test("expands UK text into the same press plus reset macro steps as the UI", () => {
    expect(buildKeyboardMacroStepsForText("A£\n", { delayMs: 6 })).toEqual([
      { modifier: 0x02, keys: [0x04, 0, 0, 0, 0, 0], delay: 10 },
      { modifier: 0, keys: [0, 0, 0, 0, 0, 0], delay: 6 },
      { modifier: 0x02, keys: [0x20, 0, 0, 0, 0, 0], delay: 10 },
      { modifier: 0, keys: [0, 0, 0, 0, 0, 0], delay: 6 },
      { modifier: 0, keys: [0x28, 0, 0, 0, 0, 0], delay: 5 },
      { modifier: 0, keys: [0, 0, 0, 0, 0, 0], delay: 6 },
    ]);
  });

  test("marshals KeyboardMacroReport as type, paste flag, u32be count, then 9-byte steps", () => {
    const report = marshalKeyboardMacroReport([
      { modifier: 0x02, keys: [0x04, 0, 0, 0, 0, 0], delay: 10 },
      { modifier: 0, keys: [0, 0, 0, 0, 0, 0], delay: 6 },
    ]);

    expect([...report]).toEqual([
      HID_RPC_MESSAGE_TYPES.KeyboardMacroReport,
      1,
      0,
      0,
      0,
      2,
      0x02,
      0x04,
      0,
      0,
      0,
      0,
      0,
      0,
      10,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      6,
    ]);
  });

  test("builds a HID clear sequence for orchestrated fresh-sink runs", () => {
    expect(buildClearDocumentMacroSteps()).toEqual([
      { modifier: 0, keys: [0, 0, 0, 0, 0, 0], delay: 0 },
      { modifier: 0x01, keys: [0x04, 0, 0, 0, 0, 0], delay: 30 },
      { modifier: 0, keys: [0, 0, 0, 0, 0, 0], delay: 50 },
      { modifier: 0, keys: [0x4c, 0, 0, 0, 0, 0], delay: 30 },
      { modifier: 0, keys: [0, 0, 0, 0, 0, 0], delay: 300 },
      { modifier: 0, keys: [0, 0, 0, 0, 0, 0], delay: 0 },
    ]);
  });

  test("parses handshake ack and paste completion state messages", () => {
    expect(parseHidRpcMessage(Buffer.from([0x01, 0x01]))).toEqual({
      type: "handshake",
      version: 1,
    });
    expect(parseHidRpcMessage(Buffer.from([0x34, 0, 1, 0]))).toEqual({
      type: "keyboard-macro-state",
      state: false,
      isPaste: true,
      failed: false,
    });
  });

  test("decodes CLI escape sequences so --text 'hello\\n' sends a newline", () => {
    expect(decodeCliText("hello\\n\\\\tail")).toBe("hello\n\\tail");
  });

  test("builds authenticated signaling URLs from host strings", () => {
    expect(buildHidRpcSignalingUrl("192.168.1.110")).toBe(
      "ws://192.168.1.110/webrtc/signaling/client",
    );
    expect(buildHidRpcSignalingUrl("https://jet.example")).toBe(
      "wss://jet.example/webrtc/signaling/client",
    );
  });
});
