import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  open,
  realpath,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateControlledReleaseEvidence } from "./build-controlled-release-evidence.mjs";
import {
  InstalledMcpClient,
  assertPrivateEnvironmentFile,
  createLiveHardwareDriver,
  finalizeLiveHardwareResources,
  verifyInstalledPackageIdentity,
} from "./hardware-release-driver.mjs";
import { materializeLiveExecutionPlan } from "./live-story-plan.mjs";
import {
  runCanonicalLiveStories,
  runWithFinalization,
} from "./live-release-core.mjs";
import {
  assertCurrentRuntimeMatchesCandidate,
  buildDirectoryManifest,
  createExecutionEvidenceResolver,
  sha256Canonical,
  sha256File,
  validateReleaseCandidateManifest,
} from "./release-evidence.mjs";
import {
  parseDeviceIdentity,
  runDeviceGoTests,
  validateDeviceGoTestEvidence,
} from "./run-device-go-tests.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const COMMAND_OUTPUT_LIMIT = 16 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15 * 60_000;

class ManualRecoveryRequiredError extends AggregateError {
  constructor(errors) {
    super(errors, "Manual device recovery is required before lease release.");
    this.name = "ManualRecoveryRequiredError";
  }
}

function requiresManualRecovery(error) {
  if (error instanceof ManualRecoveryRequiredError) return true;
  return (
    error instanceof AggregateError &&
    error.errors.some((nested) => requiresManualRecovery(nested))
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required release environment ${name}.`);
  }
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function runCommand(
  command,
  args,
  { cwd = REPOSITORY_ROOT, timeoutMs = COMMAND_TIMEOUT_MS } = {},
) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let byteLength = 0;
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const append = (target, chunk) => {
      byteLength += chunk.byteLength;
      if (byteLength > COMMAND_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        finish(() =>
          rejectRun(
            new Error("Hardware release command output exceeded its bound."),
          ),
        );
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.once("error", (error) => finish(() => rejectRun(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        const out = Buffer.concat(stdout);
        const err = Buffer.concat(stderr);
        if (code !== 0 || signal !== null) {
          rejectRun(new Error("Hardware release command failed."));
          return;
        }
        resolveRun(
          Object.freeze({
            stdout: out.toString("utf8"),
            evidence: Object.freeze({
              exit_code: code,
              stdout_bytes: out.byteLength,
              stdout_sha256: sha256Text(out),
              stderr_bytes: err.byteLength,
              stderr_sha256: sha256Text(err),
            }),
          }),
        );
      });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        rejectRun(new Error("Hardware release command exceeded its deadline.")),
      );
    }, timeoutMs);
  });
}
export async function validateCurrentReleaseSource(
  candidate,
  {
    repositoryRoot = REPOSITORY_ROOT,
    packageRoot = PACKAGE_ROOT,
    command = runCommand,
  } = {},
) {
  const git = async (args) =>
    (await command("git", args, { cwd: repositoryRoot })).stdout.trim();
  const statusBefore = await git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (statusBefore.length !== 0) {
    throw new Error("Release source tree is dirty.");
  }
  const [commit, tree, packageLockSha256, pasteHarness] = await Promise.all([
    git(["rev-parse", "HEAD^{commit}"]),
    git(["rev-parse", "HEAD^{tree}"]),
    sha256File(resolve(packageRoot, "package-lock.json")),
    buildDirectoryManifest(resolve(repositoryRoot, "tools/paste-harness/dist")),
  ]);
  const statusAfter = await git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (
    statusAfter.length !== 0 ||
    commit !== candidate.source.commit_sha ||
    tree !== candidate.source.tree_sha ||
    packageLockSha256 !== candidate.source.package_lock.sha256 ||
    pasteHarness.sha256 !== candidate.source.paste_harness.sha256
  ) {
    throw new Error("Release source identity drifted from the candidate.");
  }
  return Object.freeze({
    commit_sha: commit,
    tree_sha: tree,
    package_lock_sha256: packageLockSha256,
    paste_harness_sha256: pasteHarness.sha256,
  });
}
export async function loadInstalledMcpSdkFactories(installedPackageRoot) {
  const requireFromCandidate = createRequire(
    resolve(installedPackageRoot, "package.json"),
  );
  const expectedSdkRoot = await realpath(
    resolve(installedPackageRoot, "../../@modelcontextprotocol/sdk"),
  );
  const [clientPath, transportPath] = await Promise.all([
    realpath(
      requireFromCandidate.resolve("@modelcontextprotocol/sdk/client/index.js"),
    ),
    realpath(
      requireFromCandidate.resolve("@modelcontextprotocol/sdk/client/stdio.js"),
    ),
  ]);
  for (const path of [clientPath, transportPath]) {
    if (!path.startsWith(`${expectedSdkRoot}${sep}`)) {
      throw new Error("Installed MCP SDK resolved outside the frozen closure.");
    }
  }
  const [clientModule, transportModule] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(transportPath).href),
  ]);
  return Object.freeze({
    clientFactory: () =>
      new clientModule.Client({
        name: "jetkvm-release-hardware",
        version: "1.0.0",
      }),
    transportFactory: (options) =>
      new transportModule.StdioClientTransport(options),
  });
}

async function writeAndFlush(path, value) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeTextAndFlush(path, value) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readDeviceIdentity(metricsUrl) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(metricsUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        throw new Error("Metrics endpoint rejected the request.");
      return parseDeviceIdentity(await response.text());
    } catch (error) {
      lastError = error;
      await delay(2_000);
    }
  }
  throw lastError ?? new Error("Device identity was unavailable.");
}

function sameDeviceIdentity(left, right) {
  return (
    left.revision === right.revision &&
    left.version === right.version &&
    left.processStartTimeSeconds === right.processStartTimeSeconds
  );
}

function createRigAdapter(rigModule, sshModule, normalizeModule, rigEnv) {
  let lastLayout;
  let lastBootIdentity;
  const target = sshModule.windowsTarget(rigEnv);

  async function shellOnline() {
    const result = await sshModule.runSshCommand(target, "echo ready", {
      timeoutMs: 5_000,
    });
    return result.exitCode === 0;
  }

  async function bootIdentity() {
    const result = await sshModule.runPowerShell(
      target,
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
      { timeoutMs: 15_000 },
    );
    if (result.exitCode !== 0)
      throw new Error("Could not read Windows boot identity.");
    return result.stdout.trim();
  }

  async function waitUntil(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(2_000);
    }
    throw new Error(message);
  }

  return Object.freeze({
    async initialize() {
      lastBootIdentity = await bootIdentity();
    },
    async install() {
      const installed = await rigModule.installNucBoxRigScripts(rigEnv);
      return Object.freeze({
        uploaded_count: installed.uploaded.length,
        registered_task_count: installed.registeredTasks.length,
        fixture_sha256: sha256Canonical(
          rigModule.makeNucBoxRigScripts(rigEnv.WIN_RECV),
        ),
      });
    },
    isHostOnline: shellOnline,
    async waitForHostOnline() {
      await waitUntil(
        shellOnline,
        240_000,
        "Windows host did not return online.",
      );
      lastBootIdentity = await bootIdentity();
    },
    async waitForHostOffline() {
      await waitUntil(
        async () => !(await shellOnline()),
        90_000,
        "Windows host did not power off.",
      );
    },
    async waitForHostRestart() {
      const previous = lastBootIdentity;
      await waitUntil(
        async () => {
          if (!(await shellOnline())) return true;
          const current = await bootIdentity();
          return previous !== undefined && current !== previous;
        },
        90_000,
        "Windows host did not begin restarting.",
      );
      await waitUntil(
        shellOnline,
        240_000,
        "Windows host did not recover after restart.",
      );
      lastBootIdentity = await bootIdentity();
    },
    async pinUkLayout() {
      const result = await rigModule.pinUkLayout(rigEnv);
      if (result.ok !== true || result.preload?.["1"] !== "00000809") {
        throw new Error("Windows UK keyboard layout pin failed.");
      }
      lastLayout = Object.freeze({ preload: "00000809" });
      return lastLayout;
    },
    async resetNotepad() {
      const result = await rigModule.resetNotepad(rigEnv);
      if (result.ok !== true) throw new Error("Notepad fixture reset failed.");
      return result;
    },
    async captureSafeBaselineFacts() {
      const probe = await rigModule.runForegroundProbe(rigEnv);
      if (
        probe.ok !== true ||
        probe.lockKeys === undefined ||
        lastLayout === undefined
      ) {
        throw new Error("Windows fixture baseline probe failed.");
      }
      return Object.freeze({
        layout: lastLayout,
        lock_keys: Object.freeze({
          caps_lock: probe.lockKeys.capsLock,
          num_lock: probe.lockKeys.numLock,
          scroll_lock: probe.lockKeys.scrollLock,
        }),
        fixture: Object.freeze({
          sha256: sha256Canonical(
            rigModule.makeNucBoxRigScripts(rigEnv.WIN_RECV),
          ),
          foreground_ready: true,
        }),
        host_online: await shellOnline(),
      });
    },
    async waitForSave(startedAt) {
      await waitUntil(
        async () => {
          const result = await rigModule.checkSaveLanded(startedAt, rigEnv);
          return result.ok === true && result.saveLanded === true;
        },
        30_000,
        "Notepad save did not land.",
      );
    },
    readRecvSnapshot: () => rigModule.readRecvSnapshot(rigEnv),
    compareText: normalizeModule.compareNormalizedText,
  });
}

async function validateCandidateRuntime(
  candidate,
  candidatePath,
  browserPath,
  targetUrl,
) {
  await assertCurrentRuntimeMatchesCandidate(candidate, {
    nodeVersion: process.version,
    nodeExecutablePath: process.execPath,
    platform: process.platform,
    architecture: process.arch,
    browserExecutablePath: browserPath,
    targetUrl,
  });
  const expectedChecksum = requiredEnvironment(
    "JETKVM_RELEASE_CANDIDATE_SHA256",
  );
  if ((await sha256File(candidatePath)) !== expectedChecksum) {
    throw new Error("Candidate manifest checksum changed after freeze.");
  }
  if (
    (await sha256File(
      resolve(dirname(candidatePath), candidate.artifact.filename),
    )) !== candidate.artifact.sha256
  ) {
    throw new Error("Candidate package artifact changed after freeze.");
  }
}

async function reconnectTransportProof(options, state) {
  await options.mcp.close();
  const replacement = new InstalledMcpClient(options.mcpOptions);
  const listed = await replacement.start();
  const connect = await replacement.call(
    "jetkvm_session_connect",
    {
      request_id: `req-${sha256Text(`${options.runId}:transport-reconnect`).slice(0, 32)}`,
      takeover: false,
      timeout_ms: 30_000,
    },
    30_000,
  );
  if (connect.raw?.ok !== true) {
    await replacement.close();
    throw new Error(
      "Fresh stdio transport could not establish a fresh device session.",
    );
  }
  const release = await replacement.call(
    "jetkvm_input_release",
    {
      session_id: connect.raw.session_id,
      session_generation: connect.raw.session_generation,
      request_id: `req-${sha256Text(`${options.runId}:transport-release`).slice(0, 32)}`,
      timeout_ms: 30_000,
    },
    30_000,
  );
  if (release.raw?.ok !== true) {
    await replacement.close();
    throw new Error("Fresh stdio transport could not release input.");
  }
  state.replacementMcp = replacement;
  return Object.freeze({
    listed,
    connect: connect.evidence,
    release: release.evidence,
  });
}

async function run() {
  const candidatePath = resolve(
    requiredEnvironment("JETKVM_RELEASE_CANDIDATE"),
  );
  const candidate = validateReleaseCandidateManifest(
    await readJson(candidatePath),
  );
  const outputDirectory = resolve(
    requiredEnvironment("JETKVM_RELEASE_EVIDENCE_DIR"),
  );
  const installedPackageRoot = resolve(
    requiredEnvironment("JETKVM_RELEASE_INSTALLED_PACKAGE"),
  );
  const browserPath = resolve(
    requiredEnvironment("JETKVM_RELEASE_BROWSER_EXECUTABLE_PATH"),
  );
  const rigEnvPath = resolve(requiredEnvironment("JETKVM_RELEASE_RIG_ENV"));
  const rigEnvFacts = await stat(rigEnvPath);
  assertPrivateEnvironmentFile(rigEnvFacts, rigEnvPath);
  const sourceIdentity = await validateCurrentReleaseSource(candidate);

  const [rigModule, sshModule, normalizeModule] = await Promise.all([
    import(resolve(REPOSITORY_ROOT, "tools/paste-harness/dist/rig.js")),
    import(resolve(REPOSITORY_ROOT, "tools/paste-harness/dist/ssh.js")),
    import(resolve(REPOSITORY_ROOT, "tools/paste-harness/dist/normalize.js")),
  ]);
  const rigEnv = await sshModule.loadRigEnv(rigEnvPath);
  if (
    typeof rigEnv.JETKVM_PASSWORD !== "string" ||
    rigEnv.JETKVM_PASSWORD.length === 0
  ) {
    throw new Error("Protected rig environment omitted the JetKVM credential.");
  }
  const targetUrl = `http://${rigEnv.KVM_PRIMARY}`;
  await validateCandidateRuntime(
    candidate,
    candidatePath,
    browserPath,
    targetUrl,
  );
  const packageIdentity = await verifyInstalledPackageIdentity(
    candidate,
    installedPackageRoot,
    { candidateDirectory: dirname(candidatePath) },
  );
  const [manifestModule, mcpSdkFactories] = await Promise.all([
    import(resolve(installedPackageRoot, "dist/stories/manifest.js")),
    loadInstalledMcpSdkFactories(installedPackageRoot),
  ]);
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });

  const branchMatrix = await readJson(
    resolve(PACKAGE_ROOT, "reports/branch-matrix.json"),
  );
  const storyE2e = await readJson(
    resolve(PACKAGE_ROOT, "reports/story-e2e.json"),
  );
  if (
    (await sha256File(resolve(PACKAGE_ROOT, "reports/branch-matrix.json"))) !==
      candidate.source.branch_matrix_sha256 ||
    (await sha256File(resolve(PACKAGE_ROOT, "reports/story-e2e.json"))) !==
      candidate.source.story_e2e_sha256
  ) {
    throw new Error(
      "Execution-produced reports drifted from the frozen candidate.",
    );
  }
  const controlledEvidencePath = resolve(
    requiredEnvironment("JETKVM_RELEASE_CONTROLLED_EVIDENCE"),
  );
  const controlledEvidenceInput = await readJson(controlledEvidencePath);
  const executionResolver = createExecutionEvidenceResolver({
    branchMatrix,
    storyE2e,
  });
  const stories = await manifestModule.loadAcceptanceStories(
    resolve(installedPackageRoot, "dist/stories"),
  );
  const plan = materializeLiveExecutionPlan(stories, executionResolver);
  if (
    (await sha256File(controlledEvidencePath)) !==
    candidate.source.controlled_evidence_sha256
  ) {
    throw new Error(
      "Controlled release evidence drifted from the frozen candidate.",
    );
  }
  const controlledExecution = validateControlledReleaseEvidence({
    evidence: controlledEvidenceInput,
    stories,
    plan,
    branchMatrix,
    storyE2e,
  });
  const runId = `hw-${randomUUID()}`;
  const rig = createRigAdapter(rigModule, sshModule, normalizeModule, rigEnv);
  const metricsUrl = `${targetUrl}/metrics`;
  const mcpEnvironment = {
    ...process.env,
    JETKVM_TARGET_URL: targetUrl,
    JETKVM_CREDENTIAL: rigEnv.JETKVM_PASSWORD,
    JETKVM_HEADLESS: "false",
    JETKVM_CHROMIUM_EXECUTABLE_PATH: browserPath,
    JETKVM_ALLOW_INSECURE_HTTP: "true",
    JETKVM_ALLOW_DANGEROUS_TARGET_HTTP: "true",
    JETKVM_CONNECT_TIMEOUT_MS: "30000",
  };
  const mcpOptions = {
    ...mcpSdkFactories,
    command: process.execPath,
    args: [resolve(installedPackageRoot, "dist/bin.js")],
    cwd: installedPackageRoot,
    environment: mcpEnvironment,
    sensitiveValues: [
      rigEnv.JETKVM_PASSWORD,
      targetUrl,
      rigEnv.KVM_PRIMARY,
      rigEnv.WIN_TARGET,
    ],
  };
  const mcp = new InstalledMcpClient(mcpOptions);
  const runtimeState = { replacementMcp: undefined };
  let driver;
  let driverFinalization;
  let finalization;
  let finalizationWritten = false;
  let summary;
  let deviceTests;
  let deployment;
  let installation;

  const finalizeResources = async () => {
    finalization ??= await finalizeLiveHardwareResources({
      driver,
      driverFinalization,
      hardwareTouched: true,
      clients: [
        { label: "replacement", client: runtimeState.replacementMcp },
        { label: "initial", client: mcp },
      ],
    });
    if (!finalizationWritten) {
      await writeAndFlush(
        resolve(outputDirectory, "finalization.json"),
        finalization.record,
      );
      finalizationWritten = true;
    }
    if (finalization.failures.length > 0) {
      if (finalization.record.manual_recovery_required) {
        throw new ManualRecoveryRequiredError(finalization.failures);
      }
      throw new AggregateError(
        finalization.failures,
        "Live hardware resource finalization failed.",
      );
    }
  };

  await runWithFinalization(
    async () => {
      const beforeDeviceTests = await readDeviceIdentity(metricsUrl);
      const deviceTestArtifact = resolve(
        outputDirectory,
        "device-go-tests.json",
      );
      deviceTests = await runDeviceGoTests({
        target: rigEnv.KVM_PRIMARY,
        environment: process.env,
        repoRoot: REPOSITORY_ROOT,
        artifactPath: deviceTestArtifact,
      });
      validateDeviceGoTestEvidence(deviceTests);
      const afterDeviceTests = await readDeviceIdentity(metricsUrl);
      if (!sameDeviceIdentity(beforeDeviceTests, afterDeviceTests)) {
        throw new Error(
          "Device identity changed during pre-deployment Go tests.",
        );
      }
      deployment = await runCommand(
        resolve(REPOSITORY_ROOT, "dev_deploy.sh"),
        ["-r", rigEnv.KVM_PRIMARY, "-i", "--skip-native-build"],
        { cwd: REPOSITORY_ROOT },
      );
      const deployedIdentity = await readDeviceIdentity(metricsUrl);
      if (deployedIdentity.revision !== candidate.source.commit_sha) {
        throw new Error(
          "Deployed device revision did not match the frozen candidate.",
        );
      }
      installation = await rig.install();
      await rig.initialize();
      const listed = await mcp.start();
      driver = createLiveHardwareDriver({
        mcp,
        rig,
        candidate,
        runId,
        executionResolver,
        controlledExecution,
      });
      const atxPreflight = await driver.proveAtx();
      const records = await runCanonicalLiveStories({
        stories,
        plan,
        driver,
        runId,
        writeRecord: (record) =>
          writeAndFlush(
            resolve(outputDirectory, `${record.story_id}.json`),
            record,
          ),
      });
      driverFinalization = await driver.finalizeRun();
      const transportReconnect = await reconnectTransportProof(
        { mcp, mcpOptions, runId },
        runtimeState,
      );
      await finalizeResources();
      const finalIdentity = await readDeviceIdentity(metricsUrl);
      if (finalIdentity.revision !== candidate.source.commit_sha) {
        throw new Error(
          "Device identity drifted during hardware release execution.",
        );
      }
      summary = Object.freeze({
        schema_version: 1,
        kind: "jetkvm-mcp-hardware-release-evidence",
        run_id: runId,
        candidate_sha256: await sha256File(candidatePath),
        candidate_commit: candidate.source.commit_sha,
        source_identity: sourceIdentity,
        result: records.every((record) => record.result === "pass")
          ? "pass"
          : "fail",
        story_count: records.length,
        step_count: records.reduce(
          (count, record) => count + record.steps.length,
          0,
        ),
        restore_count: records.reduce(
          (count, record) => count + record.restores.length,
          0,
        ),
        installed_package: packageIdentity,
        installation,
        device_identity: Object.freeze({
          revision: finalIdentity.revision,
          version: finalIdentity.version,
          process_start_time_seconds: finalIdentity.processStartTimeSeconds,
        }),
        device_tests_sha256: sha256Canonical(deviceTests),
        deployment: deployment.evidence,
        tool_listing: listed,
        atx_preflight_sha256: atxPreflight.evidence_sha256,
        transport_reconnect: transportReconnect,
        finalization_sha256: sha256Canonical(finalization.record),
        mcp_stderr: Object.freeze({
          initial: mcp.stderrEvidence(),
          replacement: runtimeState.replacementMcp.stderrEvidence(),
        }),
      });
      await writeAndFlush(resolve(outputDirectory, "summary.json"), summary);
      const writablePayload = await buildDirectoryManifest(outputDirectory);
      for (const file of writablePayload.files) {
        await chmod(resolve(outputDirectory, file.path), 0o400);
      }
      const evidenceManifest = await buildDirectoryManifest(outputDirectory);
      await writeAndFlush(
        resolve(outputDirectory, "manifest.json"),
        Object.freeze({
          schema_version: 1,
          files: evidenceManifest.files,
          sha256: evidenceManifest.sha256,
        }),
      );
      const manifestChecksum = await sha256File(
        resolve(outputDirectory, "manifest.json"),
      );
      await writeTextAndFlush(
        resolve(outputDirectory, "manifest.sha256"),
        `${manifestChecksum}  manifest.json\n`,
      );
      await chmod(resolve(outputDirectory, "manifest.json"), 0o400);
      await chmod(resolve(outputDirectory, "manifest.sha256"), 0o400);
      process.stdout.write(
        `Hardware release evidence complete: ${summary.story_count} stories ${summary.step_count} steps\n`,
      );
    },
    async () => {
      await finalizeResources();
    },
  );
}

if (import.meta.main === true) {
  try {
    await run();
  } catch (error) {
    if (!requiresManualRecovery(error)) throw error;
    process.stderr.write(
      "Hardware release stopped with an unproven device baseline; the lease is retained for manual recovery. Inspect finalization.json failure_stages.\n",
    );
    process.exitCode = 75;
  }
}
