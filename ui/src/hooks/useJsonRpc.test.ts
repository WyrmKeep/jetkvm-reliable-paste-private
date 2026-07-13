import { describe, expect, it } from "vitest";

import { JsonRpcRequestFailure, requestJsonRpc, type JsonRpcRequestChannel } from "./useJsonRpc";

class FakeRpcChannel implements JsonRpcRequestChannel {
  readyState = "open";
  readonly writes: string[] = [];
  private readonly listeners: Record<string, Set<(event: MessageEvent | Event) => void>> = {};

  send(payload: string): void {
    this.writes.push(payload);
  }

  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    (this.listeners[type] ??= new Set()).add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    this.listeners[type]?.delete(listener);
  }
  listenerCount(type: string): number {
    return this.listeners[type]?.size ?? 0;
  }

  acknowledge(result: unknown = null): void {
    const written = JSON.parse(this.writes.at(-1) ?? "null") as unknown;
    if (typeof written !== "object" || written === null || !("id" in written)) {
      throw new Error("request id missing");
    }
    const payload = { jsonrpc: "2.0", id: written.id, result };
    const event = new MessageEvent("message", { data: JSON.stringify(payload) });
    for (const listener of this.listeners.message ?? []) listener(event);
  }
  acknowledgeWithoutResult(): void {
    const written = JSON.parse(this.writes.at(-1) ?? "null") as unknown;
    if (typeof written !== "object" || written === null || !("id" in written)) {
      throw new Error("request id missing");
    }
    this.emit({ jsonrpc: "2.0", id: written.id });
  }

  emit(payload: unknown): void {
    const event = new MessageEvent("message", { data: JSON.stringify(payload) });
    for (const listener of this.listeners.message ?? []) listener(event);
  }

  close(): void {
    this.readyState = "closed";
    for (const listener of this.listeners.close ?? []) listener(new Event("close"));
  }
}

describe("requestJsonRpc", () => {
  it("resolves only a correlated acknowledged write with an explicit null result", async () => {
    const channel = new FakeRpcChannel();
    let writes = 0;
    const response = requestJsonRpc(
      channel,
      "keypressReport",
      { key: 4, press: true },
      {
        operationId: "key-1",
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onWrite: () => writes++,
      },
    );
    channel.acknowledge();

    await expect(response).resolves.toBeNull();
    expect(writes).toBe(1);
    expect(channel.writes).toHaveLength(1);
  });
  it("rejects a correlated envelope that omits both result and error", async () => {
    const channel = new FakeRpcChannel();
    const response = requestJsonRpc(
      channel,
      "keypressReport",
      { key: 4, press: true },
      {
        operationId: "missing-result",
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onWrite: () => undefined,
      },
    );
    channel.acknowledgeWithoutResult();

    await expect(response).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
      writeBegan: true,
    });
  });

  it("rejects a closed channel before write instead of succeeding as a no-op", async () => {
    const channel = new FakeRpcChannel();
    channel.readyState = "closed";
    await expect(
      requestJsonRpc(
        channel,
        "absMouseReport",
        { x: 0, y: 0, buttons: 0 },
        {
          operationId: "mouse-1",
          timeoutMs: 1000,
          signal: new AbortController().signal,
          onWrite: () => undefined,
        },
      ),
    ).rejects.toEqual(new JsonRpcRequestFailure("CHANNEL_CLOSED", false));
    expect(channel.writes).toHaveLength(0);
  });

  it("reports channel loss after a queued write as uncertain", async () => {
    const channel = new FakeRpcChannel();
    const response = requestJsonRpc(
      channel,
      "wheelReport",
      { wheelY: 1 },
      {
        operationId: "wheel-1",
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onWrite: () => undefined,
      },
    );
    channel.close();

    await expect(response).rejects.toMatchObject({
      code: "CHANNEL_CLOSED",
      writeBegan: true,
    });
  });

  it("rejects malformed and downstream-error acknowledgements without exposing payload data", async () => {
    const channel = new FakeRpcChannel();
    const response = requestJsonRpc(
      channel,
      "getEDID",
      {},
      {
        operationId: "read-1",
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onWrite: () => undefined,
      },
    );
    const written = JSON.parse(channel.writes[0]) as unknown;
    if (typeof written !== "object" || written === null || !("id" in written)) {
      throw new Error("request id missing");
    }
    channel.emit({
      jsonrpc: "2.0",
      id: written.id,
      error: { code: -32000, message: "secret downstream detail" },
    });

    await expect(response).rejects.toMatchObject({
      code: "DOWNSTREAM_ERROR",
      message: "The product RPC request failed.",
      writeBegan: true,
    });
  });
  it("allowlists only the exact qualified EDID marker", async () => {
    const exactChannel = new FakeRpcChannel();
    const exact = requestJsonRpc(
      exactChannel,
      "getEDID",
      {},
      {
        operationId: "edid-exact",
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onWrite: () => undefined,
      },
    );
    const exactWrite = JSON.parse(exactChannel.writes[0]) as { id: string };
    exactChannel.emit({
      jsonrpc: "2.0",
      id: exactWrite.id,
      error: { code: -32603, message: "Internal error", data: "EDID_READ_FAILED" },
    });
    await expect(exact).rejects.toMatchObject({
      code: "EDID_READ_FAILED",
      message: "The product EDID read failed.",
    });

    const nearChannel = new FakeRpcChannel();
    const near = requestJsonRpc(
      nearChannel,
      "getEDID",
      {},
      {
        operationId: "edid-near",
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onWrite: () => undefined,
      },
    );
    const nearWrite = JSON.parse(nearChannel.writes[0]) as { id: string };
    nearChannel.emit({
      jsonrpc: "2.0",
      id: nearWrite.id,
      error: { code: -32603, message: "Internal error", data: "EDID_READ_FAILED " },
    });
    await expect(near).rejects.toMatchObject({ code: "DOWNSTREAM_ERROR" });
  });

  it("uses one bounded response router and rejects excessive nesting", async () => {
    const channel = new FakeRpcChannel();
    const first = requestJsonRpc(
      channel,
      "getVideoState",
      {},
      {
        operationId: "router-1",
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onWrite: () => undefined,
      },
    );
    const second = requestJsonRpc(
      channel,
      "getEDID",
      {},
      {
        operationId: "router-2",
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onWrite: () => undefined,
      },
    );
    expect(channel.listenerCount("message")).toBe(1);

    const firstWrite = JSON.parse(channel.writes[0]) as { id: string };
    let nested: unknown = null;
    for (let depth = 0; depth < 80; depth += 1) nested = [nested];
    channel.emit({ jsonrpc: "2.0", id: firstWrite.id, result: nested });
    await expect(first).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });

    const secondWrite = JSON.parse(channel.writes[1]) as { id: string };
    channel.emit({ jsonrpc: "2.0", id: secondWrite.id, result: "" });
    await expect(second).resolves.toBe("");
  });
});
