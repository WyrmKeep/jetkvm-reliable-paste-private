import { PassThrough, Writable } from "node:stream";

import {
  ListToolsResultSchema,
  type CallToolResult,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JETKVM_TOOL_NAMES, type JetKvmToolName } from "../domain.js";
import type { HandlerRegistry, JetKvmToolHandler } from "./server.js";
import { startStdioServer, type StdioServerHandle } from "./stdio.js";

function businessError(
  tool: JetKvmToolName,
  code = "CONFIG_INVALID",
): CallToolResult {
  const isRead =
    tool === "jetkvm_display_capture" ||
    tool === "jetkvm_display_status" ||
    tool === "jetkvm_session_status";
  const payload = {
    ok: false as const,
    tool,
    operation_id: "operation-stdio",
    session_id: null,
    session_generation: null,
    duration_ms: 0,
    error: {
      code,
      message: "deterministic stdio result",
      phase: "validate" as const,
      outcome: isRead ? null : ("not_sent" as const),
      verification: "none" as const,
      safe_to_retry: false,
      required_next_step: "none" as const,
      details: {
        permission: null,
        capability: null,
        failed_action_index: null,
        dispatched_action_count: null,
        completed_action_count: null,
        downstream_stage: "none" as const,
        expected_generation: null,
        actual_generation: null,
        observation_id: null,
      },
    },
  };
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function completeRegistry(
  override?: Partial<Record<JetKvmToolName, JetKvmToolHandler>>,
): HandlerRegistry {
  return {
    ...Object.fromEntries(
      JETKVM_TOOL_NAMES.map((name) => [name, async () => businessError(name)]),
    ),
    ...override,
  } as HandlerRegistry;
}

class JsonLineCollector {
  readonly messages: JSONRPCMessage[] = [];
  readonly rawChunks: string[] = [];
  #buffer = "";
  #waiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(stream: PassThrough) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.rawChunks.push(chunk);
      this.#buffer += chunk;
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        this.messages.push(JSON.parse(line) as JSONRPCMessage);
      }
      this.#flushWaiters();
    });
  }

  async waitForCount(count: number): Promise<void> {
    if (this.messages.length >= count) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waiters.push({ count, resolve });
    await promise;
  }

  #flushWaiters(): void {
    const pending = this.#waiters.splice(0);
    for (const waiter of pending) {
      if (this.messages.length >= waiter.count) waiter.resolve();
      else this.#waiters.push(waiter);
    }
  }
}

function initialize(id: number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-black-box", version: "1.0.0" },
    },
  };
}

class ControlledWritable extends Writable {
  readonly chunks: Buffer[] = [];
  readonly #callbacks: Array<() => void> = [];
  readonly #waiters: Array<{ count: number; resolve: () => void }> = [];

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    this.#callbacks.push(callback);
    this.#flushWaiters();
  }

  releaseNext(): void {
    const callback = this.#callbacks.shift();
    if (callback === undefined)
      throw new Error("No controlled write to release");
    callback();
  }

  async waitForCount(count: number): Promise<void> {
    if (this.chunks.length >= count) return;
    const pending = Promise.withResolvers<void>();
    this.#waiters.push({ count, resolve: pending.resolve });
    await pending.promise;
  }

  #flushWaiters(): void {
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      if (this.chunks.length >= waiter.count) waiter.resolve();
      else this.#waiters.push(waiter);
    }
  }
}

class EpipeWritable extends Writable {
  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    _callback: (error?: Error | null) => void,
  ): void {
    const error = Object.assign(new Error("private downstream path"), {
      code: "EPIPE",
    });
    queueMicrotask(() => this.emit("error", error));
  }
}

function send(stream: PassThrough, message: JSONRPCMessage): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

