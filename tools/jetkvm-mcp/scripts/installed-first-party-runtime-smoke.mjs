import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { withInstalledPackage } from "./installed-smoke-support.mjs";

const EXPECTED_TOOLS = [
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
];

function waitWithDeadline(promise, label, timeoutMs = 30_000) {
  const deadline = Promise.withResolvers();
  const timer = setTimeout(
    () => deadline.reject(new Error(`${label} deadline exceeded`)),
    timeoutMs,
  );
  return Promise.race([promise, deadline.promise]).finally(() =>
    clearTimeout(timer),
  );
}

await withInstalledPackage("first-party-runtime", async ({ consumer }) => {
  const executable = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "jetkvm-mcp.cmd" : "jetkvm-mcp",
  );
  const child = spawn(
    executable,
    ["--target-url", "https://installed-runtime.invalid"],
    {
      cwd: consumer,
      env: {
        ...process.env,
        JETKVM_CREDENTIAL: "installed-smoke-password",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const responses = new Map();
  const waiters = new Map();
  const childClosed = Promise.withResolvers();
  let stdoutBuffer = "";
  let stderr = "";
  let childError;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      responses.set(message.id, message);
      waiters.get(message.id)?.resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    childError = error;
    childClosed.reject(error);
  });
  child.once("close", (code, signal) => {
    childClosed.resolve({ code, signal });
  });
  const waitForResponse = (id) => {
    const existing = responses.get(id);
    if (existing !== undefined) return Promise.resolve(existing);
    let waiter = waiters.get(id);
    if (waiter === undefined) {
      waiter = Promise.withResolvers();
      waiters.set(id, waiter);
    }
    return waitWithDeadline(waiter.promise, `response ${id}`);
  };

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "first-party-smoke", version: "1.0.0" },
        },
      })}\n`,
    );
    const initialized = await waitForResponse(1);
    assert.equal(initialized.result.serverInfo.name, "jetkvm-mcp");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );
    const listed = await waitForResponse(2);
    assert.deepEqual(
      listed.result.tools.map(({ name }) => name),
      EXPECTED_TOOLS,
    );
    child.stdin.end();
    const closed = await waitWithDeadline(childClosed.promise, "child exit");
    assert.deepEqual(closed, { code: 0, signal: null });
    assert.equal(stdoutBuffer, "");
    assert.equal(stderr, "");
    assert.equal(childError, undefined);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await childClosed.promise.catch(() => undefined);
    }
  }
});

console.log("Installed first-party runtime verified (leased stdio, ten real tools).\n");
