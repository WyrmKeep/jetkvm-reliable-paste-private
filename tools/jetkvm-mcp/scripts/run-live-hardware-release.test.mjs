import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONTROLLED_TRACE_REPORT_PATHS } from "./build-controlled-release-evidence.mjs";
import * as liveReleaseModule from "./run-live-hardware-release.mjs";
import { createDeviceReleaseProvenance } from "./device-release-provenance.mjs";
import {
  buildDirectoryManifest,
  sha256Canonical,
  sha256File,
} from "./release-evidence.mjs";
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

test("selects ATX preflight only from the frozen hardware profile", async () => {
  const stories = [
    {
      id: "mixed-story",
      environments: ["live"],
      steps: [{ id: "safe-step" }, { id: "physical-atx-step" }],
      restore: [{ id: "restore", always: true }],
    },
  ];
  const plan = {
    "mixed-story": {
      steps: {
        "safe-step": {
          mode: "hardware",
          requires_atx_wiring: false,
        },
        "physical-atx-step": {
          mode: "hardware",
          requires_atx_wiring: true,
        },
      },
    },
  };
  let preflightCalls = 0;
  const driver = {
    proveAtx: async () => {
      preflightCalls += 1;
      return { evidence_sha256: "a".repeat(64) };
    },
  };
  const full = await liveReleaseModule.prepareHardwareValidationRun({
    stories,
    plan,
    driver,
    hardwareValidation: { profile: "full", exception_code: null },
  });
  assert.equal(preflightCalls, 1);
  assert.equal(full.hardwareException, null);
  assert.equal(full.atxPreflight.evidence_sha256, "a".repeat(64));

  const unavailable = await liveReleaseModule.prepareHardwareValidationRun({
    stories,
    plan,
    driver,
    hardwareValidation: {
      profile: "atx_unavailable",
      exception_code: "ATX_WIRING_UNAVAILABLE",
    },
  });
  assert.equal(preflightCalls, 1);
  assert.equal(unavailable.atxPreflight, null);
  assert.equal(unavailable.hardwareException.excluded_step_count, 1);

  assert.deepEqual(
    liveReleaseModule.buildHardwareValidationSummary({
      hardwareValidation: unavailable.hardwareValidation,
      hardwareException: unavailable.hardwareException,
      atxPreflight: unavailable.atxPreflight,
      records: [
        {
          result: "pass_with_exception",
          steps: [{ result: "pass" }, { result: "excluded" }],
        },
      ],
    }),
    {
      hardware_validation: {
        profile: "atx_unavailable",
        exception_code: "ATX_WIRING_UNAVAILABLE",
      },
      result: "pass_with_exception",
      story_count: 1,
      step_count: 2,
      executed_step_count: 1,
      excluded_step_count: 1,
      hardware_exception_sha256: sha256Canonical(unavailable.hardwareException),
      atx_preflight_sha256: null,
    },
  );
});

test("loads every frozen controlled trace family", () => {
  assert.deepEqual(CONTROLLED_TRACE_REPORT_PATHS, [
    "reports/controlled-traces/input-display.json",
    "reports/controlled-traces/power-session.json",
    "reports/controlled-traces/transport-session.json",
  ]);
});

