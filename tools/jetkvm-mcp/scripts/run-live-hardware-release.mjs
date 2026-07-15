import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  lstat,
  open,
  realpath,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CONTROLLED_TRACE_REPORT_PATHS,
  mergeControlledTraceReports,
  validateControlledReleaseEvidence,
} from "./build-controlled-release-evidence.mjs";
import {
  InstalledMcpClient,
  assertPrivateEnvironmentFile,
  createLiveHardwareDriver,
  finalizeLiveHardwareResources,
  verifyInstalledPackageIdentity,
} from "./hardware-release-driver.mjs";
import { validateDeviceReleaseProvenance } from "./device-release-provenance.mjs";
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
export function createFinalizationError(finalization, persistenceError) {
  const failures = [
    ...finalization.failures,
    ...(persistenceError === undefined ? [] : [persistenceError]),
  ];
  if (failures.length === 0) return undefined;
  if (finalization.record.manual_recovery_required === true) {
    return new ManualRecoveryRequiredError(failures);
  }
  return new AggregateError(
    failures,
    "Live hardware resource finalization failed.",
    { cause: failures[0] },
  );
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

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error instanceof Error ? error.code : undefined) !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForProcessGroupExit(child) {
  if (child.pid === undefined || process.platform === "win32") return;
  for (;;) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if ((error instanceof Error ? error.code : undefined) === "ESRCH") return;
      throw error;
    }
    await delay(20);
  }
}

