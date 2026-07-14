import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function fakeGo(body) {
  const directory = await mkdtemp(join(tmpdir(), "jetkvm-go-list-"));
  const executable = join(directory, "go");
  await writeFile(executable, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(executable, 0o755);
  return { directory, executable };
}

function listPackages(goExecutable) {
  return spawnSync(
    "make",
    ["--no-print-directory", "list_device_test_packages", `GO_CMD=${goExecutable}`],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
}

test("device test discovery uses target-configured Go and fails closed", async () => {
  const passing = await fakeGo(
    "printf '%s\\n' github.com/jetkvm/kvm/internal/atx github.com/jetkvm/kvm/internal/controlsession",
  );
  const failing = await fakeGo("exit 17");
  try {
    const listed = listPackages(passing.executable);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split("\n"), [
      "github.com/jetkvm/kvm/internal/atx",
      "github.com/jetkvm/kvm/internal/controlsession",
    ]);

    const rejected = listPackages(failing.executable);
    assert.notEqual(rejected.status, 0);
    assert.match(
      rejected.stderr,
      /device test package discovery failed/u,
    );
  } finally {
    await rm(passing.directory, { recursive: true, force: true });
    await rm(failing.directory, { recursive: true, force: true });
  }
});
