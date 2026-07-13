import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { prepareInstalledPackage } from "./installed-smoke-support.mjs";

class JsonLineCollector {
  messages = [];
  raw = "";
  #buffer = "";
  #waiters = [];

  push(chunk) {
    this.raw += chunk;
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.messages.push(JSON.parse(line));
    }
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      if (this.messages.length >= waiter.count) waiter.resolve();
      else this.#waiters.push(waiter);
    }
  }

  async waitFor(count) {
    if (this.messages.length >= count) return;
    const pending = Promise.withResolvers();
    this.#waiters.push({ count, resolve: pending.resolve });
    await pending.promise;
  }
}

const installed = await prepareInstalledPackage("stdio");
try {
  const runner = join(installed.consumer, "stdio-runner.mjs");
  await writeFile(
    runner,
    `import { startStdioServer } from "@wyrmkeep/jetkvm-mcp/dist/mcp/stdio.js";
import { handlers as baseHandlers } from "./deterministic-handlers.mjs";

const handlers = {
  ...baseHandlers,
  jetkvm_session_connect: async (input, extra) => {
    if (input.request_id !== "cancel") return baseHandlers.jetkvm_session_connect(input, extra);
    if (!extra.signal.aborted) {
      const aborted = Promise.withResolvers();
      extra.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
    }
    return baseHandlers.jetkvm_session_connect(input, extra);
  },
};

const handle = await startStdioServer(handlers);
await handle.closed;
`,
  );

  const child = spawn(process.execPath, [runner], {
    cwd: installed.consumer,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const collector = new JsonLineCollector();
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => collector.push(chunk));
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = Promise.withResolvers();
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  child.once("error", exited.reject);

  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "installed-stdio-smoke", version: "1.0.0" },
    },
  });
  child.stdin.write(initialize.slice(0, 17));
  child.stdin.write(`${initialize.slice(17)}\n`);
  await collector.waitFor(1);

  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
  );
  await collector.waitFor(2);
  assert.deepEqual(
    collector.messages[1].result.tools.map((tool) => tool.name),
    [
      "jetkvm_display_capture",
      "jetkvm_display_status",
      "jetkvm_input_keyboard",
      "jetkvm_input_mouse",
      "jetkvm_input_paste",
      "jetkvm_input_release",
      "jetkvm_power_control",
      "jetkvm_session_connect",
      "jetkvm_session_reconnect",
      "jetkvm_session_status",
    ],
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "jetkvm_session_connect",
        arguments: { request_id: "success", timeout_ms: 100 },
      },
    })}\n`,
  );
  await collector.waitFor(3);
  assert.equal(collector.messages[2].result.structuredContent.ok, true);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "jetkvm_session_connect",
        arguments: { request_id: "cancel", timeout_ms: 60_000 },
      },
    })}\n` +
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 4, reason: "installed cancellation" },
      })}\n` +
      '{"jsonrpc":"2.0",broken}\n' +
      `${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} })}\n`,
  );
  await collector.waitFor(4);
  assert.equal(collector.messages[3].id, 5);
  assert.equal(
    collector.messages.some((message) => message.id === 4),
    false,
  );

  child.stdin.end();
  const exit = await exited.promise;
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(stderr, "jetkvm-mcp: malformed stdio protocol frame\n");
  assert.equal(
    collector.raw
      .split("\n")
      .filter(Boolean)
      .every((line) => {
        JSON.parse(line);
        return true;
      }),
    true,
  );
  console.log("installed stdio protocol smoke ok");
} finally {
  await installed.cleanup();
}
