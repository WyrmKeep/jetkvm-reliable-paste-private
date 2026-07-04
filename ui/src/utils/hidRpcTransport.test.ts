import { describe, expect, test, vi } from "vitest";

import { HID_RPC_MESSAGE_TYPES, PointerReportMessage } from "@/hooks/hidRpc";

import { sendHidRpcMessage, type HidRpcSendChannel } from "./hidRpcTransport";

function fakeChannel(readyState = "open") {
  return {
    readyState,
    send: vi.fn(),
  } satisfies HidRpcSendChannel;
}

const sentBytes = (channel: HidRpcSendChannel) =>
  Array.from((vi.mocked(channel.send).mock.calls[0][0] as unknown) as Uint8Array);

describe("sendHidRpcMessage", () => {
  test("falls back to the reliable channel when ordered unreliable is unavailable", () => {
    const reliable = fakeChannel();
    const unreliableOrdered = fakeChannel("connecting");
    const message = new PointerReportMessage(1, 2, 3);

    const sent = sendHidRpcMessage(
      message,
      {
        reliable,
        unreliableOrdered,
      },
      {
        handshakeReady: true,
        unreliableOrderedReady: false,
        unreliableNonOrderedReady: false,
      },
      { useUnreliableChannel: true },
    );

    expect(sent).toBe(true);
    expect(reliable.send).toHaveBeenCalledTimes(1);
    expect(unreliableOrdered.send).not.toHaveBeenCalled();
    expect(sentBytes(reliable)).toEqual([
      HID_RPC_MESSAGE_TYPES.PointerReport,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      2,
      3,
    ]);
  });

  test("preserves ordered unreliable preference when that channel is ready", () => {
    const reliable = fakeChannel();
    const unreliableOrdered = fakeChannel();

    const sent = sendHidRpcMessage(
      new PointerReportMessage(4, 5, 6),
      {
        reliable,
        unreliableOrdered,
      },
      {
        handshakeReady: true,
        unreliableOrderedReady: true,
        unreliableNonOrderedReady: false,
      },
      { useUnreliableChannel: true },
    );

    expect(sent).toBe(true);
    expect(unreliableOrdered.send).toHaveBeenCalledTimes(1);
    expect(reliable.send).not.toHaveBeenCalled();
  });

  test("falls back to reliable when non-ordered unreliable is requested but not ready", () => {
    const reliable = fakeChannel();
    const unreliableNonOrdered = fakeChannel("closed");

    const sent = sendHidRpcMessage(
      new PointerReportMessage(7, 8, 9),
      {
        reliable,
        unreliableNonOrdered,
      },
      {
        handshakeReady: true,
        unreliableOrderedReady: false,
        unreliableNonOrderedReady: false,
      },
      { useUnreliableChannel: true, requireOrdered: false },
    );

    expect(sent).toBe(true);
    expect(reliable.send).toHaveBeenCalledTimes(1);
    expect(unreliableNonOrdered.send).not.toHaveBeenCalled();
  });

  test("preserves non-ordered unreliable preference when that channel is ready", () => {
    const reliable = fakeChannel();
    const unreliableNonOrdered = fakeChannel();

    const sent = sendHidRpcMessage(
      new PointerReportMessage(10, 11, 12),
      {
        reliable,
        unreliableNonOrdered,
      },
      {
        handshakeReady: true,
        unreliableOrderedReady: false,
        unreliableNonOrderedReady: true,
      },
      { useUnreliableChannel: true, requireOrdered: false },
    );

    expect(sent).toBe(true);
    expect(unreliableNonOrdered.send).toHaveBeenCalledTimes(1);
    expect(reliable.send).not.toHaveBeenCalled();
  });
});