export async function runCommand(
  command,
  args,
  {
    cwd = REPOSITORY_ROOT,
    timeoutMs = COMMAND_TIMEOUT_MS,
    terminationGraceMs = 1_000,
  } = {},
) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let byteLength = 0;
    let settled = false;
    let failure;
    let forceKillTimer;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(forceKillTimer);
      operation();
    };
    const terminate = (error) => {
      if (failure !== undefined) return;
      failure = error;
      try {
        signalProcessGroup(child, "SIGTERM");
      } catch (signalError) {
        failure = new AggregateError(
          [failure, signalError],
          "Hardware release command and process-tree termination failed.",
          { cause: failure },
        );
      }
      forceKillTimer = setTimeout(() => {
        try {
          signalProcessGroup(child, "SIGKILL");
        } catch (signalError) {
          failure = new AggregateError(
            [failure, signalError],
            "Hardware release command and process-tree termination failed.",
            { cause: failure },
          );
        }
      }, terminationGraceMs);
    };
    const append = (target, chunk) => {
      if (failure !== undefined) return;
      byteLength += chunk.byteLength;
      if (byteLength > COMMAND_OUTPUT_LIMIT) {
        terminate(
          new Error("Hardware release command output exceeded its bound."),
        );
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.once("error", (error) => {
      terminate(error);
      if (child.pid === undefined) finish(() => rejectRun(failure));
    });
    child.once("close", async (code, signal) => {
      if (failure !== undefined) {
        try {
          signalProcessGroup(child, "SIGKILL");
          await waitForProcessGroupExit(child);
        } catch (cleanupError) {
          failure = new AggregateError(
            [failure, cleanupError],
            "Hardware release command and process-tree termination failed.",
            { cause: failure },
          );
        }
        finish(() => rejectRun(failure));
        return;
      }
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
    const deadlineTimer = setTimeout(() => {
      terminate(new Error("Hardware release command exceeded its deadline."));
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

async function readDeviceIdentity(metricsUrl, accept = () => true) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(metricsUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        throw new Error("Metrics endpoint rejected the request.");
      const identity = parseDeviceIdentity(await response.text());
      if (accept(identity)) return identity;
      lastError = new Error(
        "Device identity did not reach the required state.",
      );
    } catch (error) {
      lastError = error;
    }
    await delay(2_000);
  }
  throw lastError ?? new Error("Device identity was unavailable.");
}

function sameDeviceIdentity(left, right) {
  return (
    left.revision === right.revision &&
    left.appVersion === right.appVersion &&
    left.processStartTime === right.processStartTime
  );
}

export function createRigAdapter(
  rigModule,
  sshModule,
  normalizeModule,
  rigEnv,
) {
  let lastLayout;
  let lastBootIdentity;
  let confirmedOffline = false;
  const target = sshModule.windowsTarget(rigEnv);

  async function probeHostPowerState() {
    const result = await sshModule.runSshCommand(target, "echo ready", {
      timeoutMs: 5_000,
    });
    if (result.exitCode === 0) {
      confirmedOffline = false;
      return "online";
    }
    return confirmedOffline ? "offline" : "unknown";
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
    hostPowerState: probeHostPowerState,
    async waitForHostOnline() {
      await waitUntil(
        async () => (await probeHostPowerState()) === "online",
        60_000,
        "Windows host did not return online.",
      );
      confirmedOffline = false;
      lastBootIdentity = await bootIdentity();
    },
    async waitForHostOffline(evidence) {
      const observation = evidence?.atx_led_observation;
      const observedAt = Date.parse(observation?.observed_at ?? "");
      if (
        observation?.power !== false ||
        observation?.freshness === "unknown" ||
        !Number.isFinite(observedAt) ||
        observedAt < evidence.started_at ||
        observedAt > Date.now() + 1_000
      ) {
        throw new Error(
          "Windows host power-off lacked a post-action ATX power LED observation.",
        );
      }
      if ((await probeHostPowerState()) === "online") {
        throw new Error(
          "Windows host remained reachable despite the power-off observation.",
        );
      }
      confirmedOffline = true;
    },
    async waitForHostRestart() {
      const previous = lastBootIdentity;
      await waitUntil(
        async () => {
          const state = await probeHostPowerState();
          if (state === "offline") return true;
          if (state === "unknown") return false;
          const current = await bootIdentity();
          return previous !== undefined && current !== previous;
        },
        90_000,
        "Windows host did not begin restarting.",
      );
      await waitUntil(
        async () => (await probeHostPowerState()) === "online",
        60_000,
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
        host_online: (await probeHostPowerState()) === "online",
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

async function inspectStampedDeviceBinary(path, revision) {
  const revisionBytes = Buffer.from(revision, "ascii");
  const overlapLength = revisionBytes.length - 1;
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const digest = createHash("sha256");
  const handle = await open(path, "r");
  let carry = Buffer.alloc(0);
  let revisionOccurrences = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      digest.update(bytes);

      for (
        let index = bytes.indexOf(revisionBytes);
        index !== -1;
        index = bytes.indexOf(revisionBytes, index + 1)
      ) {
        revisionOccurrences += 1;
      }

      if (carry.length > 0) {
        const boundary = Buffer.concat([
          carry,
          bytes.subarray(0, Math.min(bytes.length, overlapLength)),
        ]);
        for (
          let index = boundary.indexOf(revisionBytes);
          index !== -1;
          index = boundary.indexOf(revisionBytes, index + 1)
        ) {
          if (
            index < carry.length &&
            index + revisionBytes.length > carry.length
          ) {
            revisionOccurrences += 1;
          }
        }
      }

      const tailSource =
        bytes.length >= overlapLength ? bytes : Buffer.concat([carry, bytes]);
      carry = Buffer.from(
        tailSource.subarray(Math.max(0, tailSource.length - overlapLength)),
      );
    }
  } finally {
    await handle.close();
  }
  return Object.freeze({
    sha256: digest.digest("hex"),
    revisionOccurrences,
  });
}

export async function validateReleaseDeviceBinary({
  candidate,
  binaryPath,
  expectedSha256,
  deviceTestsPath,
  provenancePath,
  expectedDeviceTestsSha256,
  expectedProvenanceSha256,
  command = runCommand,
}) {
  if (
    !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
    !/^[a-f0-9]{64}$/u.test(expectedDeviceTestsSha256) ||
    !/^[a-f0-9]{64}$/u.test(expectedProvenanceSha256)
  ) {
    throw new Error("Device release artifact checksum is invalid.");
  }
  const [facts, deviceTestFacts, provenanceFacts] = await Promise.all([
    lstat(binaryPath),
    lstat(deviceTestsPath),
    lstat(provenancePath),
  ]);
  if (
    !facts.isFile() ||
    facts.isSymbolicLink() ||
    facts.size < 1 ||
    (facts.mode & 0o022) !== 0 ||
    !deviceTestFacts.isFile() ||
    deviceTestFacts.isSymbolicLink() ||
    deviceTestFacts.size < 1 ||
    (deviceTestFacts.mode & 0o022) !== 0 ||
    !provenanceFacts.isFile() ||
    provenanceFacts.isSymbolicLink() ||
    provenanceFacts.size < 1 ||
    (provenanceFacts.mode & 0o022) !== 0
  ) {
    throw new Error("Device release artifact is not a protected regular file.");
  }
  const revision = candidate.source.commit_sha;
  const [binaryInspection, deviceTestsSha256, provenanceSha256] =
    await Promise.all([
      inspectStampedDeviceBinary(binaryPath, revision),
      sha256File(deviceTestsPath),
      sha256File(provenancePath),
    ]);
  const actualSha256 = binaryInspection.sha256;
  if (
    actualSha256 !== expectedSha256 ||
    deviceTestsSha256 !== expectedDeviceTestsSha256 ||
    provenanceSha256 !== expectedProvenanceSha256
  ) {
    throw new Error("Device release artifact checksum did not match.");
  }
  const provenance = validateDeviceReleaseProvenance(
    await readJson(provenancePath),
    candidate,
  );
  if (
    provenance.binary.filename !== basename(binaryPath) ||
    provenance.binary.size_bytes !== facts.size ||
    provenance.binary.sha256 !== actualSha256 ||
    provenance.device_tests.filename !== basename(deviceTestsPath) ||
    provenance.device_tests.size_bytes !== deviceTestFacts.size ||
    provenance.device_tests.sha256 !== deviceTestsSha256
  ) {
    throw new Error(
      "Device release provenance did not describe the reviewed binary.",
    );
  }
  const inspection = await command("go", ["version", "-m", binaryPath], {
    cwd: REPOSITORY_ROOT,
  });
  if (binaryInspection.revisionOccurrences !== 1) {
    throw new Error(
      "Device release artifact was not built from the frozen source commit.",
    );
  }
  return Object.freeze({
    size_bytes: facts.size,
    sha256: actualSha256,
    device_tests_sha256: deviceTestsSha256,
    provenance_sha256: provenanceSha256,
    source_commit: revision,
    builder: provenance.builder,
    go_version_report_sha256: sha256Text(inspection.stdout),
  });
}

function sshResultEvidence(result) {
  return Object.freeze({
    command: result.command,
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: result.timedOut,
    stdout_bytes: Buffer.byteLength(result.stdout),
    stdout_sha256: sha256Text(result.stdout),
    stderr_bytes: Buffer.byteLength(result.stderr),
    stderr_sha256: sha256Text(result.stderr),
  });
}

function assertSshResult(result, label) {
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.timedOut !== false
  ) {
    throw new Error(`${label} failed.`);
  }
}

export async function deployReleaseDeviceBinary({
  sshModule,
  host,
  binaryPath,
  expectedSha256,
}) {
  if (
    typeof host !== "string" ||
    !/^[A-Za-z0-9.:[\]-]+$/u.test(host) ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256)
  ) {
    throw new Error("Device release deployment input is invalid.");
  }
  const target = sshModule.kvmTarget(host);
  const remotePath = "/userdata/jetkvm/jetkvm_app.update";
  const uploadPath = `${remotePath}.upload`;
  const uploadCommand = [
    "set -e",
    "umask 077",
    `rm -f ${remotePath} ${uploadPath}`,
    `trap 'rm -f ${remotePath} ${uploadPath}' EXIT HUP INT TERM`,
    `cat > ${uploadPath}`,
    `printf '%s  %s\\n' '${expectedSha256}' '${uploadPath}' | sha256sum -c -`,
    `mv -f ${uploadPath} ${remotePath}`,
    "sync",
    "trap - EXIT HUP INT TERM",
  ].join("; ");
  const upload = await sshModule.runSshCommand(target, uploadCommand, {
    timeoutMs: 60_000,
    inputFile: binaryPath,
  });
  assertSshResult(upload, "Device release artifact upload");
  const staged = await sshModule.runSshCommand(
    target,
    `sha256sum ${remotePath}`,
    { timeoutMs: 30_000 },
  );
  assertSshResult(staged, "Device release artifact verification");
  const stagedSha256 =
    /^([a-f0-9]{64})\s+\/userdata\/jetkvm\/jetkvm_app\.update\s*$/u.exec(
      staged.stdout,
    )?.[1];
  if (stagedSha256 !== expectedSha256) {
    throw new Error("Staged device release artifact checksum did not match.");
  }
  const reboot = await sshModule.runSshCommand(
    target,
    "nohup sh -c 'sleep 1; reboot' >/dev/null 2>&1 &",
    { timeoutMs: 30_000 },
  );
  assertSshResult(reboot, "Device release reboot");
  return Object.freeze({
    upload: sshResultEvidence(upload),
    staged_verification: sshResultEvidence(staged),
    reboot: sshResultEvidence(reboot),
    staged_binary_sha256: stagedSha256,
  });
}

export async function verifyReplacementPackageIdentity({
  candidate,
  installedPackageRoot,
  candidatePath,
  initialIdentity,
  verify = verifyInstalledPackageIdentity,
}) {
  const replacementIdentity = await verify(candidate, installedPackageRoot, {
    candidateDirectory: dirname(candidatePath),
  });
  if (
    sha256Canonical(replacementIdentity) !== sha256Canonical(initialIdentity)
  ) {
    throw new Error(
      "Installed package identity drifted before transport replacement.",
    );
  }
  return replacementIdentity;
}

export function createInstalledMcpOptions({
  installedPackageRoot,
  environment,
  sensitiveValues,
  sdkFactories,
}) {
  return Object.freeze({
    ...sdkFactories,
    command: process.execPath,
    args: [resolve(installedPackageRoot, "dist/bin.js"), "--leased"],
    cwd: installedPackageRoot,
    environment,
    sensitiveValues: Object.freeze([...sensitiveValues]),
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
  const evidenceRoot = await realpath(
    resolve(requiredEnvironment("JETKVM_RELEASE_EVIDENCE_ROOT")),
  );
  const evidenceRootFacts = await stat(evidenceRoot);
  if (
    !evidenceRootFacts.isDirectory() ||
    (evidenceRootFacts.mode & 0o077) !== 0
  ) {
    throw new Error(
      "JETKVM_RELEASE_EVIDENCE_ROOT must be a private existing directory.",
    );
  }
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
  const deviceBinaryPath = resolve(
    requiredEnvironment("JETKVM_RELEASE_DEVICE_BINARY"),
  );
  const deviceTestsPath = resolve(
    requiredEnvironment("JETKVM_RELEASE_DEVICE_TESTS"),
  );
  const deviceBinary = await validateReleaseDeviceBinary({
    candidate,
    binaryPath: deviceBinaryPath,
    deviceTestsPath,
    expectedSha256: requiredEnvironment("JETKVM_RELEASE_DEVICE_BINARY_SHA256"),
    expectedDeviceTestsSha256: requiredEnvironment(
      "JETKVM_RELEASE_DEVICE_TESTS_SHA256",
    ),
    provenancePath: resolve(
      requiredEnvironment("JETKVM_RELEASE_DEVICE_PROVENANCE"),
    ),
    expectedProvenanceSha256: requiredEnvironment(
      "JETKVM_RELEASE_DEVICE_PROVENANCE_SHA256",
    ),
  });

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
  const inheritedLeaseModule = await import(
    pathToFileURL(resolve(installedPackageRoot, "dist/deviceLease.js")).href
  );
  if (
    typeof inheritedLeaseModule.loadDeviceLeaseProofReference !== "function"
  ) {
    throw new Error("Installed release candidate omitted lease verification.");
  }
  await inheritedLeaseModule.loadDeviceLeaseProofReference(
    requiredEnvironment("JETKVM_DEVICE_LEASE_PROOF_PATH"),
    `jetkvm-${sha256Text(targetUrl)}`,
  );
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
  const realOutputDirectory = await realpath(outputDirectory);
  const relativeOutput = relative(evidenceRoot, realOutputDirectory);
  if (
    relativeOutput.length === 0 ||
    relativeOutput === ".." ||
    relativeOutput.startsWith(`..${sep}`) ||
    resolve(evidenceRoot, relativeOutput) !== realOutputDirectory
  ) {
    throw new Error(
      "JETKVM_RELEASE_EVIDENCE_DIR escaped JETKVM_RELEASE_EVIDENCE_ROOT.",
    );
  }

  const branchMatrix = await readJson(
    resolve(PACKAGE_ROOT, "reports/branch-matrix.json"),
  );
  const storyE2e = await readJson(
    resolve(PACKAGE_ROOT, "reports/story-e2e.json"),
  );
  const executionTraces = mergeControlledTraceReports(
    await Promise.all(
      CONTROLLED_TRACE_REPORT_PATHS.map((path) =>
        readJson(resolve(PACKAGE_ROOT, path)),
      ),
    ),
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
    executionTraces,
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
  const mcpOptions = createInstalledMcpOptions({
    installedPackageRoot,
    environment: mcpEnvironment,
    sensitiveValues: [
      rigEnv.JETKVM_PASSWORD,
      targetUrl,
      rigEnv.KVM_PRIMARY,
      rigEnv.WIN_TARGET,
    ],
    sdkFactories: mcpSdkFactories,
  });
  const mcp = new InstalledMcpClient(mcpOptions);
  let driver;
  let driverFinalization;
  let finalization;
  let finalizationWritten = false;
  let summary;
  let deviceTests;
  let deployedIdentity;
  let deployment;
  let installation;

  const finalizeResources = async () => {
    finalization ??= await finalizeLiveHardwareResources({
      driver,
      driverFinalization,
      hardwareTouched: true,
      clients: [{ label: "initial", client: mcp }],
    });
    let persistenceError;
    if (!finalizationWritten) {
      try {
        await writeAndFlush(
          resolve(outputDirectory, "finalization.json"),
          finalization.record,
        );
        finalizationWritten = true;
      } catch (error) {
        persistenceError = error;
      }
    }
    const error = createFinalizationError(finalization, persistenceError);
    if (error !== undefined) throw error;
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
        deviceTestArchive: deviceTestsPath,
        deviceTestSha256: deviceBinary.device_tests_sha256,
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
      const preDeploymentSourceIdentity =
        await validateCurrentReleaseSource(candidate);
      const deploymentOperation = await deployReleaseDeviceBinary({
        sshModule,
        host: rigEnv.KVM_PRIMARY,
        binaryPath: deviceBinaryPath,
        expectedSha256: deviceBinary.sha256,
      });
      const postDeploymentSourceIdentity =
        await validateCurrentReleaseSource(candidate);
      if (
        sha256Canonical(preDeploymentSourceIdentity) !==
        sha256Canonical(postDeploymentSourceIdentity)
      ) {
        throw new Error("Release source changed during device deployment.");
      }
      deployedIdentity = await readDeviceIdentity(
        metricsUrl,
        (identity) =>
          identity.revision === candidate.source.commit_sha &&
          !sameDeviceIdentity(afterDeviceTests, identity),
      );
      const localDeviceBinarySha256 = await sha256File(deviceBinaryPath);
      if (localDeviceBinarySha256 !== deviceBinary.sha256) {
        throw new Error("Reviewed device release artifact changed.");
      }
      const remoteBinary = await sshModule.runSshCommand(
        sshModule.kvmTarget(rigEnv.KVM_PRIMARY),
        "test ! -e /userdata/jetkvm/jetkvm_app.update && sha256sum /userdata/jetkvm/bin/jetkvm_app",
        { timeoutMs: 30_000 },
      );
      assertSshResult(remoteBinary, "Installed device binary verification");
      const installedDeviceBinarySha256 =
        /^([a-f0-9]{64})\s+\/userdata\/jetkvm\/bin\/jetkvm_app\s*$/u.exec(
          remoteBinary.stdout,
        )?.[1];
      if (installedDeviceBinarySha256 !== localDeviceBinarySha256) {
        throw new Error(
          "Deployed device binary did not match the reviewed release artifact.",
        );
      }
      deployment = Object.freeze({
        evidence: Object.freeze({
          deployment: deploymentOperation,
          source_identity: postDeploymentSourceIdentity,
          release_artifact: deviceBinary,
          local_binary_sha256: localDeviceBinarySha256,
          installed_binary_sha256: installedDeviceBinarySha256,
          staged_update_absent: true,
        }),
      });
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
      await verifyReplacementPackageIdentity({
        candidate,
        installedPackageRoot,
        candidatePath,
        initialIdentity: packageIdentity,
      });
      await validateCandidateRuntime(
        candidate,
        candidatePath,
        browserPath,
        targetUrl,
      );
      await finalizeResources();
      const finalIdentity = await readDeviceIdentity(metricsUrl);
      if (!sameDeviceIdentity(deployedIdentity, finalIdentity)) {
        throw new Error(
          "Device identity drifted during hardware release execution.",
        );
      }
      const finalSourceIdentity = await validateCurrentReleaseSource(candidate);
      if (
        sha256Canonical(finalSourceIdentity) !==
          sha256Canonical(sourceIdentity) ||
        sha256Canonical(finalSourceIdentity) !==
          sha256Canonical(postDeploymentSourceIdentity)
      ) {
        throw new Error(
          "Release source identity drifted before evidence seal.",
        );
      }
      const finalLocalDeviceBinarySha256 = await sha256File(deviceBinaryPath);
      const finalRemoteBinary = await sshModule.runSshCommand(
        sshModule.kvmTarget(rigEnv.KVM_PRIMARY),
        "test ! -e /userdata/jetkvm/jetkvm_app.update && sha256sum /userdata/jetkvm/bin/jetkvm_app",
        { timeoutMs: 30_000 },
      );
      assertSshResult(finalRemoteBinary, "Final device binary verification");
      const finalInstalledDeviceBinarySha256 =
        /^([a-f0-9]{64})\s+\/userdata\/jetkvm\/bin\/jetkvm_app\s*$/u.exec(
          finalRemoteBinary.stdout,
        )?.[1];
      if (
        finalLocalDeviceBinarySha256 !==
          deployment.evidence.local_binary_sha256 ||
        finalInstalledDeviceBinarySha256 !==
          deployment.evidence.installed_binary_sha256
      ) {
        throw new Error(
          "Device deployment bytes drifted before evidence seal.",
        );
      }
      summary = Object.freeze({
        schema_version: 1,
        kind: "jetkvm-mcp-hardware-release-evidence",
        run_id: runId,
        candidate_sha256: await sha256File(candidatePath),
        candidate_commit: candidate.source.commit_sha,
        source_identity: finalSourceIdentity,
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
        installed_package: replacementPackageIdentity,
        installation,
        device_identity: Object.freeze({
          revision: finalIdentity.revision,
          app_version: finalIdentity.appVersion,
          process_start_time: finalIdentity.processStartTime,
        }),
        device_tests_sha256: sha256Canonical(deviceTests),
        deployment: deployment.evidence,
        tool_listing: listed,
        atx_preflight_sha256: atxPreflight.evidence_sha256,
        finalization_sha256: sha256Canonical(finalization.record),
        mcp_stderr: Object.freeze({
          initial: mcp.stderrEvidence(),
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
      await chmod(outputDirectory, 0o500);
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
