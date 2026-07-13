import { createHash } from "node:crypto";
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
  readonly #callbacks: Array<(error?: Error | null) => void> = [];
  readonly #waiters: Array<{ count: number; resolve: () => void }> = [];
  unrefCalls = 0;

  constructor(highWaterMark = 1) {
    super({ highWaterMark });
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
  failNext(): void {
    const callback = this.#callbacks.shift();
    if (callback === undefined) throw new Error("No controlled write to fail");
    callback(
      Object.assign(new Error("late private output failure"), {
        code: "EPIPE",
      }),
    );
  }

  unref(): this {
    this.unrefCalls += 1;
    return this;
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

class DestroyReleasesWritable extends Writable {
  readonly writeStarted = Promise.withResolvers<void>();
  destroyCalls = 0;
  unrefCalls = 0;
  #activeWrite: ((error?: Error | null) => void) | undefined;

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#activeWrite = callback;
    this.writeStarted.resolve();
  }

  releaseActive(): void {
    const activeWrite = this.#activeWrite;
    if (activeWrite === undefined)
      throw new Error("No active write to release");
    this.#activeWrite = undefined;
    activeWrite();
  }

  override _destroy(
    _error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.destroyCalls += 1;
    const activeWrite = this.#activeWrite;
    this.#activeWrite = undefined;
    activeWrite?.();
    callback();
  }

  unref(): this {
    this.unrefCalls += 1;
    return this;
  }
}

class CallbackEpipeWritable extends Writable {
  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,

    callback: (error?: Error | null) => void,
  ): void {
    callback(
      Object.assign(new Error("private callback path"), {
        code: "EPIPE",
      }),
    );
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

class ThrowingWritable extends Writable {
  override _write(): void {
    throw new Error("private synchronous output failure");
  }
}

async function waitForImmediateSettlement(): Promise<void> {
  const settled = Promise.withResolvers<void>();
  setImmediate(settled.resolve).unref();
  await settled.promise;
}

function send(stream: PassThrough, message: JSONRPCMessage): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

function pasteCallFrame(id: number, textBytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"jetkvm_input_paste","arguments":{"session_id":"session-a","session_generation":1,"observation_id":"observation-a","request_id":"request-a","text":"`,
      "utf8",
    ),
    textBytes,
    Buffer.from('","timeout_ms":100}}}\n', "utf8"),
  ]);
}

function capturePendingBuffers(): {
  readonly buffers: Buffer[];
  readonly allocatePendingBuffer: (size: number) => Buffer;
} {
  const buffers: Buffer[] = [];
  return {
    buffers,
    allocatePendingBuffer: (size) => {
      const buffer = Buffer.allocUnsafe(size);
      buffers.push(buffer);
      return buffer;
    },
  };
}

function expectUsedRangeZeroed(buffer: Buffer | undefined, used: number): void {
  expect(buffer).toBeDefined();
  expect(buffer?.subarray(0, used).every((byte) => byte === 0)).toBe(true);
}

