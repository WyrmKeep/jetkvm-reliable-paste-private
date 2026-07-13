import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { prepareInstalledPackage } from "./installed-smoke-support.mjs";

const PACK_STDOUT = `${JSON.stringify([{ filename: "jetkvm-mcp.tgz" }])}\n`;

function harness() {
  let root;
  const dependencies = {
    mkdtempImpl: async (prefix) => {
      root = await mkdtemp(prefix);
      return root;
    },
    mkdirImpl: mkdir,
    rmImpl: rm,
    writeFileImpl: writeFile,
    execFileImpl: async (_command, args) => ({
      stdout: args[0] === "pack" ? PACK_STDOUT : "",
      stderr: "",
    }),
  };

  return {
    dependencies,
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

test("removes the temporary root when npm pack output cannot be parsed", async () => {
  const h = harness();
  h.dependencies.execFileImpl = async () => ({
    stdout: "not json",
    stderr: "",
  });

  await assertPreparationRejects(h, SyntaxError);
});

test("removes the temporary root when package installation fails", async () => {
  const h = harness();
  const failure = new Error("install failed");
  h.dependencies.execFileImpl = async (_command, args) => {
    if (args[0] === "install") throw failure;
    return { stdout: PACK_STDOUT, stderr: "" };
  };

  await assertPreparationRejects(h, (error) => error === failure);
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
