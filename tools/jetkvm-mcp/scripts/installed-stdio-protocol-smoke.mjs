import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  prepareInstalledPackage,
  withInstalledPackage,
} from "./installed-smoke-support.mjs";

class InstalledStdioProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InstalledStdioProtocolError";
    this.code = code;
  }
}

const DEFAULT_COLLECTOR_LIMITS = Object.freeze({
  frameBytes: 16 * 1024 * 1024,
  cumulativeBytes: 32 * 1024 * 1024,
  messageCount: 256,
});
const INSTALLED_STDIO_STDERR_BYTES = 64 * 1024;
const INSTALLED_STDIO_LARGE_ID_SUFFIX_BYTES = 1_900_000;

export class JsonLineCollector {
  messages = [];
  #buffer = "";
  #cumulativeBytes = 0;
  #waiters = [];
  #termination;
  #deadlineMs;
  #limits;
  #failure = Promise.withResolvers();
  #failed = false;
  #failureError;

  constructor({ termination, deadlineMs, limits = DEFAULT_COLLECTOR_LIMITS }) {
    this.#termination = termination;
    this.#deadlineMs = deadlineMs;
    this.#limits = limits;
  }

  get failure() {
    return this.#failure.promise;
  }

  push(chunk) {
    if (this.#failed) return;
    try {
      this.#pushBounded(chunk);
    } catch {
      this.fail(
        new InstalledStdioProtocolError(
          "INSTALLED_STDIO_PROTOCOL_FAILURE",
          "Installed stdio protocol output could not be processed",
        ),
      );
    }
  }

  end() {
    if (this.#failed || this.#buffer.length === 0) return;
    this.fail(
      new InstalledStdioProtocolError(
        "INSTALLED_STDIO_INCOMPLETE_FRAME",
        "Installed stdio child output ended with an incomplete frame",
      ),
    );
  }

  fail(error) {
    if (this.#failed) return;
    this.#failed = true;
    this.#failureError = error;
    this.#buffer = "";
    this.messages = [];
    this.#failure.resolve(error);
  }

  async waitFor(count) {
    if (this.#failureError !== undefined) throw this.#failureError;
    if (this.messages.length >= count) return;
    const pending = Promise.withResolvers();
    const waiter = { count, resolve: pending.resolve };
    this.#waiters.push(waiter);
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new InstalledStdioProtocolError(
              "INSTALLED_STDIO_RESPONSE_TIMEOUT",
              "Installed stdio protocol response deadline exceeded",
            ),
          ),
        this.#deadlineMs,
      );
    });
    const terminated = this.#termination.then(() => {
      throw new InstalledStdioProtocolError(
        "INSTALLED_STDIO_EARLY_TERMINATION",
        "Installed stdio child terminated before the expected protocol response",
      );
    });
    const failed = this.#failure.promise.then((error) => {
      throw error;
    });
    try {
      await Promise.race([pending.promise, terminated, failed, deadline]);
    } finally {
      clearTimeout(timer);
      const index = this.#waiters.indexOf(waiter);
      if (index >= 0) this.#waiters.splice(index, 1);
    }
  }

  #pushBounded(chunk) {
    const nextCumulative =
      this.#cumulativeBytes + Buffer.byteLength(chunk, "utf8");
    if (nextCumulative > this.#limits.cumulativeBytes) {
      this.fail(
        new InstalledStdioProtocolError(
          "INSTALLED_STDIO_CUMULATIVE_LIMIT",
          "Installed stdio protocol output exceeds the cumulative byte limit",
        ),
      );
      return;
    }
    this.#cumulativeBytes = nextCumulative;
    this.#buffer += chunk;

    while (!this.#failed) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.#limits.frameBytes) {
        this.fail(
          new InstalledStdioProtocolError(
            "INSTALLED_STDIO_FRAME_TOO_LARGE",
            "Installed stdio protocol frame exceeds the byte limit",
          ),
        );
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(
          new InstalledStdioProtocolError(
            "INSTALLED_STDIO_MALFORMED_JSON",
            "Installed stdio child emitted malformed JSON",
          ),
        );
        return;
      }
      if (this.messages.length >= this.#limits.messageCount) {
        this.fail(
          new InstalledStdioProtocolError(
            "INSTALLED_STDIO_MESSAGE_LIMIT",
            "Installed stdio protocol message limit exceeded",
          ),
        );
        return;
      }
      this.messages.push(message);
    }

    if (
      !this.#failed &&
      Buffer.byteLength(this.#buffer, "utf8") > this.#limits.frameBytes
    ) {
      this.fail(
        new InstalledStdioProtocolError(
          "INSTALLED_STDIO_FRAME_TOO_LARGE",
          "Installed stdio protocol frame exceeds the byte limit",
        ),
      );
      return;
    }

    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      if (this.messages.length >= waiter.count) waiter.resolve();
      else this.#waiters.push(waiter);
    }
  }
}

