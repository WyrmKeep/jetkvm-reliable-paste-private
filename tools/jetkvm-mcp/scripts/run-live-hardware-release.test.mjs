import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as liveReleaseModule from "./run-live-hardware-release.mjs";
import { createDeviceReleaseProvenance } from "./device-release-provenance.mjs";
import { buildDirectoryManifest, sha256File } from "./release-evidence.mjs";
import {
  createInstalledMcpOptions,
  createFinalizationError,
  createRigAdapter,
  deployReleaseDeviceBinary,
  loadInstalledMcpSdkFactories,
  validateCurrentReleaseSource,
  validateReleaseDeviceBinary,
} from "./run-live-hardware-release.mjs";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);

test("accepts only an exact-commit device release artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jetkvm-device-binary-"));
  const binaryPath = join(directory, "jetkvm_app");
  const provenancePath = join(directory, "device-binary-provenance.json");
  try {
    await writeFile(binaryPath, "device-binary");
    const expectedSha256 = await sha256File(binaryPath);
    const provenance = await createDeviceReleaseProvenance({
      binaryPath,
      sourceCommit: COMMIT,
      repository: "WyrmKeep/jetkvm-reliable-paste-private",
      workflowRef:
        "WyrmKeep/jetkvm-reliable-paste-private/.github/workflows/build.yml@refs/heads/release",
      runId: "123456",
      runAttempt: 1,
    });
    await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`);
    const expectedProvenanceSha256 = await sha256File(provenancePath);
    const command = async () => ({
      stdout:
        `jetkvm_app: go1.25.1\n` +
        `\tbuild\t-ldflags="-s -w -X github.com/prometheus/common/version.Revision=${COMMIT}"\n`,
    });
    const evidence = await validateReleaseDeviceBinary({
      candidate: { source: { commit_sha: COMMIT } },
      binaryPath,
      expectedSha256,
      command,
      provenancePath,
      expectedProvenanceSha256,
    });
    assert.equal(evidence.sha256, expectedSha256);
    assert.equal(evidence.source_commit, COMMIT);

    await assert.rejects(
      validateReleaseDeviceBinary({
        candidate: { source: { commit_sha: "b".repeat(40) } },
        binaryPath,
        expectedSha256,
        provenancePath,
        expectedProvenanceSha256,
        command,
      }),
      /did not match the candidate/u,
    );
    await assert.rejects(
      validateReleaseDeviceBinary({
        candidate: { source: { commit_sha: COMMIT } },
        binaryPath,
        expectedSha256,
        provenancePath,
        expectedProvenanceSha256,
        command: async () => ({
          stdout:
            `jetkvm_app: go1.25.1\n` +
            `\tbuild\t-ldflags="-X github.com/prometheus/common/version.Revision=${"d".repeat(40)}"\n`,
        }),
      }),
      /was not built from the frozen source commit/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stages the exact device artifact before reboot", async () => {
  const calls = [];
  const sha256 = "c".repeat(64);
  const sshModule = {
    kvmTarget: (host) => `root@${host}`,
    async runScp(source, destination) {
      calls.push(["scp", source, destination]);
      return {
        command: "scp",
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
      };
    },
    async runSshCommand(target, command) {
      calls.push(["ssh", target, command]);
      return {
        command: "ssh",
        stdout:
          command === "nohup sh -c 'sleep 1; reboot' >/dev/null 2>&1 &"
            ? ""
            : `${sha256}  /userdata/jetkvm/jetkvm_app.update\n`,
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
      };
    },
  };
  const evidence = await deployReleaseDeviceBinary({
    sshModule,
    host: "device.example",
    binaryPath: "/private/jetkvm_app",
    expectedSha256: sha256,
  });

  assert.deepEqual(calls, [
    [
      "scp",
      "/private/jetkvm_app",
      "root@device.example:/userdata/jetkvm/jetkvm_app.update",
    ],
    [
      "ssh",
      "root@device.example",
      "sha256sum /userdata/jetkvm/jetkvm_app.update",
    ],
    [
      "ssh",
      "root@device.example",
      "nohup sh -c 'sleep 1; reboot' >/dev/null 2>&1 &",
    ],
  ]);
  assert.equal(evidence.staged_binary_sha256, sha256);
});

async function fixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "jetkvm-live-source-"));
  const packageRoot = join(repositoryRoot, "tools", "jetkvm-mcp");
  const harnessRoot = join(repositoryRoot, "tools", "paste-harness", "dist");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(harnessRoot, { recursive: true });
  await writeFile(join(packageRoot, "package-lock.json"), "reviewed-lock\n");
  await writeFile(join(harnessRoot, "rig.js"), "export const rig = true;\n");
  const harness = await buildDirectoryManifest(harnessRoot);
  const candidate = {
    source: {
      commit_sha: COMMIT,
      tree_sha: TREE,
      package_lock: {
        sha256: await sha256File(join(packageRoot, "package-lock.json")),
      },
      paste_harness: { sha256: harness.sha256 },
    },
  };
  return { repositoryRoot, packageRoot, candidate };
}

function command(statuses = ["", ""]) {
  let statusIndex = 0;
  return async (_executable, args) => {
    if (args[0] === "status") {
      return { stdout: statuses[statusIndex++] ?? statuses.at(-1) ?? "" };
    }
    if (args.join(" ") === "rev-parse HEAD^{commit}") {
      return { stdout: `${COMMIT}\n` };
    }
    if (args.join(" ") === "rev-parse HEAD^{tree}") {
      return { stdout: `${TREE}\n` };
    }
    throw new Error(`Unexpected git command: ${args.join(" ")}`);
  };
}

test("accepts the exact clean frozen source and generated harness", async () => {
  const current = await fixture();
  try {
    const identity = await validateCurrentReleaseSource(current.candidate, {
      repositoryRoot: current.repositoryRoot,
      packageRoot: current.packageRoot,
      command: command(),
    });
    assert.equal(identity.commit_sha, COMMIT);
    assert.equal(identity.tree_sha, TREE);
    assert.equal(
      identity.package_lock_sha256,
      current.candidate.source.package_lock.sha256,
    );
  } finally {
    await rm(current.repositoryRoot, { recursive: true, force: true });
  }
});

test("fails closed on dirty, changed, or post-check source state", async () => {
  const current = await fixture();
  try {
    await assert.rejects(
      validateCurrentReleaseSource(current.candidate, {
        repositoryRoot: current.repositoryRoot,
        packageRoot: current.packageRoot,
        command: command([" M scripts/run-live-hardware-release.mjs\n"]),
      }),
      /source tree is dirty/u,
    );

    const changed = structuredClone(current.candidate);
    changed.source.tree_sha = "c".repeat(40);
    await assert.rejects(
      validateCurrentReleaseSource(changed, {
        repositoryRoot: current.repositoryRoot,
        packageRoot: current.packageRoot,
        command: command(),
      }),
      /identity drifted/u,
    );

    await assert.rejects(
      validateCurrentReleaseSource(current.candidate, {
        repositoryRoot: current.repositoryRoot,
        packageRoot: current.packageRoot,
        command: command(["", "?? unexpected\n"]),
      }),
      /identity drifted/u,
    );
  } finally {
    await rm(current.repositoryRoot, { recursive: true, force: true });
  }
});

test("starts the installed MCP in inherited leased mode", () => {
  const environment = {
    JETKVM_DEVICE_LEASE_PROOF_PATH: "/private/proof-reference.json",
  };
  const clientFactory = () => ({});
  const transportFactory = () => ({});
  const options = createInstalledMcpOptions({
    installedPackageRoot: "/private/installed/jetkvm-mcp",
    environment,
    sensitiveValues: ["sensitive"],
    sdkFactories: { clientFactory, transportFactory },
  });

  assert.deepEqual(options.args, [
    "/private/installed/jetkvm-mcp/dist/bin.js",
    "--leased",
  ]);
  assert.equal(
    options.environment.JETKVM_DEVICE_LEASE_PROOF_PATH,
    "/private/proof-reference.json",
  );
  assert.equal(options.clientFactory, clientFactory);
  assert.equal(options.transportFactory, transportFactory);
});

test("loads MCP SDK factories only from the installed candidate closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "jetkvm-installed-sdk-"));
  const installedPackageRoot = join(
    root,
    "node_modules",
    "@wyrmkeep",
    "jetkvm-mcp",
  );
  const sdkRoot = join(root, "node_modules", "@modelcontextprotocol", "sdk");
  try {
    await mkdir(installedPackageRoot, { recursive: true });
    await mkdir(join(sdkRoot, "client"), { recursive: true });
    await writeFile(
      join(installedPackageRoot, "package.json"),
      JSON.stringify({ name: "@wyrmkeep/jetkvm-mcp", type: "module" }),
    );
    await writeFile(
      join(sdkRoot, "package.json"),
      JSON.stringify({
        name: "@modelcontextprotocol/sdk",
        type: "module",
        exports: {
          "./client/index.js": "./client/index.js",
          "./client/stdio.js": "./client/stdio.js",
        },
      }),
    );
    await writeFile(
      join(sdkRoot, "client", "index.js"),
      "export class Client { constructor(options) { this.options = options; } }\n",
    );
    await writeFile(
      join(sdkRoot, "client", "stdio.js"),
      "export class StdioClientTransport { constructor(options) { this.options = options; } }\n",
    );

    const factories = await loadInstalledMcpSdkFactories(installedPackageRoot);
    assert.deepEqual(factories.clientFactory().options, {
      name: "jetkvm-release-hardware",
      version: "1.0.0",
    });
    assert.deepEqual(factories.transportFactory({ command: "node" }).options, {
      command: "node",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains manual-recovery classification when evidence persistence fails", () => {
  const restoreFailure = new Error("restore failed");
  const persistenceFailure = new Error("disk full");
  const error = createFinalizationError(
    {
      failures: [restoreFailure],
      record: { manual_recovery_required: true },
    },
    persistenceFailure,
  );
  assert.equal(error.name, "ManualRecoveryRequiredError");
  assert.deepEqual(error.errors, [restoreFailure, persistenceFailure]);
});

test("requires a post-action physical power fact before treating SSH failure as offline", async () => {
  let online = false;
  const rig = createRigAdapter(
    {},
    {
      windowsTarget: () => "root@fixture",
      runSshCommand: async () => ({ exitCode: online ? 0 : 255 }),
      runPowerShell: async () => ({
        exitCode: 0,
        stdout: "2026-07-14T00:00:00.000Z\n",
      }),
    },
    {},
    { WIN_TARGET: "fixture" },
  );
  assert.equal(await rig.hostPowerState(), "unknown");
  await assert.rejects(
    rig.waitForHostOffline({
      started_at: Date.parse("2026-07-14T00:00:01.000Z"),
      atx_led_observation: {
        power: false,
        freshness: "stale",
        observed_at: "2026-07-14T00:00:00.000Z",
      },
    }),
    /lacked a post-action ATX power LED observation/u,
  );
  await rig.waitForHostOffline({
    started_at: Date.parse("2026-07-14T00:00:01.000Z"),
    atx_led_observation: {
      power: false,
      freshness: "stale",
      observed_at: "2026-07-14T00:00:02.000Z",
    },
  });
  assert.equal(await rig.hostPowerState(), "offline");
  online = true;
  await rig.waitForHostOnline();
  assert.equal(await rig.hostPowerState(), "online");
});

test("rechecks the installed package against the frozen candidate directory", async () => {
  assert.equal(
    typeof liveReleaseModule.verifyReplacementPackageIdentity,
    "function",
  );
  const calls = [];
  const identity = { package_tree_sha256: "tree" };
  await liveReleaseModule.verifyReplacementPackageIdentity({
    candidate: { package: { name: "fixture" } },
    installedPackageRoot: "/installed/package",
    candidatePath: "/candidate/candidate.json",
    initialIdentity: identity,
    verify: async (...args) => {
      calls.push(args);
      return { ...identity };
    },
  });
  assert.deepEqual(calls, [
    [
      { package: { name: "fixture" } },
      "/installed/package",
      { candidateDirectory: "/candidate" },
    ],
  ]);
});
