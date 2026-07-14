import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEVICE_LEASE_PROOF_REFERENCE_ENV =
  "JETKVM_DEVICE_LEASE_PROOF_PATH";
export const DEVICE_TEST_TARGET_ENV = "JETKVM_DEVICE_TEST_TARGET";
export const DEVICE_TEST_ARCHIVE_ENV = "JETKVM_DEVICE_TEST_ARCHIVE";

const TEST_EXECUTABLE = "./dev_deploy.sh";
const FORBIDDEN_RAW_PROOF_ENV = Object.freeze([
  "JETKVM_DEVICE_LEASE_OWNER",
  "JETKVM_DEVICE_LEASE_TOKEN",
]);

function parseLabels(text) {
  const labels = {};
  for (const match of text.matchAll(
    /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g,
  )) {
    if (Object.hasOwn(labels, match[1])) {
      throw new Error(`metrics build identity repeated label ${match[1]}`);
    }
    labels[match[1]] = match[2].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  return labels;
}

export function parseDeviceIdentity(metricsText) {
  if (typeof metricsText !== "string") {
    throw new Error("metrics response body was not text");
  }

  const buildLines = metricsText
    .split(/\r?\n/u)
    .filter((line) => /^jetkvm_build_info\{.*\}\s+1(?:\.0+)?\s*$/u.test(line));
  if (buildLines.length === 0) {
    throw new Error("metrics did not contain jetkvm build identity");
  }
  if (buildLines.length !== 1) {
    throw new Error("metrics contained ambiguous build identity");
  }
  const labels = parseLabels(buildLines[0]);
  if (!labels.revision || !labels.version) {
    throw new Error("metrics build identity omitted revision or version");
  }

  const processMatches = [
    ...metricsText.matchAll(/^process_start_time_seconds\s+([^\s]+)\s*$/gmu),
  ];
  if (processMatches.length === 0) {
    throw new Error("metrics did not contain running-binary process identity");
  }
  if (processMatches.length !== 1) {
    throw new Error(
      "metrics contained ambiguous running-binary process identity",
    );
  }
  if (!Number.isFinite(Number(processMatches[0][1]))) {
    throw new Error("metrics did not contain running-binary process identity");
  }

  return Object.freeze({
    revision: labels.revision,
    appVersion: labels.version,
    processStartTime: processMatches[0][1],
  });
}

function requireLeaseProofReference(environment) {
  const reference = environment?.[DEVICE_LEASE_PROOF_REFERENCE_ENV];
  if (
    typeof reference !== "string" ||
    reference.trim() === "" ||
    !path.isAbsolute(reference)
  ) {
    throw new Error("inherited device lease proof reference is required");
  }
  return reference;
}

function requireTarget(configuredTarget, environment) {
  const target = configuredTarget ?? environment?.[DEVICE_TEST_TARGET_ENV];
  if (
    typeof target !== "string" ||
    target === "" ||
    target !== target.trim() ||
    target.startsWith("-") ||
    /[\s/?#@\\]/u.test(target)
  ) {
    throw new Error("a valid device test target is required");
  }
  try {
    const metricsUrl = new URL(`http://${target}/metrics`);
    if (!metricsUrl.hostname || metricsUrl.pathname !== "/metrics") {
      throw new Error("invalid target");
    }
    return Object.freeze({ target, metricsUrl: metricsUrl.href });
  } catch {
    throw new Error("a valid device test target is required");
  }
}

function requireDeviceTestArchive(configuredArchive, environment) {
  const archive = configuredArchive ?? environment?.[DEVICE_TEST_ARCHIVE_ENV];
  if (
    typeof archive !== "string" ||
    archive.length === 0 ||
    !path.isAbsolute(archive) ||
    path.resolve(archive) !== archive
  ) {
    throw new Error("a reviewed device test archive is required");
  }
  return archive;
}

function createTestCommand(target, deviceTestArchive) {
  return Object.freeze({
    executable: TEST_EXECUTABLE,
    args: Object.freeze([
      "-r",
      target,
      "--run-go-tests-only",
      "--device-tests-archive",
      deviceTestArchive,
    ]),
  });
}

function buildSpawnEnvironment(environment) {
  const childEnvironment = { ...environment };
  for (const name of FORBIDDEN_RAW_PROOF_ENV) delete childEnvironment[name];
  return childEnvironment;
}

async function readIdentity(fetchImpl, metricsUrl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("metrics fetch implementation is required");
  }
  const response = await fetchImpl(metricsUrl, {
    method: "GET",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "text/plain" },
  });
  if (response?.ok !== true) {
    throw new Error(
      `metrics request failed: ${String(response?.status ?? "unknown status")}`,
    );
  }
  if (typeof response.text !== "function") {
    throw new Error("metrics response did not provide a text body");
  }
  return parseDeviceIdentity(await response.text());
}