test("binds a device artifact to its unique embedded source revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jetkvm-device-binary-"));
  const binaryPath = join(directory, "jetkvm_app");
  const deviceTestsPath = join(directory, "device-tests.tar.gz");
  const provenancePath = join(directory, "device-binary-provenance.json");
  const goReport = ({ goos = "linux", goarch = "arm", goarm = "7" } = {}) =>
    `jetkvm_app: go1.25.1\n` +
    `\tpath\tcommand-line-arguments\n` +
    `\tbuild\tGOARCH=${goarch}\n` +
    `\tbuild\tGOOS=${goos}\n` +
    `\tbuild\tGOARM=${goarm}\n`;
  const command = async () => ({ stdout: goReport() });
  const writeArtifact = async (contents) => {
    await writeFile(binaryPath, contents);
    await writeFile(deviceTestsPath, "device-tests");
    const expectedSha256 = await sha256File(binaryPath);
    const provenance = await createDeviceReleaseProvenance({
      binaryPath,
      deviceTestsPath,
      sourceCommit: COMMIT,
      repository: "WyrmKeep/jetkvm-reliable-paste-private",
      workflowRef:
        "WyrmKeep/jetkvm-reliable-paste-private/.github/workflows/build.yml@refs/heads/release",
      runId: "123456",
      runAttempt: 1,
    });
    await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`);
    return {
      expectedSha256,
      expectedDeviceTestsSha256: await sha256File(deviceTestsPath),
      expectedProvenanceSha256: await sha256File(provenancePath),
    };
  };
  try {
    const exact = await writeArtifact(`device-binary\0${COMMIT}\0`);
    const evidence = await validateReleaseDeviceBinary({
      candidate: { source: { commit_sha: COMMIT } },
      binaryPath,
      deviceTestsPath,
      ...exact,
      command,
      provenancePath,
    });
    assert.equal(evidence.sha256, exact.expectedSha256);
    assert.equal(evidence.device_tests_sha256, exact.expectedDeviceTestsSha256);
    assert.equal(evidence.source_commit, COMMIT);

    for (const settings of [
      { goos: "darwin" },
      { goarch: "amd64" },
      { goarm: "6" },
    ]) {
      await assert.rejects(
        validateReleaseDeviceBinary({
          candidate: { source: { commit_sha: COMMIT } },
          binaryPath,
          deviceTestsPath,
          ...exact,
          command: async () => ({ stdout: goReport(settings) }),
          provenancePath,
        }),
        /target linux\/arm\/7/u,
      );
    }

    await assert.rejects(
      validateReleaseDeviceBinary({
        candidate: { source: { commit_sha: "b".repeat(40) } },
        binaryPath,
        deviceTestsPath,
        ...exact,
        provenancePath,
        command,
      }),
      /did not match the candidate/u,
    );

    const wrong = await writeArtifact(`device-binary\0${"d".repeat(40)}\0`);
    await assert.rejects(
      validateReleaseDeviceBinary({
        candidate: { source: { commit_sha: COMMIT } },
        binaryPath,
        deviceTestsPath,
        ...wrong,
        provenancePath,
        command,
      }),
      /was not built from the frozen source commit/u,
    );

    const duplicate = await writeArtifact(
      `device-binary\0${COMMIT}\0${COMMIT}\0`,
    );
    await assert.rejects(
      validateReleaseDeviceBinary({
        candidate: { source: { commit_sha: COMMIT } },
        binaryPath,
        deviceTestsPath,
        ...duplicate,
        provenancePath,
        command,
      }),
      /was not built from the frozen source commit/u,
    );

    const testBound = await writeArtifact(`device-binary\0${COMMIT}\0`);
    await writeFile(deviceTestsPath, "changed-device-tests");
    await assert.rejects(
      validateReleaseDeviceBinary({
        candidate: { source: { commit_sha: COMMIT } },
        binaryPath,
        deviceTestsPath,
        ...testBound,
        provenancePath,
        command,
      }),
      /checksum did not match/u,
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
    async runSshCommand(target, command, options) {
      calls.push(["ssh", target, command, options]);
      return {
        command: "ssh",
        stdout:
          command === "sha256sum /userdata/jetkvm/jetkvm_app.update"
            ? `${sha256}  /userdata/jetkvm/jetkvm_app.update\n`
            : "",
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

  assert.equal(calls.length, 3);
  const [upload, staged, reboot] = calls;
  assert.equal(upload[0], "ssh");
  assert.equal(upload[1], "root@device.example");
  assert.match(
    upload[2],
    /cat > \/userdata\/jetkvm\/jetkvm_app\.update\.upload/u,
  );
  assert.match(upload[2], /sha256sum -c -/u);
  assert.match(
    upload[2],
    /mv -f \/userdata\/jetkvm\/jetkvm_app\.update\.upload \/userdata\/jetkvm\/jetkvm_app\.update/u,
  );
  assert.match(upload[2], new RegExp(sha256, "u"));
  assert.deepEqual(upload[3], {
    timeoutMs: 60_000,
    inputFile: "/private/jetkvm_app",
  });
  assert.deepEqual(staged, [
    "ssh",
    "root@device.example",
    "sha256sum /userdata/jetkvm/jetkvm_app.update",
    { timeoutMs: 30_000 },
  ]);
  assert.deepEqual(reboot, [
    "ssh",
    "root@device.example",
    "nohup sh -c 'sleep 1; reboot' >/dev/null 2>&1 &",
    { timeoutMs: 30_000 },
  ]);
  assert.equal(evidence.staged_binary_sha256, sha256);
});

test("removes staged device updates after verification or reboot failure", async () => {
  const sha256 = "c".repeat(64);
  for (const failureIndex of [1, 2]) {
    const calls = [];
    const sshModule = {
      kvmTarget: (host) => `root@${host}`,
      async runSshCommand(target, command, options) {
        const index = calls.length;
        calls.push([target, command, options]);
        return {
          command: "ssh",
          stdout:
            command === "sha256sum /userdata/jetkvm/jetkvm_app.update"
              ? `${sha256}  /userdata/jetkvm/jetkvm_app.update\n`
              : "",
          stderr: index === failureIndex ? "failed" : "",
          exitCode: index === failureIndex ? 1 : 0,
          signal: null,
          timedOut: false,
        };
      },
    };
    await assert.rejects(
      deployReleaseDeviceBinary({
        sshModule,
        host: "device.example",
        binaryPath: "/private/jetkvm_app",
        expectedSha256: sha256,
      }),
    );
    const cleanup = calls.at(-1);
    assert.match(
      cleanup[1],
      /rm -f \/userdata\/jetkvm\/jetkvm_app\.update \/userdata\/jetkvm\/jetkvm_app\.update\.upload/u,
    );
    assert.match(
      cleanup[1],
      /test ! -e \/userdata\/jetkvm\/jetkvm_app\.update/u,
    );
    assert.deepEqual(cleanup[2], { timeoutMs: 30_000 });
  }
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
  assert.equal(rig.consumeConfirmedOffline(), true);
  assert.equal(await rig.hostPowerState(), "unknown");
  assert.equal(rig.consumeConfirmedOffline(), false);
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

test("invalidates the safe baseline when final device identity is unproven", async () => {
  let invalidated = false;
  await assert.rejects(
    liveReleaseModule.verifyFinalDeviceIntegrity({
      deployedIdentity: {
        revision: COMMIT,
        appVersion: "0.5.5",
        processStartTime: "1000",
      },
      deviceBinaryPath: "/reviewed/jetkvm_app",
      deploymentEvidence: {
        local_binary_sha256: "d".repeat(64),
        installed_binary_sha256: "d".repeat(64),
      },
      metricsUrl: "http://device.example/metrics",
      sshModule: {},
      target: "device.example",
      invalidateSafeBaseline: () => {
        invalidated = true;
      },
      readIdentity: async () => ({
        revision: "e".repeat(40),
        appVersion: "0.5.5",
        processStartTime: "2000",
      }),
    }),
    /Device identity drifted/u,
  );
  assert.equal(invalidated, true);
});

test("invalidates the safe baseline when the installed binary is unproven", async () => {
  const identity = {
    revision: COMMIT,
    appVersion: "0.5.5",
    processStartTime: "1000",
  };
  let invalidated = false;
  await assert.rejects(
    liveReleaseModule.verifyFinalDeviceIntegrity({
      deployedIdentity: identity,
      deviceBinaryPath: "/reviewed/jetkvm_app",
      deploymentEvidence: {
        local_binary_sha256: "d".repeat(64),
        installed_binary_sha256: "d".repeat(64),
      },
      metricsUrl: "http://device.example/metrics",
      sshModule: {
        kvmTarget: (target) => target,
        runSshCommand: async () => ({
          command: "ssh",
          stdout: `${"e".repeat(64)}  /userdata/jetkvm/bin/jetkvm_app\n`,
          stderr: "",
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
      },
      target: "device.example",
      invalidateSafeBaseline: () => {
        invalidated = true;
      },
      readIdentity: async () => identity,
      hashFile: async () => "d".repeat(64),
    }),
    /Device deployment bytes drifted/u,
  );
  assert.equal(invalidated, true);
});

test("loads paste-harness modules only from the frozen candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "jetkvm-frozen-harness-"));
  const harnessRoot = join(root, "paste-harness");
  try {
    await mkdir(harnessRoot);
    for (const name of ["rig", "ssh", "normalize"]) {
      await writeFile(
        join(harnessRoot, `${name}.js`),
        `export const ${name} = true;\n`,
      );
    }
    const manifest = await buildDirectoryManifest(harnessRoot);
    const imported = [];
    const operations = [];
    const modules = await liveReleaseModule.loadFrozenPasteHarness({
      candidate: {
        source: { paste_harness: { sha256: manifest.sha256 } },
      },
      candidatePath: join(root, "candidate.json"),
      validateFiles: async () => {
        operations.push("validate");
      },
      importModule: async (path) => {
        imported.push(path);
        operations.push("import");
        return { path };
      },
    });
    assert.deepEqual(operations, ["validate", "import", "import", "import"]);
    assert.deepEqual(imported, [
      join(modules.root, "rig.js"),
      join(modules.root, "ssh.js"),
      join(modules.root, "normalize.js"),
    ]);
    assert.equal(modules.rig.path, imported[0]);
    assert.equal(modules.ssh.path, imported[1]);
    assert.equal(modules.normalize.path, imported[2]);

    await writeFile(join(harnessRoot, "rig.js"), "drifted\n");
    await assert.rejects(
      liveReleaseModule.loadFrozenPasteHarness({
        candidate: {
          source: { paste_harness: { sha256: manifest.sha256 } },
        },
        candidatePath: join(root, "candidate.json"),
        importModule: async () => ({}),
        validateFiles: async () => undefined,
      }),
      /Frozen paste-harness runtime drifted/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconnects on a fresh MCP transport and proves producer-zero release", async () => {
  const events = [];
  const requests = [];
  const requestIds = ["fresh-connect-request", "fresh-release-request"];
  const connectRaw = {
    ok: true,
    tool: "jetkvm_session_connect",
    session_id: "fresh-session",
    session_generation: 9,
    result: {
      request_id: requestIds[0],
      outcome: "applied",
      verification: "device_state_verified",
      safe_to_retry: false,
      required_next_step: "none",
      state: "ready",
    },
  };
  const releaseRaw = {
    ok: true,
    tool: "jetkvm_input_release",
    session_id: "fresh-session",
    session_generation: 9,
    result: {
      request_id: requestIds[1],
      outcome: "applied",
      verification: "device_state_verified",
      safe_to_retry: false,
      required_next_step: "none",
      mutation_gate_closed: true,
      deferred_producers_joined: true,
      paste_terminal: "inactive",
      ordinary_leases_zero: true,
      keyboard_zero: true,
      pointer_zero: true,
      generation_drained: true,
    },
  };
  const response = (raw) => {
    const structured = structuredClone(raw);
    delete structured.session_id;
    delete structured.result.request_id;
    return {
      raw,
      evidence: {
        structured,
        structured_sha256: sha256Canonical(structured),
      },
    };
  };
  let invalidated = false;
  const proof = await liveReleaseModule.proveFreshTransportRelease({
    initialClient: {
      async close() {
        events.push("initial:close");
        return true;
      },
    },
    replacementClient: {
      async start() {
        events.push("replacement:start");
        return {
          tool_names_sha256: "d".repeat(64),
          tool_count: 10,
        };
      },
      async call(name, input, timeoutMs) {
        events.push(name);
        requests.push({ name, input, timeoutMs });
        return response(
          name === "jetkvm_session_connect" ? connectRaw : releaseRaw,
        );
      },
    },
    invalidateSafeBaseline() {
      invalidated = true;
    },
    nextRequestId: () => requestIds.shift(),
  });

  assert.deepEqual(events, [
    "initial:close",
    "replacement:start",
    "jetkvm_session_connect",
    "jetkvm_input_release",
  ]);
  assert.deepEqual(requests, [
    {
      name: "jetkvm_session_connect",
      input: {
        request_id: "fresh-connect-request",
        takeover: false,
        timeout_ms: 60_000,
      },
      timeoutMs: 65_000,
    },
    {
      name: "jetkvm_input_release",
      input: {
        session_id: "fresh-session",
        session_generation: 9,
        request_id: "fresh-release-request",
        timeout_ms: 30_000,
      },
      timeoutMs: 35_000,
    },
  ]);
  assert.equal(invalidated, false);
  assert.equal(proof.tool_listing.tool_count, 10);
  assert.equal(Object.hasOwn(proof.connect.request, "request_id"), false);
  assert.equal(
    proof.connect.request.request_id_sha256,
    sha256Canonical("fresh-connect-request"),
  );
  assert.equal(Object.hasOwn(proof.release.request, "session_id"), false);
  assert.equal(
    proof.release.request.session_id_sha256,
    sha256Canonical("fresh-session"),
  );
  assert.equal(
    proof.connect.correlation_sha256,
    sha256Canonical(proof.connect.correlation),
  );
  assert.equal(
    proof.release.correlation_sha256,
    sha256Canonical(proof.release.correlation),
  );
  assert.equal(
    Object.hasOwn(proof.connect.response.structured, "session_id"),
    false,
  );
  assert.equal(
    Object.hasOwn(proof.release.response.structured.result, "request_id"),
    false,
  );
  assert.equal(
    proof.connect.request_sha256,
    sha256Canonical(proof.connect.request),
  );
  assert.equal(
    proof.connect.response_sha256,
    sha256Canonical(proof.connect.response),
  );
  assert.equal(
    proof.release.request_sha256,
    sha256Canonical(proof.release.request),
  );
  assert.equal(
    proof.release.response_sha256,
    sha256Canonical(proof.release.response),
  );
});

test("invalidates the safe baseline when fresh release is unproven", async () => {
  const requestIds = ["fresh-connect-request", "fresh-release-request"];
  const response = (raw) => {
    const structured = structuredClone(raw);
    delete structured.session_id;
    delete structured.result.request_id;
    return {
      raw,
      evidence: {
        structured,
        structured_sha256: sha256Canonical(structured),
      },
    };
  };
  let invalidated = false;
  await assert.rejects(
    liveReleaseModule.proveFreshTransportRelease({
      initialClient: { close: async () => true },
      replacementClient: {
        start: async () => ({
          tool_names_sha256: "d".repeat(64),
          tool_count: 10,
        }),
        async call(name) {
          if (name === "jetkvm_session_connect") {
            return response({
              ok: true,
              tool: name,
              session_id: "fresh-session",
              session_generation: 9,
              result: {
                request_id: "fresh-connect-request",
                outcome: "applied",
                verification: "device_state_verified",
                safe_to_retry: false,
                required_next_step: "none",
                state: "ready",
              },
            });
          }
          return response({
            ok: true,
            tool: name,
            session_id: "fresh-session",
            session_generation: 9,
            result: {
              request_id: "fresh-release-request",
              outcome: "applied",
              verification: "device_state_verified",
              safe_to_retry: false,
              required_next_step: "none",
              mutation_gate_closed: true,
              deferred_producers_joined: true,
              paste_terminal: "inactive",
              ordinary_leases_zero: true,
              keyboard_zero: true,
              pointer_zero: false,
              generation_drained: true,
            },
          });
        },
      },
      invalidateSafeBaseline: () => {
        invalidated = true;
      },
      nextRequestId: () => requestIds.shift(),
    }),
    /Authoritative input release/u,
  );
  assert.equal(invalidated, true);
});
