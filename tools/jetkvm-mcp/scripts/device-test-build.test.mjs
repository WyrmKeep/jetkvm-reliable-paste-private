import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    [
      "--no-print-directory",
      "list_device_test_packages",
      `GO_CMD=${goExecutable}`,
    ],
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
    assert.match(rejected.stderr, /device test package discovery failed/u);
  } finally {
    await rm(passing.directory, { recursive: true, force: true });
    await rm(failing.directory, { recursive: true, force: true });
  }
});

test("deployment rejects a missing reviewed test archive before device access", () => {
  const result = spawnSync(
    "./dev_deploy.sh",
    [
      "-r",
      "192.0.2.1",
      "--run-go-tests-only",
      "--device-tests-archive",
      "/missing/device-tests.tar.gz",
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Device test archive is not a regular local file/u,
  );
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /Checking if device is reachable/u,
  );
});

test("deployment verifies reviewed device tests after remote upload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jetkvm-device-upload-"));
  const archive = join(directory, "device-tests.tar.gz");
  const remoteInput = join(directory, "remote-input");
  const remoteCommand = join(directory, "remote-command");
  const sha256 = "f".repeat(64);
  try {
    await writeFile(archive, "reviewed-device-tests");
    for (const [name, body] of [
      [
        "git",
        'case "$*" in *abbrev-ref*) echo release;; *) printf "%040d\\n" 0;; esac',
      ],
      ["ping", "exit 0"],
      [
        "ssh",
        'case "$*" in *DEVICE_TESTS_SHA256=*) printf "%s\\n" "$*" > "$CAPTURE_COMMAND"; cat > "$CAPTURE_INPUT";; *) cat >/dev/null || true;; esac',
      ],
    ]) {
      const executable = join(directory, name);
      await writeFile(executable, `#!/bin/sh\n${body}\n`, "utf8");
      await chmod(executable, 0o755);
    }

    const result = spawnSync(
      "./dev_deploy.sh",
      [
        "-r",
        "fixture-device.invalid",
        "--run-go-tests-only",
        "--device-tests-archive",
        archive,
        "--device-tests-sha256",
        sha256,
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          CAPTURE_COMMAND: remoteCommand,
          CAPTURE_INPUT: remoteInput,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const remoteScript = await readFile(remoteInput, "utf8");
    assert.match(
      await readFile(remoteCommand, "utf8"),
      new RegExp(sha256, "u"),
    );
    assert.match(remoteScript, /sha256sum -c -/u);
    assert.match(
      remoteScript,
      /DEVICE_TESTS_ROOT="\/userdata\/jetkvm-mcp-device-tests"/u,
    );
    assert.match(
      remoteScript,
      /DEVICE_TESTS_ARCHIVE="\$\{DEVICE_TESTS_ROOT\}\/device-tests\.tar\.gz"/u,
    );
    assert.doesNotMatch(remoteScript, /\/tmp\/device-tests\.tar\.gz/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deployment cleans the remote workspace when test upload fails", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "jetkvm-device-upload-failure-"),
  );
  const archive = join(directory, "device-tests.tar.gz");
  const commands = join(directory, "remote-commands");
  try {
    await writeFile(archive, "reviewed-device-tests");
    for (const [name, body] of [
      [
        "git",
        'case "$*" in *abbrev-ref*) echo release;; *) printf "%040d\\n" 0;; esac',
      ],
      ["ping", "exit 0"],
      [
        "ssh",
        [
          'printf "%s\\n" "$*" >> "$CAPTURE_COMMANDS"',
          'case "$*" in',
          '  *"cat > /userdata/jetkvm-mcp-device-tests/device-tests.tar.gz"*)',
          "    cat >/dev/null",
          "    exit 23",
          "    ;;",
          "  *) cat >/dev/null || true ;;",
          "esac",
        ].join("\n"),
      ],
    ]) {
      const executable = join(directory, name);
      await writeFile(executable, `#!/bin/sh\n${body}\n`, "utf8");
      await chmod(executable, 0o755);
    }

    const result = spawnSync(
      "./dev_deploy.sh",
      [
        "-r",
        "fixture-device.invalid",
        "--run-go-tests-only",
        "--skip-ui-build",
        "--device-tests-archive",
        archive,
        "--device-tests-sha256",
        "f".repeat(64),
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          CAPTURE_COMMANDS: commands,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /Could not upload reviewed device tests/u,
    );
    const remoteCommands = await readFile(commands, "utf8");
    const uploadIndex = remoteCommands.indexOf(
      "cat > /userdata/jetkvm-mcp-device-tests/device-tests.tar.gz",
    );
    const cleanupIndex = remoteCommands.lastIndexOf(
      "rm -rf /userdata/jetkvm-mcp-device-tests",
    );
    assert.ok(uploadIndex >= 0, "upload command was not attempted");
    assert.ok(
      cleanupIndex > uploadIndex,
      "remote cleanup did not follow the failed upload",
    );
    assert.doesNotMatch(result.stdout, /Running go tests/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