const INSTALLED_STDIO_RESPONSE_DEADLINE_MS = 30_000;

async function waitForChildExit(exitOutcome, protocolFailure, deadlineMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new InstalledStdioProtocolError(
            "INSTALLED_STDIO_EXIT_TIMEOUT",
            "Installed stdio child exit deadline exceeded",
          ),
        ),
      deadlineMs,
    );
  });
  const failed = protocolFailure.then((error) => {
    throw error;
  });
  try {
    const outcome = await Promise.race([exitOutcome, failed, deadline]);
    if (outcome.error !== undefined) throw outcome.error;
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForNoReaderInitialization(
  initialized,
  exitOutcome,
  protocolFailure,
  deadlineMs,
) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new InstalledStdioProtocolError(
            "INSTALLED_STDIO_RESPONSE_TIMEOUT",
            "Installed stdio initialization response deadline exceeded",
          ),
        ),
      deadlineMs,
    );
  });
  const failed = protocolFailure.then((error) => {
    throw error;
  });
  const exited = exitOutcome.then(() => {
    throw new InstalledStdioProtocolError(
      "INSTALLED_STDIO_EARLY_TERMINATION",
      "Installed stdio child terminated before initialization completed",
    );
  });
  try {
    return await Promise.race([initialized, failed, exited, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForChildClose(closeOutcome, deadlineMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new InstalledStdioProtocolError(
            "INSTALLED_STDIO_CHILD_CLEANUP_TIMEOUT",
            "Installed stdio child cleanup deadline exceeded",
          ),
        ),
      deadlineMs,
    );
  });
  try {
    await Promise.race([closeOutcome, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeChildAfterOperation(
  child,
  childExited,
  closeOutcome,
  deadlineMs,
) {
  let killError;
  if (!childExited) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      killError = error;
    }
  }

  let closeError;
  try {
    await waitForChildClose(closeOutcome, deadlineMs);
  } catch (error) {
    closeError = error;
  }
  if (killError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [killError, closeError],
      "Installed stdio child kill and close wait both failed",
      { cause: killError },
    );
  }
  if (killError !== undefined) throw killError;
  if (closeError !== undefined) throw closeError;
}

