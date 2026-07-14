import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import * as installedSmokeSupport from "./installed-smoke-support.mjs";

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.destroyCount = 0;
    this.pauseCount = 0;
  }

  setEncoding() {}

  pause() {
    this.pauseCount += 1;
  }

  destroy() {
    this.destroyCount += 1;
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.stdinWriteCount = 0;
    this.stdin = {
      write: (chunk) => {
        this.stdinWriteCount += 1;
        this.onStdinWrite?.(chunk);
      },
      end: () => this.onStdinEnd?.(),
    };
    this.killSignals = [];
    this.autoCloseOnKill = true;
  }

  kill(signal) {
    this.killSignals.push(signal);
    this.onKill?.(signal);
    if (this.autoCloseOnKill) {
      queueMicrotask(() => this.emit("close", null, signal));
    }
    return true;
  }
}

function installedFixture(cleanupImpl) {
  return {
    root: "/temporary/installed-smoke",
    consumer: "/temporary/installed-smoke/consumer",
    cleanup: cleanupImpl,
  };
}

function assertDualFailure(error, operationFailure, cleanupFailure) {
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors, [operationFailure, cleanupFailure]);
  assert.equal(error.cause, operationFailure);
  return true;
}

for (const label of ["contracts", "stdio", "sse"]) {
  test(`${label} runner preserves operation and cleanup failures`, async () => {
    const operationFailure = new Error(`${label} operation failed`);
    const cleanupFailure = new Error(`${label} cleanup failed`);

    await assert.rejects(
      installedSmokeSupport.withInstalledPackage(
        label,
        async () => {
          throw operationFailure;
        },
        {
          prepareInstalledPackageImpl: async (actualLabel) => {
            assert.equal(actualLabel, label);
            return installedFixture(async () => {
              throw cleanupFailure;
            });
          },
        },
      ),
      (error) => assertDualFailure(error, operationFailure, cleanupFailure),
    );
  });
}

test("installed runner surfaces a cleanup-only failure directly", async () => {
  const cleanupFailure = new Error("cleanup only failed");

  await assert.rejects(
    installedSmokeSupport.withInstalledPackage(
      "contracts",
      async () => "completed",
      {
        prepareInstalledPackageImpl: async () =>
          installedFixture(async () => {
            throw cleanupFailure;
          }),
      },
    ),
    (error) => error === cleanupFailure,
  );
});

for (const [modulePath, exportName] of [
  ["./installed-contracts-smoke.mjs", "runInstalledContractsSmoke"],
  ["./installed-sse-protocol-smoke.mjs", "runInstalledSseProtocolSmoke"],
]) {
  test(`${exportName} uses dual-failure-safe installed cleanup`, async () => {
    const operationFailure = new Error("protocol assertion failed");
    const cleanupFailure = new Error("runner cleanup failed");
    const runnerModule = await import(modulePath);

    await assert.rejects(
      runnerModule[exportName]({
        prepareInstalledPackageImpl: async () =>
          installedFixture(async () => {
            throw cleanupFailure;
          }),
        runInstalledModuleImpl: async () => {
          throw operationFailure;
        },
      }),
      (error) => assertDualFailure(error, operationFailure, cleanupFailure),
    );
  });
}

const INSTALLED_TOOL_NAMES = [
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
const INSTALLED_TOOLS = await Promise.all(
  INSTALLED_TOOL_NAMES.map(async (name) => ({
    name,
    inputSchema: JSON.parse(
      await readFile(
        new URL(`../schemas/${name}.input.schema.json`, import.meta.url),
        "utf8",
      ),
    ),
    outputSchema: JSON.parse(
      await readFile(
        new URL(`../schemas/${name}.result.schema.json`, import.meta.url),
        "utf8",
      ),
    ),
  })),
);

function successfulStdioChild(stderrChunks) {
  const child = new FakeChild();
  let input = "";
  const respond = (message) => {
    child.stdout.emit("data", `${JSON.stringify(message)}\n`);
  };
  child.onStdinWrite = (chunk) => {
    input += chunk;
    while (true) {
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.method === "initialize") {
        respond({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-11-25" },
        });
      } else if (message.method === "tools/list") {
        respond({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: INSTALLED_TOOLS,
          },
        });
      } else if (message.method === "tools/call" && message.id !== 30) {
        if (String(message.id).startsWith("invalid:")) {
          respond({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: "Invalid params" },
          });
        } else if (message.id === "redaction-probe") {
          respond({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "Tool handler failed" },
          });
        } else {
          respond({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              structuredContent: {
                ok: true,
                tool: message.params.name,
              },
            },
          });
        }
      }
    }
  };
  child.onStdinEnd = () => {
    queueMicrotask(() => {
      child.emit("exit", 0, null);
      setTimeout(() => {
        for (const chunk of stderrChunks) child.stderr.emit("data", chunk);
        child.stdout.emit("end");
        child.stderr.emit("end");
        child.emit("close", 0, null);
      }, 1);
    });
  };
  return child;
}

