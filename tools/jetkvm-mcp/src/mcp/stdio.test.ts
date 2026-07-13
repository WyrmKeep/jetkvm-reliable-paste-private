import { PassThrough } from "node:stream";

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

    const initializeLine = `${JSON.stringify(initialize(1))}\n`;
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
