import { stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File } from "./release-evidence.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const TRUSTED_REPOSITORY = "WyrmKeep/jetkvm-reliable-paste-private";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label} is malformed.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} fields are invalid.`);
  }
}

export async function createDeviceReleaseProvenance({
  binaryPath,
  deviceTestsPath,
  sourceCommit,
  repository,
  workflowRef,
  runId,
  runAttempt,
}) {
  const [facts, deviceTestFacts] = await Promise.all([
    stat(binaryPath),
    stat(deviceTestsPath),
  ]);
  if (
    !facts.isFile() ||
    facts.size < 1 ||
    !deviceTestFacts.isFile() ||
    deviceTestFacts.size < 1 ||
    !COMMIT.test(sourceCommit) ||
    typeof repository !== "string" ||
    repository.length === 0 ||
    typeof workflowRef !== "string" ||
    workflowRef.length === 0 ||
    typeof runId !== "string" ||
    !/^[1-9][0-9]*$/u.test(runId) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1
  ) {
    throw new Error("Device release provenance input is invalid.");
  }
  return Object.freeze({
    schema_version: 1,
    kind: "jetkvm-device-release-artifact",
    source_commit: sourceCommit,
    binary: Object.freeze({
      filename: basename(binaryPath),
      size_bytes: facts.size,
      sha256: await sha256File(binaryPath),
    }),
    device_tests: Object.freeze({
      filename: basename(deviceTestsPath),
      size_bytes: deviceTestFacts.size,
      sha256: await sha256File(deviceTestsPath),
    }),
    builder: Object.freeze({
      repository,
      workflow_ref: workflowRef,
      run_id: runId,
      run_attempt: runAttempt,
    }),
  });
}

export function validateDeviceReleaseProvenance(value, candidate) {
  assertExactKeys(
    value,
    [
      "schema_version",
      "kind",
      "source_commit",
      "binary",
      "device_tests",
      "builder",
    ],
    "Device release provenance",
  );
  assertExactKeys(
    value.binary,
    ["filename", "size_bytes", "sha256"],
    "Device release binary provenance",
  );
  assertExactKeys(
    value.device_tests,
    ["filename", "size_bytes", "sha256"],
    "Device release test provenance",
  );
  assertExactKeys(
    value.builder,
    ["repository", "workflow_ref", "run_id", "run_attempt"],
    "Device release builder provenance",
  );
  if (
    value.schema_version !== 1 ||
    value.kind !== "jetkvm-device-release-artifact" ||
    !COMMIT.test(value.source_commit) ||
    value.source_commit !== candidate.source.commit_sha ||
    value.binary.filename !== "jetkvm_app" ||
    !Number.isSafeInteger(value.binary.size_bytes) ||
    value.binary.size_bytes < 1 ||
    !HASH.test(value.binary.sha256) ||
    value.device_tests.filename !== "device-tests.tar.gz" ||
    !Number.isSafeInteger(value.device_tests.size_bytes) ||
    value.device_tests.size_bytes < 1 ||
    !HASH.test(value.device_tests.sha256) ||
    value.builder.repository !== TRUSTED_REPOSITORY ||
    typeof value.builder.workflow_ref !== "string" ||
    !value.builder.workflow_ref.startsWith(
      `${TRUSTED_REPOSITORY}/.github/workflows/build.yml@`,
    ) ||
    typeof value.builder.run_id !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.builder.run_id) ||
    !Number.isSafeInteger(value.builder.run_attempt) ||
    value.builder.run_attempt < 1
  ) {
    throw new Error("Device release provenance did not match the candidate.");
  }
  return Object.freeze({
    source_commit: value.source_commit,
    binary: Object.freeze({ ...value.binary }),
    device_tests: Object.freeze({ ...value.device_tests }),
    builder: Object.freeze({ ...value.builder }),
  });
}

async function run() {
  const [binaryPath, deviceTestsPath, outputPath] = process.argv.slice(2);
  if (
    binaryPath === undefined ||
    deviceTestsPath === undefined ||
    outputPath === undefined
  ) {
    throw new Error(
      "Usage: device-release-provenance.mjs <binary-path> <device-tests-path> <output-path>",
    );
  }
  const provenance = await createDeviceReleaseProvenance({
    binaryPath: resolve(binaryPath),
    deviceTestsPath: resolve(deviceTestsPath),
    sourceCommit: process.env.GITHUB_SHA ?? "",
    repository: process.env.GITHUB_REPOSITORY ?? "",
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  });
  await writeFile(
    resolve(outputPath),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run();
}