async function waitForNoReaderShutdown(
  exitOutcome,
  streamCompletion,
  protocolFailure,
  deadlineMs,
) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new InstalledStdioProtocolError(
            "INSTALLED_STDIO_EXIT_TIMEOUT",
            "Installed stdio child shutdown deadline exceeded",
          ),
        ),
      deadlineMs,
    );
  });
  const failed = protocolFailure.then((error) => {
    throw error;
  });
  try {
    const [outcome] = await Promise.race([
      Promise.all([exitOutcome, streamCompletion]),
      failed,
      deadline,
    ]);
    if (outcome.error !== undefined) throw outcome.error;
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

export async function runInstalledStdioProtocolSmoke({
  prepareInstalledPackageImpl = prepareInstalledPackage,
  spawnImpl = spawn,
  writeFileImpl = writeFile,
  responseDeadlineMs = INSTALLED_STDIO_RESPONSE_DEADLINE_MS,
  collectorLimits = DEFAULT_COLLECTOR_LIMITS,
  stderrByteLimit = INSTALLED_STDIO_STDERR_BYTES,
  childCleanupDeadlineMs = 5_000,
} = {}) {
  return withInstalledPackage(
    "stdio",
    async (installed) => {
      let child;
      let protocolFailed = false;
      let protocolError;
      let childCleanupError;
      let childExited = false;
      let childCloseOutcome;
      let detachChildListeners = () => {};
      try {
        const runner = join(installed.consumer, "stdio-runner.mjs");
        await writeFileImpl(
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

        child = spawnImpl(process.execPath, [runner], {
          cwd: installed.consumer,
          detached: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const terminated = Promise.withResolvers();
        const exited = Promise.withResolvers();
        const closed = Promise.withResolvers();
        childCloseOutcome = closed.promise;
        const collector = new JsonLineCollector({
          termination: terminated.promise,
          deadlineMs: responseDeadlineMs,
          limits: collectorLimits,
        });
        let stderr = "";
        let stderrBytes = 0;
        let stderrExceeded = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        const onStdoutData = (chunk) => collector.push(chunk);
        const onStderrData = (chunk) => {
          if (stderrExceeded) return;
          const nextBytes = stderrBytes + Buffer.byteLength(chunk, "utf8");
          if (nextBytes > stderrByteLimit) {
            stderrExceeded = true;
            stderr = "";
            collector.fail(
              new InstalledStdioProtocolError(
                "INSTALLED_STDIO_STDERR_LIMIT",
                "Installed stdio diagnostics exceeded the byte limit",
              ),
            );
            return;
          }
          stderrBytes = nextBytes;
          stderr += chunk;
        };
        const onStdoutEnd = () => {
          collector.end();
          terminated.resolve();
        };
        const onStdoutError = () => {
          collector.fail(
            new InstalledStdioProtocolError(
              "INSTALLED_STDIO_STREAM_FAILURE",
              "Installed stdio child output stream failed",
            ),
          );
          terminated.resolve();
        };
        const onChildExit = (code, signal) => {
          childExited = true;
          exited.resolve({ code, signal });
          terminated.resolve();
        };
        const onChildError = () => {
          const error = new InstalledStdioProtocolError(
            "INSTALLED_STDIO_EARLY_TERMINATION",
            "Installed stdio child terminated before the expected protocol response",
          );
          exited.resolve({ error });
          terminated.resolve();
        };
        const onChildClose = () => {
          closed.resolve();
        };
        const onStdinError = () => {};
        child.stdout.on("data", onStdoutData);
        child.stderr.on("data", onStderrData);
        child.stdout.once("end", onStdoutEnd);
        child.stdout.once("error", onStdoutError);
        child.once("exit", onChildExit);
        child.once("error", onChildError);
        child.once("close", onChildClose);
        child.stdin.once?.("error", onStdinError);
        detachChildListeners = () => {
          child.stdout.off("data", onStdoutData);
          child.stderr.off("data", onStderrData);
          child.stdout.off("end", onStdoutEnd);
          child.stdout.off("error", onStdoutError);
          child.off("exit", onChildExit);
          child.off("error", onChildError);
          child.off("close", onChildClose);
          child.stdin.off?.("error", onStdinError);
        };

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

        const largeRequestId = `0:${"i".repeat(
          INSTALLED_STDIO_LARGE_ID_SUFFIX_BYTES,
        )}`;
        const largeControlFrame = JSON.stringify({
          jsonrpc: "2.0",
          id: largeRequestId,
          method: "tools/call",
          params: {
            name: "jetkvm_session_connect",
            arguments: { request_id: "success", timeout_ms: 100 },
          },
        });
        assert.ok(Buffer.byteLength(largeControlFrame, "utf8") > 1_800_000);
        assert.ok(
          Buffer.byteLength(largeControlFrame, "utf8") <= 2 * 1024 * 1024,
        );
        child.stdin.write(`${largeControlFrame}\n`);
        await collector.waitFor(4);
        assert.equal(collector.messages[3].id, largeRequestId);
        assert.equal(collector.messages[3].result.structuredContent.ok, true);

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
        await collector.waitFor(5);
        assert.equal(collector.messages[4].id, 5);
        assert.equal(
          collector.messages.some((message) => message.id === 4),
          false,
        );

        child.stdin.end();
        const exit = await waitForChildExit(
          exited.promise,
          collector.failure,
          responseDeadlineMs,
        );
        assert.deepEqual(exit, { code: 0, signal: null });
        assert.equal(stderr, "jetkvm-mcp: malformed stdio protocol frame\n");
        console.log("installed stdio protocol smoke ok");
      } catch (error) {
        protocolFailed = true;
        protocolError = error;
      } finally {
        if (child !== undefined && childCloseOutcome !== undefined) {
          try {
            await closeChildAfterOperation(
              child,
              childExited,
              childCloseOutcome,
              childCleanupDeadlineMs,
            );
          } catch (error) {
            childCleanupError = error;
          }
          for (const stream of [child.stdin, child.stdout, child.stderr]) {
            try {
              stream.destroy?.();
            } catch (error) {
              childCleanupError ??= error;
            }
          }
          detachChildListeners();
        }
      }

      if (protocolFailed && childCleanupError !== undefined) {
        throw new AggregateError(
          [protocolError, childCleanupError],
          "Installed stdio protocol and child cleanup both failed",
          { cause: protocolError },
        );
      }
      if (protocolFailed) throw protocolError;
      if (childCleanupError !== undefined) throw childCleanupError;
    },
    { prepareInstalledPackageImpl },
  );
}

export async function runInstalledStdioNoReaderSmoke({
  prepareInstalledPackageImpl = prepareInstalledPackage,
  spawnImpl = spawn,
  writeFileImpl = writeFile,
  exitDeadlineMs = 15_000,
  stderrByteLimit = INSTALLED_STDIO_STDERR_BYTES,
  largeIdSuffixBytes = INSTALLED_STDIO_LARGE_ID_SUFFIX_BYTES,
  childCleanupDeadlineMs = 5_000,
} = {}) {
  return withInstalledPackage(
    "stdio-no-reader",
    async (installed) => {
      let child;
      let childExited = false;
      let operationFailed = false;
      let operationError;
      let childCleanupError;
      let childCloseOutcome;
      let detachChildListeners = () => {};
      try {
        const runner = join(installed.consumer, "stdio-no-reader-runner.mjs");
        await writeFileImpl(
          runner,
          `import { startStdioServer } from "@wyrmkeep/jetkvm-mcp/dist/mcp/stdio.js";
import { handlers } from "./deterministic-handlers.mjs";

const handle = await startStdioServer(handlers);
await handle.closed;
`,
        );

        child = spawnImpl(process.execPath, [runner], {
          cwd: installed.consumer,
          detached: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const exited = Promise.withResolvers();
        const initialized = Promise.withResolvers();
        const protocolFailure = Promise.withResolvers();
        const stderrEnded = Promise.withResolvers();
        const closed = Promise.withResolvers();
        childCloseOutcome = closed.promise;
        const expectedDiagnostic = "jetkvm-mcp: stdio output queue overflow\n";
        let stderr = "";
        let stderrBytes = 0;
        let stderrExceeded = false;
        let initializationBuffer = "";
        let initializationComplete = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        const onStdoutData = (chunk) => {
          if (initializationComplete) return;
          try {
            initializationBuffer += chunk;
            if (Buffer.byteLength(initializationBuffer, "utf8") > 1024 * 1024) {
              protocolFailure.resolve(
                new InstalledStdioProtocolError(
                  "INSTALLED_STDIO_FRAME_TOO_LARGE",
                  "Installed stdio initialization response exceeds the byte limit",
                ),
              );
              return;
            }
            const newline = initializationBuffer.indexOf("\n");
            if (newline < 0) return;
            const response = JSON.parse(initializationBuffer.slice(0, newline));
            initializationComplete = true;
            initializationBuffer = "";
            initialized.resolve(response);
          } catch {
            protocolFailure.resolve(
              new InstalledStdioProtocolError(
                "INSTALLED_STDIO_MALFORMED_JSON",
                "Installed stdio child emitted malformed initialization JSON",
              ),
            );
          }
        };
        const onStdoutError = () => {
          protocolFailure.resolve(
            new InstalledStdioProtocolError(
              "INSTALLED_STDIO_STREAM_FAILURE",
              "Installed stdio child output stream failed",
            ),
          );
        };
        const onStderrData = (chunk) => {
          if (stderrExceeded) return;
          const nextBytes = stderrBytes + Buffer.byteLength(chunk, "utf8");
          if (nextBytes > stderrByteLimit) {
            stderrExceeded = true;
            stderr = "";
            protocolFailure.resolve(
              new InstalledStdioProtocolError(
                "INSTALLED_STDIO_STDERR_LIMIT",
                "Installed stdio diagnostics exceeded the byte limit",
              ),
            );
            return;
          }
          stderrBytes = nextBytes;
          stderr += chunk;
        };
        const onStderrEnd = () => {
          stderrEnded.resolve();
        };
        const onChildExit = (code, signal) => {
          childExited = true;
          exited.resolve({ code, signal });
        };
        const onChildError = () => {
          exited.resolve({
            error: new InstalledStdioProtocolError(
              "INSTALLED_STDIO_EARLY_TERMINATION",
              "Installed stdio child terminated before bounded output shutdown",
            ),
          });
        };
        const onChildClose = () => {
          closed.resolve();
        };
        const onStdinError = () => {};
        child.stdout.on("data", onStdoutData);
        child.stdout.once("error", onStdoutError);
        child.stderr.on("data", onStderrData);
        child.stderr.once("end", onStderrEnd);
        child.once("exit", onChildExit);
        child.once("error", onChildError);
        child.once("close", onChildClose);
        child.stdin.once?.("error", onStdinError);
        detachChildListeners = () => {
          child.stdout.off("data", onStdoutData);
          child.stdout.off("error", onStdoutError);
          child.stderr.off("data", onStderrData);
          child.stderr.off("end", onStderrEnd);
          child.off("exit", onChildExit);
          child.off("error", onChildError);
          child.off("close", onChildClose);
          child.stdin.off?.("error", onStdinError);
        };

        const initialize = {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: {
              name: "installed-stdio-no-reader-smoke",
              version: "1.0.0",
            },
          },
        };
        child.stdin.write(`${JSON.stringify(initialize)}\n`);
        const initializeResponse = await waitForNoReaderInitialization(
          initialized.promise,
          exited.promise,
          protocolFailure.promise,
          exitDeadlineMs,
        );
        assert.equal(initializeResponse.id, 1);
        assert.equal(initializeResponse.result.protocolVersion, "2025-11-25");
        child.stdout.off("data", onStdoutData);
        child.stdout.pause?.();

        const largeIdSuffix = "i".repeat(largeIdSuffixBytes);
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          })}\n`,
        );
        for (let index = 0; index < 12; index += 1) {
          const frame = JSON.stringify({
            jsonrpc: "2.0",
            id: `${index}:${largeIdSuffix}`,
            method: "tools/call",
            params: {
              name: "jetkvm_session_connect",
              arguments: { request_id: "success", timeout_ms: 100 },
            },
          });
          assert.ok(Buffer.byteLength(frame, "utf8") <= 2 * 1024 * 1024);
          child.stdin.write(`${frame}\n`);
        }

        const exit = await waitForNoReaderShutdown(
          exited.promise,
          Promise.race([stderrEnded.promise, closed.promise]),
          protocolFailure.promise,
          exitDeadlineMs,
        );
        if (stderr !== expectedDiagnostic) {
          throw new InstalledStdioProtocolError(
            "INSTALLED_STDIO_DIAGNOSTIC_MISMATCH",
            "Installed stdio output overflow diagnostic did not match",
          );
        }
        assert.deepEqual(exit, { code: 1, signal: null });
        console.log("installed stdio no-reader smoke ok");
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        if (child !== undefined && childCloseOutcome !== undefined) {
          try {
            await closeChildAfterOperation(
              child,
              childExited,
              childCloseOutcome,
              childCleanupDeadlineMs,
            );
          } catch (error) {
            childCleanupError = error;
          }
          for (const stream of [child.stdin, child.stdout, child.stderr]) {
            try {
              stream.destroy?.();
            } catch (error) {
              childCleanupError ??= error;
            }
          }
          detachChildListeners();
        }
      }

      if (operationFailed && childCleanupError !== undefined) {
        throw new AggregateError(
          [operationError, childCleanupError],
          "Installed stdio no-reader operation and child cleanup both failed",
          { cause: operationError },
        );
      }
      if (operationFailed) throw operationError;
      if (childCleanupError !== undefined) throw childCleanupError;
    },
    { prepareInstalledPackageImpl },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runInstalledStdioProtocolSmoke();
  await runInstalledStdioNoReaderSmoke();
}