const handles: StdioServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("stdio adapter", () => {
  it("uses SDK newline framing for partial and multiple messages with protocol-only stdout", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const errors: Error[] = [];
    const collector = new JsonLineCollector(stdout);
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
      onError: (error) => errors.push(error),
    });
    handles.push(handle);

    const initializeLine = `${JSON.stringify(initialize(1))}\r\n`;
    stdin.write(initializeLine.slice(0, 13));
    expect(collector.messages).toEqual([]);
    stdin.write(initializeLine.slice(13));
    await collector.waitForCount(1);

    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );
    await collector.waitForCount(2);

    expect(collector.messages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "jetkvm-mcp", version: "0.1.0" } },
    });
    expect(collector.messages[1]).toMatchObject({ jsonrpc: "2.0", id: 2 });
    const listMessage = collector.messages[1];
    if (!listMessage || !("result" in listMessage)) {
      throw new Error("Expected tools/list result response");
    }
    const listed = ListToolsResultSchema.parse(listMessage.result);
    expect(listed.tools.map((tool) => tool.name)).toEqual(JETKVM_TOOL_NAMES);
    expect(
      collector.rawChunks.join("").split("\n").filter(Boolean),
    ).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it("dispatches calls and turns cancellation notifications into an aborted handler signal", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collector = new JsonLineCollector(stdout);
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const handler = vi.fn(
      async (_input: unknown, extra: { signal: AbortSignal }) => {
        entered.resolve();
        if (!extra.signal.aborted) {
          const aborted = Promise.withResolvers<void>();
          extra.signal.addEventListener("abort", () => aborted.resolve(), {
            once: true,
          });
          await aborted.promise;
        }
        cancelled.resolve();
        return businessError("jetkvm_session_connect", "CANCELLED");
      },
    );
    const handle = await startStdioServer(
      completeRegistry({ jetkvm_session_connect: handler }),
      { stdin, stdout },
    );
    handles.push(handle);

    send(stdin, initialize(1));
    await collector.waitForCount(1);
    send(stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(stdin, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "jetkvm_session_connect",
        arguments: { request_id: "request-cancel", timeout_ms: 60_000 },
      },
    });
    await entered.promise;
    send(stdin, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 9, reason: "test cancellation" },
    });
    await cancelled.promise;
    await handle.close();

    expect(handler).toHaveBeenCalledOnce();
    expect(collector.messages).toHaveLength(1);
  });

  it("reports malformed frames, emits no garbage, and continues with the next valid frame", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collector = new JsonLineCollector(stdout);
    const errors: Error[] = [];
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
      onError: (error) => errors.push(error),
    });
    handles.push(handle);

    stdin.write('{"jsonrpc":"2.0","id":1,broken}\n');
    send(stdin, initialize(2));
    await collector.waitForCount(1);

    expect(errors).toHaveLength(1);
    expect(collector.messages).toHaveLength(1);
    expect(collector.messages[0]).toMatchObject({
      id: 2,
      result: expect.any(Object),
    });
    expect(collector.rawChunks.join("")).not.toContain("broken");
  });

  it.each(["unterminated", "newline-terminated"] as const)(
    "closes without dispatch when a %s frame exceeds 1 MiB",
    async (kind) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const errors: Error[] = [];
      const handler = vi.fn(async (_input: unknown) =>
        businessError("jetkvm_session_connect"),
      );
      const handle = await startStdioServer(
        completeRegistry({ jetkvm_session_connect: handler }),
        {
          stdin,
          stdout,
          onError: (error) => errors.push(error),
        },
      );
      handles.push(handle);

      const oversized = Buffer.alloc(1_048_577, 0x20);
      stdin.write(
        kind === "newline-terminated"
          ? Buffer.concat([oversized, Buffer.from("\n")])
          : oversized,
      );
      await handle.closed;

      expect(errors.map((error) => error.message)).toEqual([
        "Inbound stdio frame exceeds 1048576 bytes",
      ]);
      expect(handler).not.toHaveBeenCalled();
      expect(stdout.readableLength).toBe(0);
    },
  );

  it("accepts an exactly 1 MiB JSON frame with a fragmented CRLF delimiter", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collector = new JsonLineCollector(stdout);
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
    });
    handles.push(handle);
    const json = JSON.stringify(initialize(1));
    const padding = " ".repeat(1_048_576 - Buffer.byteLength(json));

    stdin.write(`${json}${padding}\r`);
    expect(collector.messages).toEqual([]);
    stdin.write("\n");
    await collector.waitForCount(1);

    expect(collector.messages[0]).toMatchObject({
      id: 1,
      result: expect.any(Object),
    });
  });

  it("reports and discards a residual non-newline frame at EOF", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const errors: Error[] = [];
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
      onError: (error) => errors.push(error),
    });
    handles.push(handle);

    stdin.end('{"jsonrpc":"2.0"');
    await handle.closed;

    expect(errors.map((error) => error.message)).toEqual([
      "Incomplete stdio frame at EOF",
    ]);
    expect(stdout.readableLength).toBe(0);
  });

  it("accepts one maximum legal 8 MiB PNG response within the output cap", async () => {
    const stdin = new PassThrough();
    const stdout = new ControlledWritable();
    const errors: Error[] = [];
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
      onError: (error) => errors.push(error),
    });
    handles.push(handle);
    const maximumPngBase64Length = 4 * Math.ceil((8 * 1024 * 1024) / 3);

    void handle.transport.send({
      jsonrpc: "2.0",
      id: 1,
      result: { image: "A".repeat(maximumPngBase64Length) },
    });
    await stdout.waitForCount(1);

    expect(stdout.chunks[0]?.byteLength).toBeGreaterThan(
      maximumPngBase64Length,
    );
    expect(stdout.chunks[0]?.byteLength).toBeLessThan(16 * 1024 * 1024);
    expect(errors).toEqual([]);
    stdout.releaseNext();
  });

  it("bounds stalled stdout across concurrent large responses and closes on overflow", async () => {
    const stdin = new PassThrough();
    const stdout = new ControlledWritable();
    const errors: Error[] = [];
    const largeText = "x".repeat(9 * 1024 * 1024);
    const handler = vi.fn(async () => businessError("jetkvm_session_connect"));
    const handle = await startStdioServer(
      completeRegistry({ jetkvm_session_connect: handler }),
      {
        stdin,
        stdout,
        onError: (error) => errors.push(error),
      },
    );
    handles.push(handle);

    for (const id of [2, 3, 4]) {
      void handle.transport.send({
        jsonrpc: "2.0",
        id,
        result: { payload: largeText },
      });
    }
    await handle.closed;

    expect(handler).not.toHaveBeenCalled();
    expect(errors.map((error) => error.message)).toEqual([
      "Outbound stdio queue exceeds 16777216 bytes",
    ]);
    expect(stdout.chunks).toHaveLength(1);
    expect(stdout.chunks[0]?.byteLength).toBeLessThan(10 * 1024 * 1024);
  });

  it("resumes stalled stdout in JSON-RPC response order", async () => {
    const stdin = new PassThrough();
    const stdout = new ControlledWritable();
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
    });
    handles.push(handle);

    send(stdin, initialize(1));
    await stdout.waitForCount(1);
    stdout.releaseNext();
    send(stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(stdin, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    send(stdin, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    await stdout.waitForCount(2);
    stdout.releaseNext();
    await stdout.waitForCount(3);

    expect(
      stdout.chunks.slice(1).map((chunk) => JSON.parse(chunk.toString()).id),
    ).toEqual([2, 3]);
    stdout.releaseNext();
  });

  it("closes on a bounded stdout write timeout", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new PassThrough();
      const stdout = new ControlledWritable();
      const errors: Error[] = [];
      const handle = await startStdioServer(completeRegistry(), {
        stdin,
        stdout,
        onError: (error) => errors.push(error),
      });
      handles.push(handle);

      send(stdin, initialize(1));
      await stdout.waitForCount(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await handle.closed;

      expect(errors.map((error) => error.message)).toEqual([
        "Outbound stdio write timed out after 10000 ms",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures EPIPE before the SDK writes and removes stdout listeners on close", async () => {
    const stdin = new PassThrough();
    const stdout = new EpipeWritable();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const handle = await startStdioServer(completeRegistry(), {
        stdin,
        stdout,
      });
      handles.push(handle);
      expect(stdout.listenerCount("error")).toBe(1);

      send(stdin, initialize(1));
      await handle.closed;

      expect(stderrWrite).toHaveBeenCalledOnce();
      expect(stderrWrite).toHaveBeenCalledWith(
        "jetkvm-mcp: stdio output failure\n",
      );
      expect(stdout.listenerCount("error")).toBe(0);
      await handle.close();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("treats EOF and repeated close as one cleanup", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
    });
    handles.push(handle);

    stdin.end();
    await handle.closed;
    await handle.close();
    await handle.close();

    expect(handle.isClosed()).toBe(true);
    expect(stdin.listenerCount("data")).toBe(0);
  });
});
