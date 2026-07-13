import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

import {
  prepareInstalledPackage,
  runInstalledModule,
} from "./installed-smoke-support.mjs";

const PACK_STDOUT = `${JSON.stringify([{ filename: "jetkvm-mcp.tgz" }])}\n`;

function harness() {
  let root;
  const execCalls = [];
  const dependencies = {
    mkdtempImpl: async (prefix) => {
      root = await mkdtemp(prefix);
      return root;
    },
    mkdirImpl: mkdir,
    rmImpl: rm,
    writeFileImpl: writeFile,
    execFileImpl: async (command, args, options) => {
      execCalls.push({ command, args, options });
      return {
        stdout: args[0] === "pack" ? PACK_STDOUT : "",
        stderr: "",
      };
    },
  };

  return {
    dependencies,
    execCalls,
    get root() {
      return root;
    },
  };
}

async function assertRootAbsent(root) {
  assert.equal(typeof root, "string");
  await assert.rejects(
    access(root),
    (error) => error?.code === "ENOENT",
    `expected temporary root to be absent: ${root}`,
  );
}

async function assertPreparationRejects(h, expected) {
  const preparation = prepareInstalledPackage("cleanup-test", h.dependencies);
  await assert.rejects(
    preparation.then(async (installed) => {
      await installed.cleanup();
    }),
    expected,
  );
  await assertRootAbsent(h.root);
}

function assertExecutionPolicy(options, expectedTimeout) {
  assert.equal(options.timeout, expectedTimeout);
  assert.equal(options.killSignal, "SIGKILL");
  assert.equal(options.windowsHide, true);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
}

function assertRedactedPhaseError(error, phase, sensitiveText) {
  assert.equal(error?.name, "InstalledSmokePhaseError");
  assert.equal(error?.code, "INSTALLED_SMOKE_PHASE_FAILED");
  assert.equal(error?.phase, phase);
  assert.equal(error?.message, `Installed smoke phase failed: ${phase}`);
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.doesNotMatch(
    `${String(error)}\n${JSON.stringify(error)}`,
    new RegExp(sensitiveText),
  );
  return true;
}

test("removes the temporary root when artifact directory creation fails", async () => {
  const h = harness();
  const failure = new Error("mkdir failed");
  h.dependencies.mkdirImpl = async () => {
    throw failure;
  };

  await assertPreparationRejects(h, (error) => error === failure);
});

test("removes the temporary root when consumer package writing fails", async () => {
  const h = harness();
  const failure = new Error("package write failed");
  h.dependencies.writeFileImpl = async () => {
    throw failure;
  };

  await assertPreparationRejects(h, (error) => error === failure);
});

test("removes the temporary root and redacts malformed npm pack output", async () => {
  const h = harness();
  h.dependencies.execFileImpl = async () => ({
    stdout: "sensitive-pack-output",
    stderr: "",
  });

  await assertPreparationRejects(h, (error) =>
    assertRedactedPhaseError(error, "npm_pack_result", "sensitive-pack-output"),
  );
});

test("removes the temporary root and redacts package installation failures", async () => {
  const h = harness();
  const sensitiveText = "sensitive-install-output";
  h.dependencies.execFileImpl = async (_command, args) => {
    if (args[0] === "install") throw new Error(sensitiveText);
    return { stdout: PACK_STDOUT, stderr: "" };
  };

  await assertPreparationRejects(h, (error) =>
    assertRedactedPhaseError(error, "npm_install", sensitiveText),
  );
});

test("removes the temporary root when deterministic handler writing fails", async () => {
  const h = harness();
  const failure = new Error("handler write failed");
  h.dependencies.writeFileImpl = async (path, ...args) => {
    if (path.endsWith("deterministic-handlers.mjs")) throw failure;
    return writeFile(path, ...args);
  };

  await assertPreparationRejects(h, (error) => error === failure);
});

test("removes the temporary root and redacts npm pack command failures", async () => {
  const h = harness();
  const sensitiveText = "sensitive-pack-command-output";
  h.dependencies.execFileImpl = async () => {
    throw new Error(sensitiveText);
  };

  await assertPreparationRejects(h, (error) =>
    assertRedactedPhaseError(error, "npm_pack", sensitiveText),
  );
});

test("bounds npm pack with a finite force-kill policy", async () => {
  const h = harness();
  const installed = await prepareInstalledPackage(
    "cleanup-test",
    h.dependencies,
  );
  try {
    const call = h.execCalls.find(({ args }) => args[0] === "pack");
    assert.ok(call);
    assertExecutionPolicy(call.options, 120_000);
  } finally {
    await installed.cleanup();
  }
});

test("bounds npm install with a finite force-kill policy", async () => {
  const h = harness();
  const installed = await prepareInstalledPackage(
    "cleanup-test",
    h.dependencies,
  );
  try {
    const call = h.execCalls.find(({ args }) => args[0] === "install");
    assert.ok(call);
    assertExecutionPolicy(call.options, 120_000);
  } finally {
    await installed.cleanup();
  }
});

test("bounds installed module execution and redacts execution failures", async () => {
  const h = harness();
  const sensitiveText = "sensitive-runner-output";
  const installed = await prepareInstalledPackage(
    "cleanup-test",
    h.dependencies,
  );
  let capturedOptions;
  try {
    await assert.rejects(
      runInstalledModule(
        installed.consumer,
        "timeout-runner.mjs",
        "setInterval(() => {}, 1_000);",
        {
          execFileImpl: async (_command, _args, options) => {
            capturedOptions = options;
            throw new Error(sensitiveText);
          },
        },
      ),
      (error) =>
        assertRedactedPhaseError(error, "installed_module", sensitiveText),
    );
    assertExecutionPolicy(capturedOptions, 30_000);
  } finally {
    await installed.cleanup();
  }
  await assertRootAbsent(h.root);
});

test("preserves preparation and cleanup failures in an AggregateError", async () => {
  const h = harness();
  const preparationFailure = new Error("mkdir failed");
  const cleanupFailure = new Error("cleanup failed");
  h.dependencies.mkdirImpl = async () => {
    throw preparationFailure;
  };
  h.dependencies.rmImpl = async () => {
    throw cleanupFailure;
  };

  try {
    await assert.rejects(
      prepareInstalledPackage("cleanup-test", h.dependencies),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [preparationFailure, cleanupFailure]);
        assert.equal(error.cause, preparationFailure);
        return true;
      },
    );
  } finally {
    if (h.root !== undefined)
      await rm(h.root, { recursive: true, force: true });
  }
});

test("successful preparation returns an idempotent cleanup", async () => {
  const h = harness();
  let removalCount = 0;
  h.dependencies.rmImpl = async (...args) => {
    removalCount += 1;
    return rm(...args);
  };

  const installed = await prepareInstalledPackage(
    "cleanup-test",
    h.dependencies,
  );
  assert.equal(installed.root, h.root);
  await Promise.all([installed.cleanup(), installed.cleanup()]);
  await installed.cleanup();

  assert.equal(removalCount, 1);
  await assertRootAbsent(h.root);
});