async function defaultSpawn(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export const defaultArtifactWriter = Object.freeze({
  async writeAndFlush(artifactPath, artifact) {
    await mkdir(path.dirname(artifactPath), { recursive: true });
    const handle = await open(artifactPath, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
});

function sameIdentity(before, after) {
  return (
    before.revision === after.revision &&
    before.appVersion === after.appVersion &&
    before.processStartTime === after.processStartTime
  );
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

export function validateDeviceGoTestEvidence(value) {
  const identityValid = (identity) =>
    hasExactKeys(identity, ["revision", "appVersion", "processStartTime"]) &&
    ["revision", "appVersion", "processStartTime"].every(
      (field) =>
        typeof identity[field] === "string" && identity[field].length > 0,
    );
  if (
    !hasExactKeys(value, [
      "ok",
      "startedAt",
      "finishedAt",
      "command",
      "before",
      "after",
      "child",
    ]) ||
    value.ok !== true ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.finishedAt)) ||
    Date.parse(value.finishedAt) < Date.parse(value.startedAt) ||
    !hasExactKeys(value.command, ["executable", "args"]) ||
    value.command.executable !== TEST_EXECUTABLE ||
    JSON.stringify(value.command.args) !==
      JSON.stringify([
        "-r",
        "<configured-target>",
        "--run-go-tests-only",
        "--device-tests-archive",
        "<reviewed-device-tests>",
      ]) ||
    !identityValid(value.before) ||
    !identityValid(value.after) ||
    !sameIdentity(value.before, value.after) ||
    !hasExactKeys(value.child, ["code", "signal"]) ||
    value.child.code !== 0 ||
    value.child.signal !== null
  ) {
    throw new Error(
      "The device Go test evidence is not a complete passing result.",
    );
  }
  return Object.freeze(value);
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function sensitiveEvidenceValues(configuredTarget, environment) {
  const values = new Set();
  const target = configuredTarget ?? environment?.[DEVICE_TEST_TARGET_ENV];
  if (typeof target === "string" && target.length > 0) values.add(target);
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (
      typeof value === "string" &&
      value.length > 0 &&
      /(?:AUTH|CREDENTIAL|PASS|PROOF|SECRET|TOKEN)/iu.test(name)
    ) {
      values.add(value);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function redactEvidence(value, sensitiveValues) {
  if (typeof value === "string") {
    let redacted = value;
    for (const sensitiveValue of sensitiveValues) {
      redacted = redacted.replaceAll(sensitiveValue, "<redacted>");
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactEvidence(entry, sensitiveValues));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        redactEvidence(entry, sensitiveValues),
      ]),
    );
  }
  return value;
}

function assertValidChildResult(child) {
  if (
    child === null ||
    typeof child !== "object" ||
    !Object.hasOwn(child, "code") ||
    !Object.hasOwn(child, "signal") ||
    (child.code !== null && !Number.isInteger(child.code)) ||
    (child.signal !== null && typeof child.signal !== "string") ||
    (child.code === null && child.signal === null)
  ) {
    throw new Error("device Go tests returned an invalid child result");
  }
}

export async function runDeviceGoTests({
  target,
  deviceTestArchive,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  spawnImpl = defaultSpawn,
  artifactWriter = defaultArtifactWriter,
  repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  ),
  artifactPath = path.join(
    repoRoot,
    "tools/paste-harness/artifacts/task2-device-go-tests.json",
  ),
} = {}) {
  const sensitiveValues = sensitiveEvidenceValues(target, environment);
  const startedAt = new Date().toISOString();
  let command;
  let before;
  let after;
  let child;
  let failure;

  try {
    requireLeaseProofReference(environment);
    const configuration = requireTarget(target, environment);
    const archive = requireDeviceTestArchive(deviceTestArchive, environment);
    command = createTestCommand(configuration.target, archive);
    before = await readIdentity(fetchImpl, configuration.metricsUrl);
    child = await spawnImpl(command.executable, [...command.args], {
      cwd: repoRoot,
      environment: buildSpawnEnvironment(environment),
    });

    // Child completion is the ordering barrier. Always prove that both the
    // production application and running process are unchanged before
    // interpreting the test result.
    after = await readIdentity(fetchImpl, configuration.metricsUrl);
    if (!sameIdentity(before, after)) {
      throw new Error(
        `production identity changed: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      );
    }
    assertValidChildResult(child);
    if (child.signal !== null) {
      throw new Error(`device Go tests terminated by signal ${child.signal}`);
    }
    if (child.code !== 0) {
      throw new Error(`device Go tests exited with code ${String(child.code)}`);
    }
  } catch (error) {
    failure = normalizeError(error);
  }

  const artifact = {
    ok: failure === undefined,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(command === undefined
      ? {}
      : {
          command: {
            executable: TEST_EXECUTABLE,
            args: [
              "-r",
              "<configured-target>",
              "--run-go-tests-only",
              "--device-tests-archive",
              "<reviewed-device-tests>",
            ],
          },
        }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    ...(child === undefined ? {} : { child }),
    ...(failure === undefined ? {} : { error: failure.message }),
  };

  const persistedArtifact = redactEvidence(artifact, sensitiveValues);
  try {
    await artifactWriter.writeAndFlush(artifactPath, persistedArtifact);
  } catch (artifactError) {
    const flushFailure = normalizeError(artifactError);
    if (failure) {
      throw new AggregateError(
        [failure, flushFailure],
        "device tests failed and artifact flush failed",
      );
    }
    throw flushFailure;
  }

  if (failure) throw failure;
  return persistedArtifact;
}

export async function runDeviceGoTestsCli({
  run = runDeviceGoTests,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    await run();
    stdout.write("Device Go tests passed; evidence artifact flushed.\n");
    return 0;
  } catch {
    stderr.write(
      "Device Go tests failed; evidence artifact flush attempted.\n",
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runDeviceGoTestsCli();
}