const handles: StdioServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("stdio adapter", () => {
  it("validates a registry before allocating any stream listeners", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const invalidRegistry = {
      jetkvm_session_connect: vi.fn(),
    } as unknown as HandlerRegistry;
    const listenerCounts = () => ({
      stdinData: stdin.listenerCount("data"),
      stdinError: stdin.listenerCount("error"),
      stdinEnd: stdin.listenerCount("end"),
      stdinClose: stdin.listenerCount("close"),
      stdoutError: stdout.listenerCount("error"),
      stdoutDrain: stdout.listenerCount("drain"),
      stderrError: stderr.listenerCount("error"),
      stderrDrain: stderr.listenerCount("drain"),
    });
    const before = listenerCounts();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      await expect(
        startStdioServer(invalidRegistry, { stdin, stdout, stderr }),
      ).rejects.toThrow(/empty or contain all ten canonical tools/i);
    }

    expect(listenerCounts()).toEqual(before);
  });

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

  it("fails closed on an active duplicate ID, aborts the original, and permits sequential reuse", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collector = new JsonLineCollector(stdout);
    const errors: Error[] = [];
    const firstEntered = Promise.withResolvers<void>();
    const firstAborted = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const handler = vi.fn(
      async (_input: unknown, extra: { signal: AbortSignal }) => {
        signals.push(extra.signal);
        if (signals.length === 1) {
          firstEntered.resolve();
          if (!extra.signal.aborted) {
            const aborted = Promise.withResolvers<void>();
            extra.signal.addEventListener("abort", () => aborted.resolve(), {
              once: true,
            });
            await aborted.promise;
          }
          firstAborted.resolve();
        }
        return businessError("jetkvm_session_connect", "CANCELLED");
      },
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

    send(stdin, initialize(1));
    await collector.waitForCount(1);
    send(stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(stdin, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "jetkvm_session_connect",
        arguments: {
          request_id: "request-duplicate-original",
          timeout_ms: 60_000,
        },
      },
    });
    await firstEntered.promise;
    send(stdin, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "jetkvm_session_connect",
        arguments: {
          request_id: "request-duplicate-rejected",
          timeout_ms: 60_000,
        },
      },
    });
    await firstAborted.promise;
    await collector.waitForCount(3);

    expect(handler).toHaveBeenCalledOnce();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(collector.messages.slice(1, 3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 9,
          error: expect.objectContaining({ message: "Server busy" }),
        }),
        expect.objectContaining({
          id: 9,
          error: expect.objectContaining({ message: "Request cancelled" }),
        }),
      ]),
    );

    send(stdin, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "jetkvm_session_connect",
        arguments: { request_id: "request-reused", timeout_ms: 100 },
      },
    });
    await collector.waitForCount(4);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
    await handle.close();
    await waitForImmediateSettlement();
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stdout.destroyed).toBe(false);
  });
  it("zeroes fragmented paste bytes after copying a valid frame for dispatch", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collector = new JsonLineCollector(stdout);
    const capture = capturePendingBuffers();
    const entered = Promise.withResolvers<void>();
    const handler = vi.fn(async (_input: unknown) => {
      entered.resolve();
      return businessError("jetkvm_input_paste");
    });
    const handle = await startStdioServer(
      completeRegistry({ jetkvm_input_paste: handler }),
      {
        stdin,
        stdout,
        allocatePendingBuffer: capture.allocatePendingBuffer,
      },
    );
    handles.push(handle);
    send(stdin, initialize(1));
    await collector.waitForCount(1);
    send(stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    const secret = Buffer.from("private-fragmented-paste-secret", "utf8");
    const frame = pasteCallFrame(3, secret);
    const suffixBytes = Buffer.byteLength('","timeout_ms":100}}}\n');
    const split = frame.byteLength - suffixBytes;

    stdin.write(frame.subarray(0, split));
    stdin.write(frame.subarray(split));
    await entered.promise;

    expect(capture.buffers).toHaveLength(1);
    expectUsedRangeZeroed(capture.buffers[0], split);
    expect(capture.buffers[0]?.includes(secret)).toBe(false);
  });

  it.each(["invalid", "overflow", "close"] as const)(
    "zeroes fragmented pending bytes on the %s path",
    async (path) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const capture = capturePendingBuffers();
      const observed = Promise.withResolvers<void>();
      const handle = await startStdioServer(completeRegistry(), {
        stdin,
        stdout,
        allocatePendingBuffer: capture.allocatePendingBuffer,
        onError: () => observed.resolve(),
      });
      handles.push(handle);
      const secret = Buffer.from(`private-${path}-secret`, "utf8");
      const fragment =
        path === "invalid"
          ? Buffer.concat([secret, Buffer.from([0xc3])])
          : secret;

      stdin.write(fragment);
      if (path === "invalid") {
        stdin.write("\n");
        await observed.promise;
      } else if (path === "overflow") {
        stdin.write(Buffer.alloc(2_097_154, 0x61));
        await handle.closed;
      } else {
        await handle.close();
      }

      expect(capture.buffers).toHaveLength(1);
      expectUsedRangeZeroed(capture.buffers[0], fragment.byteLength);
      expect(capture.buffers[0]?.includes(secret)).toBe(false);
    },
  );

  it("does not allocate or mutate pending storage for a complete direct frame", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collector = new JsonLineCollector(stdout);
    const capture = capturePendingBuffers();
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
      allocatePendingBuffer: capture.allocatePendingBuffer,
    });
    handles.push(handle);

    const directFrame = Buffer.from(`${JSON.stringify(initialize(1))}\n`);
    const callerOwnedCopy = Buffer.from(directFrame);
    stdin.write(directFrame);
    await collector.waitForCount(1);

    expect(capture.buffers).toEqual([]);
    expect(directFrame).toEqual(callerOwnedCopy);
  });

  it.each(["single-chunk", "fragmented"] as const)(
    "fatally rejects invalid UTF-8 inside JSON without dispatch (%s)",
    async (mode) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const collector = new JsonLineCollector(stdout);
      const malformed = Promise.withResolvers<void>();
      const errors: Error[] = [];
      const handler = vi.fn(async () => businessError("jetkvm_input_paste"));
      const handle = await startStdioServer(
        completeRegistry({ jetkvm_input_paste: handler }),
        {
          stdin,
          stdout,
          onError: (error) => {
            errors.push(error);
            malformed.resolve();
          },
        },
      );
      handles.push(handle);
      send(stdin, initialize(1));
      await collector.waitForCount(1);
      send(stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
      const frame = pasteCallFrame(3, Buffer.from([0x63, 0xc3, 0x28, 0x64]));
      const invalidLeadIndex =
        frame.indexOf(Buffer.from([0x63, 0xc3, 0x28])) + 1;

      if (mode === "single-chunk") {
        stdin.write(frame);
      } else {
        stdin.write(frame.subarray(0, invalidLeadIndex + 1));
        stdin.write(frame.subarray(invalidLeadIndex + 1));
      }
      await malformed.promise;

      expect(errors.map((error) => error.message)).toEqual([
        "Invalid UTF-8 stdio protocol frame",
      ]);
      expect(handler).not.toHaveBeenCalled();
      expect(collector.messages).toHaveLength(1);
      expect(handle.isClosed()).toBe(false);
    },
  );

  it("counts invalid UTF-8 frames toward the bounded malformed shutdown threshold", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collector = new JsonLineCollector(stdout);
    const errors: Error[] = [];
    const handler = vi.fn(async () => businessError("jetkvm_input_paste"));
    const handle = await startStdioServer(
      completeRegistry({ jetkvm_input_paste: handler }),
      {
        stdin,
        stdout,
        onError: (error) => errors.push(error),
      },
    );
    handles.push(handle);
    send(stdin, initialize(1));
    await collector.waitForCount(1);
    send(stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    const invalidFrame = pasteCallFrame(3, Buffer.from([0xc3, 0x28]));

    stdin.write(Buffer.concat(Array<Buffer>(32).fill(invalidFrame)));
    await handle.closed;

    expect(errors).toHaveLength(32);
    expect(
      errors.every(
        (error) => error.message === "Invalid UTF-8 stdio protocol frame",
      ),
    ).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(stdin.readableFlowing).toBe(false);
  });

  it("accepts a valid UTF-8 multibyte sequence split across input chunks", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collector = new JsonLineCollector(stdout);
    const entered = Promise.withResolvers<void>();
    const errors: Error[] = [];
    const handler = vi.fn(async (_input: unknown) => {
      entered.resolve();
      return businessError("jetkvm_input_paste");
    });
    const handle = await startStdioServer(
      completeRegistry({ jetkvm_input_paste: handler }),
      {
        stdin,
        stdout,
        onError: (error) => errors.push(error),
      },
    );
    handles.push(handle);
    send(stdin, initialize(1));
    await collector.waitForCount(1);
    send(stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    const frame = pasteCallFrame(3, Buffer.from("valid-€", "utf8"));
    const euroIndex = frame.indexOf(Buffer.from("€", "utf8"));

    stdin.write(frame.subarray(0, euroIndex + 1));
    stdin.write(frame.subarray(euroIndex + 1));
    await entered.promise;

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ text: "valid-€" });
    expect(errors).toEqual([]);
  });

  it("redacts raw SDK parse errors and continues with the next valid frame", async () => {
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
    const attackerSentinel = "PRIVATE_ATTACKER_SENTINEL";

    stdin.write(`{"jsonrpc":"2.0","id":1,"method":${attackerSentinel}}\n`);
    send(stdin, initialize(2));
    await collector.waitForCount(1);

    expect(errors.map((error) => error.message)).toEqual([
      "Malformed stdio protocol frame",
    ]);
    expect(errors[0]?.stack).not.toContain(attackerSentinel);
    expect(collector.messages).toHaveLength(1);
    expect(collector.messages[0]).toMatchObject({
      id: 2,
      result: expect.any(Object),
    });
    expect(collector.rawChunks.join("")).not.toContain(attackerSentinel);
  });

  it("accepts a canonical maximum-byte paste with worst-case JSON escaping", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collector = new JsonLineCollector(stdout);
    const accepted = Promise.withResolvers<void>();
    const handler = vi.fn(async () => {
      accepted.resolve();
      return businessError("jetkvm_input_paste");
    });
    const handle = await startStdioServer(
      completeRegistry({ jetkvm_input_paste: handler }),
      { stdin, stdout },
    );
    handles.push(handle);
    send(stdin, initialize(1));
    await collector.waitForCount(1);
    send(stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "jetkvm_input_paste",
        arguments: {
          session_id: "session-1",
          session_generation: 1,
          observation_id: "observation-1",
          request_id: "request-max-escaped-paste",
          text: "\u0000".repeat(262_144),
          timeout_ms: 300_000,
        },
      },
    });
    expect(Buffer.byteLength(frame)).toBeGreaterThan(1_048_576);
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(2_097_152);

    stdin.write(`${frame}\n`);
    const outcome = await Promise.race([
      accepted.promise.then(() => "accepted" as const),
      handle.closed.then(() => "closed" as const),
    ]);

    expect(outcome).toBe("accepted");
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(["unterminated", "newline-terminated"] as const)(
    "closes without dispatch when a %s frame exceeds 2 MiB",
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

      const oversized = Buffer.alloc(2_097_153, 0x20);
      stdin.write(
        kind === "newline-terminated"
          ? Buffer.concat([oversized, Buffer.from("\n")])
          : oversized,
      );
      await handle.closed;

      expect(errors.map((error) => error.message)).toEqual([
        "Inbound stdio frame exceeds 2097152 bytes",
      ]);
      expect(handler).not.toHaveBeenCalled();
      expect(stdout.readableLength).toBe(0);
      expect(stdin.readableFlowing).toBe(false);
    },
  );

  it("accepts an exactly 2 MiB JSON frame with a fragmented CRLF delimiter", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collector = new JsonLineCollector(stdout);
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
    });
    handles.push(handle);
    const json = JSON.stringify(initialize(1));
    const padding = " ".repeat(2_097_152 - Buffer.byteLength(json));

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
    expect(stdin.readableFlowing).toBe(false);
  });

  it("pauses stdin after a redacted input-stream error", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const errors: Error[] = [];
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
      onError: (error) => errors.push(error),
    });
    handles.push(handle);

    stdin.emit("error", new Error("private input path"));
    await handle.closed;

    expect(errors.map((error) => error.message)).toEqual([
      "Stdio input stream failed",
    ]);
    expect(stdin.readableFlowing).toBe(false);
  });

  it("accepts a schema-valid maximum 8 MiB PNG through tools/call and result mapping", async () => {
    const stdin = new PassThrough();
    const stdout = new ControlledWritable();
    const errors: Error[] = [];
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    const data = bytes.toString("base64");
    const envelope = {
      ok: true as const,
      tool: "jetkvm_display_capture" as const,
      operation_id: "operation-max-png",
      session_id: "session-max-png",
      session_generation: 1,
      duration_ms: 1,
      result: {
        observation_id: "observation-max-png",
        connection_epoch: 1,
        display_generation: 1,
        frame_id: "frame-max-png",
        captured_at: "2026-07-13T00:00:00.000Z",
        source_width: 1920,
        source_height: 1080,
        image_width: 1920,
        image_height: 1080,
        rotation: 0 as const,
        geometry: {
          content_x: 0,
          content_y: 0,
          content_width: 1920,
          content_height: 1080,
        },
        image: {
          content_index: 1,
          mime_type: "image/png" as const,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byte_length: bytes.byteLength,
        },
      },
    };
    const handler = vi.fn(async () => ({
      structuredContent: envelope,
      content: [
        { type: "text" as const, text: JSON.stringify(envelope) },
        { type: "image" as const, data, mimeType: "image/png" },
      ],
    }));
    const handle = await startStdioServer(
      completeRegistry({ jetkvm_display_capture: handler }),
      {
        stdin,
        stdout,
        onError: (error) => errors.push(error),
      },
    );
    handles.push(handle);

    send(stdin, initialize(1));
    await stdout.waitForCount(1);
    stdout.releaseNext();
    send(stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(stdin, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "jetkvm_display_capture",
        arguments: {
          session_id: "session-max-png",
          session_generation: 1,
          format: "png",
          max_width: 1920,
          max_height: 1080,
          timeout_ms: 100,
        },
      },
    });
    await stdout.waitForCount(2);

    const responseBytes = stdout.chunks[1]?.byteLength ?? 0;
    expect(handler).toHaveBeenCalledOnce();
    expect(responseBytes).toBeGreaterThan(data.length);
    expect(responseBytes).toBeLessThan(16 * 1024 * 1024);
    expect(stdout.chunks[1]?.subarray(-80).toString("utf8")).toContain(
      '"id":2',
    );
    expect(errors).toEqual([]);
    stdout.releaseNext();
  });

  it("accepts an exact-cap write without leaving the SDK waiting for drain", async () => {
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
      const emptyMessage = {
        jsonrpc: "2.0" as const,
        id: 1,
        result: { payload: "" },
      };
      const fixedBytes = Buffer.byteLength(`${JSON.stringify(emptyMessage)}\n`);
      const exactMessage = {
        ...emptyMessage,
        result: {
          payload: "x".repeat(16 * 1024 * 1024 - fixedBytes),
        },
      };
      const sendSettled = vi.fn();

      void handle.transport.send(exactMessage).then(sendSettled);
      await stdout.waitForCount(1);
      await Promise.resolve();

      expect(stdout.chunks[0]?.byteLength).toBe(16 * 1024 * 1024);
      expect(sendSettled).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_000);
      await handle.closed;
      vi.useRealTimers();
      expect(errors.map((error) => error.message)).toEqual([
        "Outbound stdio write timed out after 10000 ms",
      ]);
      expect(stdout.listenerCount("error")).toBe(1);
      stdout.failNext();
      await waitForImmediateSettlement();
      expect(stdout.listenerCount("error")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
    expect(stdout.destroyed).toBe(false);
    expect(stdout.unrefCalls).toBe(0);
    expect(stdin.destroyed).toBe(false);
    expect(stdout.listenerCount("error")).toBe(1);
    stdout.failNext();
    await waitForImmediateSettlement();

    expect(handler).not.toHaveBeenCalled();
    expect(errors.map((error) => error.message)).toEqual([
      "Outbound stdio queue exceeds 16777216 bytes",
    ]);
    expect(stdout.chunks).toHaveLength(1);
    expect(stdout.chunks[0]?.byteLength).toBeLessThan(10 * 1024 * 1024);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stdin.readableFlowing).toBe(false);
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
      expect(stdout.destroyed).toBe(false);
      expect(stdout.unrefCalls).toBe(0);
      expect(stdin.destroyed).toBe(false);
      vi.useRealTimers();
      expect(stdout.listenerCount("error")).toBe(1);
      stdout.failNext();
      await waitForImmediateSettlement();

      expect(errors.map((error) => error.message)).toEqual([
        "Outbound stdio write timed out after 10000 ms",
      ]);
      expect(stdout.listenerCount("error")).toBe(0);
      expect(stdin.readableFlowing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves injected fatal streams caller-owned until their late callback settles", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new PassThrough();
      const stdout = new DestroyReleasesWritable();
      const errors: Error[] = [];
      const exitProcess = vi.fn();
      const handle = await startStdioServer(completeRegistry(), {
        stdin,
        stdout,
        onError: (error) => errors.push(error),
        exitProcess,
      });
      handles.push(handle);

      send(stdin, initialize(1));
      await stdout.writeStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await handle.closed;
      vi.useRealTimers();
      await waitForImmediateSettlement();

      expect(errors.map((error) => error.message)).toEqual([
        "Outbound stdio write timed out after 10000 ms",
      ]);
      expect(stdout.destroyCalls).toBe(0);
      expect(stdout.unrefCalls).toBe(0);
      expect(stdout.destroyed).toBe(false);
      expect(stdin.destroyed).toBe(false);
      expect(stdout.listenerCount("error")).toBe(1);
      stdout.releaseActive();
      await waitForImmediateSettlement();
      expect(stdout.listenerCount("error")).toBe(0);
      expect(stdin.readableFlowing).toBe(false);
      expect(exitProcess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("boundedly flushes a fixed diagnostic before fatal default-stdio exit", async () => {
    vi.useFakeTimers();
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
    const stderrDescriptor = Object.getOwnPropertyDescriptor(process, "stderr");
    if (
      stdinDescriptor === undefined ||
      stdoutDescriptor === undefined ||
      stderrDescriptor === undefined
    ) {
      throw new Error("Process stdio descriptors are unavailable");
    }
    const stdin = new PassThrough();
    const stdout = new DestroyReleasesWritable();
    const stderr = new ControlledWritable();
    const exitProcess = vi.fn();
    try {
      Object.defineProperties(process, {
        stdin: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stdin,
        },
        stdout: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stdout,
        },
        stderr: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stderr,
        },
      });
      const handle = await startStdioServer(completeRegistry(), {
        exitProcess,
      });
      handles.push(handle);

      send(stdin, initialize(1));
      await stdout.writeStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await handle.closed;
      await stderr.waitForCount(1);

      expect(stderr.chunks[0]?.toString()).toBe(
        "jetkvm-mcp: stdio output write timeout\n",
      );
      expect(exitProcess).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      expect(exitProcess).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exitProcess).toHaveBeenCalledOnce();
      expect(exitProcess).toHaveBeenCalledWith(1);
      expect(stdin.destroyed).toBe(true);
      expect(stdout.destroyed).toBe(true);
      stderr.releaseNext();
      vi.useRealTimers();
      await waitForImmediateSettlement();
      expect(stderr.listenerCount("error")).toBe(0);
    } finally {
      Object.defineProperties(process, {
        stdin: stdinDescriptor,
        stdout: stdoutDescriptor,
        stderr: stderrDescriptor,
      });
      vi.useRealTimers();
    }
  });

  it("waits for every accepted high-water diagnostic before fatal exit", async () => {
    vi.useFakeTimers();
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
    const stderrDescriptor = Object.getOwnPropertyDescriptor(process, "stderr");
    if (
      stdinDescriptor === undefined ||
      stdoutDescriptor === undefined ||
      stderrDescriptor === undefined
    ) {
      throw new Error("Process stdio descriptors are unavailable");
    }
    const stdin = new PassThrough();
    const stdout = new DestroyReleasesWritable();
    const stderr = new ControlledWritable(1024 * 1024);
    const exitProcess = vi.fn();
    try {
      Object.defineProperties(process, {
        stdin: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stdin,
        },
        stdout: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stdout,
        },
        stderr: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stderr,
        },
      });
      const handle = await startStdioServer(completeRegistry(), {
        exitProcess,
      });
      handles.push(handle);

      stdin.write('{"jsonrpc":"2.0",first_broken}\n');
      stdin.write('{"jsonrpc":"2.0",second_broken}\n');
      stdin.write('{"jsonrpc":"2.0",third_broken}\n');
      await stderr.waitForCount(1);
      send(stdin, initialize(1));
      await stdout.writeStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await handle.closed;

      for (let completed = 1; completed < 4; completed += 1) {
        stderr.releaseNext();
        await stderr.waitForCount(completed + 1);
        await vi.advanceTimersByTimeAsync(0);
        expect(exitProcess).not.toHaveBeenCalled();
      }
      stderr.releaseNext();
      await vi.advanceTimersByTimeAsync(0);

      expect(stderr.chunks.map((chunk) => chunk.toString())).toEqual([
        "jetkvm-mcp: malformed stdio protocol frame\n",
        "jetkvm-mcp: malformed stdio protocol frame\n",
        "jetkvm-mcp: malformed stdio protocol frame\n",
        "jetkvm-mcp: stdio output write timeout\n",
      ]);
      expect(exitProcess).toHaveBeenCalledOnce();
      expect(exitProcess).toHaveBeenCalledWith(1);
      expect(stderr.listenerCount("error")).toBe(0);
    } finally {
      Object.defineProperties(process, {
        stdin: stdinDescriptor,
        stdout: stdoutDescriptor,
        stderr: stderrDescriptor,
      });
      vi.useRealTimers();
    }
  });

  it("does not destroy a shared stdin consumer on fatal stdout timeout", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new PassThrough();
      const stdout = new DestroyReleasesWritable();
      const sharedConsumer = vi.fn();
      stdin.on("data", sharedConsumer);
      const handle = await startStdioServer(completeRegistry(), {
        stdin,
        stdout,
        onError: vi.fn(),
      });
      handles.push(handle);

      send(stdin, initialize(1));
      await stdout.writeStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await handle.closed;
      vi.useRealTimers();
      await waitForImmediateSettlement();

      expect(stdin.destroyed).toBe(false);
      expect(stdin.listenerCount("data")).toBe(1);
      expect(stdin.readableFlowing).toBe(true);
      expect(stdout.destroyed).toBe(false);
      expect(stdout.unrefCalls).toBe(0);
      stdout.releaseActive();
      await waitForImmediateSettlement();
      expect(stdout.listenerCount("error")).toBe(0);
      stdin.off("data", sharedConsumer);
      stdin.pause();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps stdout guarded when normal close precedes a late EPIPE callback", async () => {
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

    await handle.close();
    expect(stdout.destroyed).toBe(false);
    expect(stdin.destroyed).toBe(false);
    expect(stdout.listenerCount("error")).toBe(1);
    stdout.failNext();
    await waitForImmediateSettlement();

    expect(errors).toEqual([]);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stdin.readableFlowing).toBe(false);
  });

  it("keeps EPIPE guarded through callback-then-error settlement", async () => {
    const stdin = new PassThrough();
    const stdout = new CallbackEpipeWritable();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const handle = await startStdioServer(completeRegistry(), {
        stdin,
        stdout,
      });
      handles.push(handle);

      send(stdin, initialize(1));
      await handle.closed;
      await waitForImmediateSettlement();

      expect(stderrWrite).toHaveBeenCalledOnce();
      expect(stderrWrite).toHaveBeenCalledWith(
        "jetkvm-mcp: stdio output failure\n",
        expect.any(Function),
      );
      expect(stdout.listenerCount("error")).toBe(0);
      expect(stdin.readableFlowing).toBe(false);
    } finally {
      stderrWrite.mockRestore();
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
        expect.any(Function),
      );
      expect(stdout.listenerCount("error")).toBe(0);
      expect(stdin.readableFlowing).toBe(false);
      await handle.close();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("settles a synchronous stdout write throw without retaining listeners", async () => {
    const stdin = new PassThrough();
    const stdout = new ThrowingWritable();
    const errors: Error[] = [];
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
      onError: (error) => errors.push(error),
    });
    handles.push(handle);

    send(stdin, initialize(1));
    await handle.closed;

    expect(errors.map((error) => error.message)).toEqual([
      "Outbound stdio stream failed",
    ]);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stdin.readableFlowing).toBe(false);
  });

  it("does not pause a shared stdin source while another data consumer remains", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const sharedConsumer = vi.fn();
    stdin.on("data", sharedConsumer);
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
    });
    handles.push(handle);

    await handle.close();

    expect(stdin.listenerCount("data")).toBe(1);
    expect(stdin.readableFlowing).toBe(true);
    stdin.off("data", sharedConsumer);
    stdin.pause();
  });

  it("bounds stalled diagnostic output and closes after the malformed-frame threshold", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new ControlledWritable();
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
      stderr,
    });
    handles.push(handle);

    const attackerSentinel = "PRIVATE_STDERR_SENTINEL";
    stdin.write(
      `{"jsonrpc":"2.0","method":${attackerSentinel}}\n`.repeat(1_000),
    );
    await handle.closed;

    expect(stderr.chunks).toHaveLength(1);
    expect(stderr.chunks[0]?.toString()).toBe(
      "jetkvm-mcp: malformed stdio protocol frame\n",
    );
    expect(stderr.chunks[0]?.toString()).not.toContain(attackerSentinel);
    expect(stderr.listenerCount("drain")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(1);
    expect(stdin.readableFlowing).toBe(false);
    stderr.releaseNext();
    await waitForImmediateSettlement();
    expect(stderr.listenerCount("error")).toBe(0);
  });

  it("resumes one fixed diagnostic after stderr drains without duplicate listeners", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new ControlledWritable();
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
      stderr,
    });
    handles.push(handle);

    stdin.write('{"jsonrpc":"2.0",broken}\n');
    await stderr.waitForCount(1);
    stdin.write('{"jsonrpc":"2.0",still_broken}\n');
    expect(stderr.chunks).toHaveLength(1);
    expect(stderr.listenerCount("drain")).toBe(1);
    stderr.releaseNext();
    await waitForImmediateSettlement();
    stdin.write('{"jsonrpc":"2.0",broken_again}\n');
    await stderr.waitForCount(2);

    expect(stderr.chunks).toHaveLength(2);
    expect(stderr.listenerCount("drain")).toBe(1);
    await handle.close();
    expect(stderr.listenerCount("drain")).toBe(0);
    stderr.releaseNext();
    await waitForImmediateSettlement();
    expect(stderr.listenerCount("error")).toBe(0);
  });

  it("settles diagnostic callback-error ordering without an uncaught event", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new CallbackEpipeWritable();
    const handle = await startStdioServer(completeRegistry(), {
      stdin,
      stdout,
      stderr,
    });
    handles.push(handle);

    stdin.write('{"jsonrpc":"2.0",broken}\n');
    await waitForImmediateSettlement();

    expect(stderr.listenerCount("error")).toBe(0);
    await handle.close();
    expect(stdin.readableFlowing).toBe(false);
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
    expect(stdin.readableFlowing).toBe(false);
  });
});