test("normal stdio waits for final stderr after child exit", async () => {
  const { runInstalledStdioProtocolSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  const child = successfulStdioChild([
    "jetkvm-mcp: malformed stdio protocol frame\n",
  ]);
  let cleanupCount = 0;

  await runInstalledStdioProtocolSmoke({
    prepareInstalledPackageImpl: async () =>
      installedFixture(async () => {
        cleanupCount += 1;
      }),
    spawnImpl: () => child,
    writeFileImpl: async () => {},
    responseDeadlineMs: 20,
    childCleanupDeadlineMs: 20,
    largeIdSuffixBytes: 32,
  });

  assert.deepEqual(child.killSignals, []);
  assert.equal(cleanupCount, 1);
});

test("normal stdio fails closed on late extra, overflow, or mismatched stderr", async (t) => {
  const { runInstalledStdioProtocolSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  for (const scenario of [
    {
      name: "late extra",
      chunks: [
        "jetkvm-mcp: malformed stdio protocol frame\n",
        "late diagnostic\n",
      ],
      code: "INSTALLED_STDIO_DIAGNOSTIC_MISMATCH",
      stderrByteLimit: 64 * 1024,
    },
    {
      name: "overflow",
      chunks: ["diagnostic flood"],
      code: "INSTALLED_STDIO_STDERR_LIMIT",
      stderrByteLimit: 8,
    },
    {
      name: "mismatch",
      chunks: ["jetkvm-mcp: different diagnostic\n"],
      code: "INSTALLED_STDIO_DIAGNOSTIC_MISMATCH",
      stderrByteLimit: 64 * 1024,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const child = successfulStdioChild(scenario.chunks);
      let cleanupCount = 0;
      await assert.rejects(
        runInstalledStdioProtocolSmoke({
          prepareInstalledPackageImpl: async () =>
            installedFixture(async () => {
              cleanupCount += 1;
            }),
          spawnImpl: () => child,
          writeFileImpl: async () => {},
          responseDeadlineMs: 20,
          childCleanupDeadlineMs: 20,
          largeIdSuffixBytes: 32,
          stderrByteLimit: scenario.stderrByteLimit,
        }),
        (error) => error?.code === scenario.code,
      );
      assert.deepEqual(child.killSignals, []);
      assert.equal(cleanupCount, 1);
    });
  }
});

test("stdio runner rejects deterministic early exit after awaiting child close", async () => {
  const { runInstalledStdioProtocolSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  const child = new FakeChild();
  let cleanupCount = 0;

  await assert.rejects(
    runInstalledStdioProtocolSmoke({
      prepareInstalledPackageImpl: async () =>
        installedFixture(async () => {
          cleanupCount += 1;
        }),
      spawnImpl: () => {
        queueMicrotask(() => {
          child.emit("exit", 1, null);
          queueMicrotask(() => child.emit("close", 1, null));
        });
        return child;
      },
      writeFileImpl: async () => {},
      responseDeadlineMs: 20,
      childCleanupDeadlineMs: 20,
    }),
    (error) => {
      assert.equal(error?.code, "INSTALLED_STDIO_EARLY_TERMINATION");
      assert.equal(
        error?.message,
        "Installed stdio child terminated before the expected protocol response",
      );
      return true;
    },
  );

  assert.deepEqual(child.killSignals, []);
  assert.equal(cleanupCount, 1);
});

test("stdio runner rejects a hung child at its deadline and force-kills it", async () => {
  const { runInstalledStdioProtocolSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  const child = new FakeChild();
  let cleanupCount = 0;

  await assert.rejects(
    runInstalledStdioProtocolSmoke({
      prepareInstalledPackageImpl: async () =>
        installedFixture(async () => {
          cleanupCount += 1;
        }),
      spawnImpl: () => child,
      writeFileImpl: async () => {},
      responseDeadlineMs: 5,
    }),
    (error) => {
      assert.equal(error?.code, "INSTALLED_STDIO_RESPONSE_TIMEOUT");
      assert.equal(
        error?.message,
        "Installed stdio protocol response deadline exceeded",
      );
      return true;
    },
  );

  assert.deepEqual(child.killSignals, ["SIGKILL"]);
  assert.equal(cleanupCount, 1);
});

test("stdio runner aggregates early exit with cleanup failure", async () => {
  const { runInstalledStdioProtocolSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  const child = new FakeChild();
  const cleanupFailure = new Error("stdio cleanup failed");

  await assert.rejects(
    runInstalledStdioProtocolSmoke({
      prepareInstalledPackageImpl: async () =>
        installedFixture(async () => {
          throw cleanupFailure;
        }),
      spawnImpl: () => {
        queueMicrotask(() => child.stdout.emit("end"));
        return child;
      },
      writeFileImpl: async () => {},
      responseDeadlineMs: 20,
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0]?.code, "INSTALLED_STDIO_EARLY_TERMINATION");
      assert.equal(error.errors[1], cleanupFailure);
      return true;
    },
  );

  assert.deepEqual(child.killSignals, ["SIGKILL"]);
});

function assertRunnerReleased(child) {
  assert.deepEqual(child.killSignals, ["SIGKILL"]);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
  for (const stream of [child.stdout, child.stderr]) {
    assert.equal(stream.listenerCount("data"), 0);
    assert.equal(stream.listenerCount("end"), 0);
    assert.equal(stream.listenerCount("error"), 0);
    assert.equal(stream.destroyCount, 1);
  }
}

async function expectBoundedStdioFailure({
  emitFailure,
  expectedCode,
  expectedMessage,
  collectorLimits = {
    frameBytes: 64,
    cumulativeBytes: 128,
    messageCount: 8,
  },
  stderrByteLimit = 64,
  sensitiveText,
}) {
  const { runInstalledStdioProtocolSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  const child = new FakeChild();
  let cleanupCount = 0;

  await assert.rejects(
    runInstalledStdioProtocolSmoke({
      prepareInstalledPackageImpl: async () =>
        installedFixture(async () => {
          cleanupCount += 1;
        }),
      spawnImpl: () => {
        queueMicrotask(() => emitFailure(child));
        return child;
      },
      writeFileImpl: async () => {},
      responseDeadlineMs: 50,
      collectorLimits,
      stderrByteLimit,
    }),
    (error) => {
      assert.equal(error?.code, expectedCode);
      assert.equal(error?.message, expectedMessage);
      if (sensitiveText !== undefined) {
        assert.doesNotMatch(
          `${String(error)}\n${JSON.stringify(error)}`,
          new RegExp(sensitiveText),
        );
      }
      return true;
    },
  );

  assert.equal(cleanupCount, 1);
  assertRunnerReleased(child);
}

test("stdio runner bounds oversized stdout frames without listener or child leaks", async () => {
  await expectBoundedStdioFailure({
    emitFailure: (child) =>
      child.stdout.emit("data", '{"sensitive-frame":"too-large"}\n'),
    expectedCode: "INSTALLED_STDIO_FRAME_TOO_LARGE",
    expectedMessage: "Installed stdio protocol frame exceeds the byte limit",
    collectorLimits: {
      frameBytes: 8,
      cumulativeBytes: 128,
      messageCount: 8,
    },
    sensitiveText: "sensitive-frame",
  });
});

test("stdio runner catches incomplete stdout frames inside the shared failure race", async () => {
  await expectBoundedStdioFailure({
    emitFailure: (child) => {
      child.stdout.emit("data", '{"sensitive-incomplete":');
      child.stdout.emit("end");
    },
    expectedCode: "INSTALLED_STDIO_INCOMPLETE_FRAME",
    expectedMessage:
      "Installed stdio child output ended with an incomplete frame",
    sensitiveText: "sensitive-incomplete",
  });
});

test("stdio runner catches malformed stdout JSON inside the shared failure race", async () => {
  await expectBoundedStdioFailure({
    emitFailure: (child) =>
      child.stdout.emit("data", "sensitive-malformed-json\n"),
    expectedCode: "INSTALLED_STDIO_MALFORMED_JSON",
    expectedMessage: "Installed stdio child emitted malformed JSON",
    sensitiveText: "sensitive-malformed-json",
  });
});

test("stdio runner bounds the number of parsed stdout messages", async () => {
  await expectBoundedStdioFailure({
    emitFailure: (child) => child.stdout.emit("data", "{}\n{}\n{}\n"),
    expectedCode: "INSTALLED_STDIO_MESSAGE_LIMIT",
    expectedMessage: "Installed stdio protocol message limit exceeded",
    collectorLimits: {
      frameBytes: 16,
      cumulativeBytes: 128,
      messageCount: 2,
    },
  });
});

test("stdio runner bounds cumulative stdout bytes", async () => {
  await expectBoundedStdioFailure({
    emitFailure: (child) => child.stdout.emit("data", "{}\n{}\n"),
    expectedCode: "INSTALLED_STDIO_CUMULATIVE_LIMIT",
    expectedMessage:
      "Installed stdio protocol output exceeds the cumulative byte limit",
    collectorLimits: {
      frameBytes: 16,
      cumulativeBytes: 5,
      messageCount: 8,
    },
  });
});

test("stdio runner bounds stderr without exposing or retaining its flood", async () => {
  await expectBoundedStdioFailure({
    emitFailure: (child) =>
      child.stderr.emit("data", "sensitive-diagnostic-flood"),
    expectedCode: "INSTALLED_STDIO_STDERR_LIMIT",
    expectedMessage: "Installed stdio diagnostics exceeded the byte limit",
    stderrByteLimit: 8,
    sensitiveText: "sensitive-diagnostic-flood",
  });
});

test("stdio protocol failure waits for delayed child close before temp cleanup", async () => {
  const { runInstalledStdioProtocolSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  const child = new FakeChild();
  child.autoCloseOnKill = false;
  const events = [];
  child.onKill = () => {
    events.push("kill");
    setTimeout(() => {
      events.push("close");
      child.emit("close", null, "SIGKILL");
    }, 5);
  };

  await assert.rejects(
    runInstalledStdioProtocolSmoke({
      prepareInstalledPackageImpl: async () =>
        installedFixture(async () => {
          events.push("cleanup");
        }),
      spawnImpl: () => {
        queueMicrotask(() =>
          child.stdout.emit("data", "sensitive-malformed-json\n"),
        );
        return child;
      },
      writeFileImpl: async () => {},
      responseDeadlineMs: 20,
      childCleanupDeadlineMs: 20,
    }),
    (error) => error?.code === "INSTALLED_STDIO_MALFORMED_JSON",
  );

  assert.deepEqual(events, ["kill", "close", "cleanup"]);
});

test("stdio protocol failure bounds a child that ignores SIGKILL and fails closed", async () => {
  const { runInstalledStdioProtocolSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  const child = new FakeChild();
  child.autoCloseOnKill = false;
  let cleanupCount = 0;

  await assert.rejects(
    runInstalledStdioProtocolSmoke({
      prepareInstalledPackageImpl: async () =>
        installedFixture(async () => {
          cleanupCount += 1;
        }),
      spawnImpl: () => {
        queueMicrotask(() =>
          child.stdout.emit("data", "sensitive-malformed-json\n"),
        );
        return child;
      },
      writeFileImpl: async () => {},
      responseDeadlineMs: 20,
      childCleanupDeadlineMs: 5,
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0]?.code, "INSTALLED_STDIO_MALFORMED_JSON");
      assert.equal(
        error.errors[1]?.code,
        "INSTALLED_STDIO_CHILD_CLEANUP_TIMEOUT",
      );
      return true;
    },
  );

  assert.deepEqual(child.killSignals, ["SIGKILL"]);
  assert.equal(cleanupCount, 1);
});

test("no-reader stdio runner exits from bounded output failure without consuming stdout", async () => {
  const { runInstalledStdioNoReaderSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  const child = new FakeChild();
  let cleanupCount = 0;
  child.onStdinWrite = () => {
    if (child.stdinWriteCount === 1) {
      queueMicrotask(() =>
        child.stdout.emit(
          "data",
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-11-25" },
          })}\n`,
        ),
      );
      return;
    }
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stdout.listenerCount("readable"), 0);
    assert.equal(child.stdout.pauseCount, 1);
    if (child.stdinWriteCount === 14) {
      queueMicrotask(() => {
        child.emit("exit", 1, null);
        queueMicrotask(() => {
          child.stderr.emit(
            "data",
            "jetkvm-mcp: stdio output queue overflow\n",
          );
          child.stderr.emit("end");
          child.emit("close", 1, null);
        });
      });
    }
  };

  await runInstalledStdioNoReaderSmoke({
    prepareInstalledPackageImpl: async () =>
      installedFixture(async () => {
        cleanupCount += 1;
      }),
    spawnImpl: () => child,
    writeFileImpl: async () => {},
    exitDeadlineMs: 20,
    largeIdSuffixBytes: 32,
  });

  assert.ok(child.stdinWriteCount >= 1);
  assert.deepEqual(child.killSignals, []);
  assert.equal(cleanupCount, 1);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
  for (const stream of [child.stdout, child.stderr]) {
    assert.equal(stream.listenerCount("data"), 0);
    assert.equal(stream.listenerCount("error"), 0);
    assert.equal(stream.destroyCount, 1);
  }
});

test("no-reader stdio runner fails closed on absent or mismatched diagnostics", async (t) => {
  const { runInstalledStdioNoReaderSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  for (const [name, diagnostic] of [
    ["absent", null],
    ["mismatched", "jetkvm-mcp: stdio output write timeout\n"],
  ]) {
    await t.test(name, async () => {
      const child = new FakeChild();
      let cleanupCount = 0;
      child.onStdinWrite = () => {
        if (child.stdinWriteCount === 1) {
          queueMicrotask(() =>
            child.stdout.emit(
              "data",
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: { protocolVersion: "2025-11-25" },
              })}\n`,
            ),
          );
          return;
        }
        if (child.stdinWriteCount === 14) {
          queueMicrotask(() => {
            child.emit("exit", 1, null);
            queueMicrotask(() => {
              if (diagnostic !== null) child.stderr.emit("data", diagnostic);
              child.stderr.emit("end");
              child.emit("close", 1, null);
            });
          });
        }
      };

      await assert.rejects(
        runInstalledStdioNoReaderSmoke({
          prepareInstalledPackageImpl: async () =>
            installedFixture(async () => {
              cleanupCount += 1;
            }),
          spawnImpl: () => child,
          writeFileImpl: async () => {},
          exitDeadlineMs: 20,
          largeIdSuffixBytes: 32,
        }),
        (error) => error?.code === "INSTALLED_STDIO_DIAGNOSTIC_MISMATCH",
      );

      assert.deepEqual(child.killSignals, []);
      assert.equal(cleanupCount, 1);
    });
  }
});

test("no-reader stdio runner force-kills a child that misses its finite exit deadline", async () => {
  const { runInstalledStdioNoReaderSmoke } =
    await import("./installed-stdio-protocol-smoke.mjs");
  const child = new FakeChild();
  let cleanupCount = 0;
  child.onStdinWrite = () => {
    if (child.stdinWriteCount === 1) {
      queueMicrotask(() =>
        child.stdout.emit(
          "data",
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-11-25" },
          })}\n`,
        ),
      );
      return;
    }
    if (child.stdinWriteCount === 14) {
      queueMicrotask(() =>
        child.stderr.emit("data", "jetkvm-mcp: stdio output queue overflow\n"),
      );
    }
  };

  await assert.rejects(
    runInstalledStdioNoReaderSmoke({
      prepareInstalledPackageImpl: async () =>
        installedFixture(async () => {
          cleanupCount += 1;
        }),
      spawnImpl: () => child,
      writeFileImpl: async () => {},
      exitDeadlineMs: 5,
      largeIdSuffixBytes: 32,
    }),
    (error) => error?.code === "INSTALLED_STDIO_EXIT_TIMEOUT",
  );

  assert.equal(cleanupCount, 1);
  assertRunnerReleased(child);
});
