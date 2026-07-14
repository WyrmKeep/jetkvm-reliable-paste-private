import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDirectoryManifest,
  createExecutionEvidenceResolver,
  sha256Canonical,
  sha256Bytes,
  sha256File,
  validateReleaseCandidateManifest,
} from "./release-evidence.mjs";
import { validateDeviceGoTestEvidence } from "./run-device-go-tests.mjs";
import { materializeLiveExecutionPlan } from "./live-story-plan.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const PRIVATE_PATTERN =
  /(?:\/Users\/|[A-Za-z]:\\|(?:^|[^0-9])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?!\d)|JETKVM_PASSWORD|JETKVM_CREDENTIAL|BEGIN [A-Z ]+PRIVATE KEY)/u;

export function containsPrivateReleaseMaterial(value) {
  return PRIVATE_PATTERN.test(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}
function validateStructuredPreimages(value, label) {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      validateStructuredPreimages(child, `${label}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  if (Object.hasOwn(value, "structured_sha256")) {
    assertHash(value.structured_sha256, `${label} structured evidence`);
    if (
      !isRecord(value.structured) ||
      sha256Canonical(value.structured) !== value.structured_sha256
    ) {
      throw new Error(`${label} omitted its structured evidence preimage.`);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    validateStructuredPreimages(child, `${label}.${key}`);
  }
}

function assertEvidencePreimage(value, digest, label) {
  assertHash(digest, label);
  if (
    value === null ||
    value === undefined ||
    sha256Canonical(value) !== digest
  ) {
    throw new Error(`${label} did not bind its persisted evidence preimage.`);
  }
  validateStructuredPreimages(value, label);
}

function assertPass(value, label) {
  if (!isRecord(value) || value.result !== "pass") {
    throw new Error(`${label} did not pass.`);
  }
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} is malformed.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} fields drifted.`);
  }
}

function validateFinalization(record) {
  assertExactKeys(
    record,
    [
      "schema_version",
      "kind",
      "result",
      "completed_at",
      "release_and_baseline_evidence_sha256",
      "safe_baseline_proven",
      "manual_recovery_required",
      "clients",
      "failure_count",
      "failure_stages",
    ],
    "Hardware finalization",
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== "jetkvm-mcp-hardware-finalization" ||
    record.result !== "pass" ||
    !Number.isFinite(Date.parse(record.completed_at)) ||
    record.safe_baseline_proven !== true ||
    record.manual_recovery_required !== false ||
    record.failure_count !== 0 ||
    !Array.isArray(record.failure_stages) ||
    record.failure_stages.length !== 0 ||
    !Array.isArray(record.clients) ||
    record.clients.length !== 2
  ) {
    throw new Error("Hardware finalization did not pass exactly.");
  }
  assertHash(
    record.release_and_baseline_evidence_sha256,
    "Hardware finalization evidence",
  );
  const expectedLabels = ["replacement", "initial"];
  record.clients.forEach((client, index) => {
    assertExactKeys(client, ["label", "closed", "stderr"], "MCP finalization");
    if (
      client.label !== expectedLabels[index] ||
      client.closed !== true ||
      !isRecord(client.stderr) ||
      !Number.isSafeInteger(client.stderr.byte_length) ||
      client.stderr.byte_length < 0
    ) {
      throw new Error("MCP finalization did not close every transport.");
    }
    assertExactKeys(client.stderr, ["byte_length", "sha256"], "MCP stderr");
    assertHash(client.stderr.sha256, "MCP stderr evidence");
  });
}

function validateRecord(record, story, storyPlan, runId) {
  if (
    !isRecord(record) ||
    record.schema_version !== 1 ||
    record.run_id !== runId
  ) {
    throw new Error(`Hardware record ${story.id} has invalid identity.`);
  }
  if (
    record.story_id !== story.id ||
    record.title !== story.title ||
    record.result !== "pass"
  ) {
    throw new Error(`Hardware record ${story.id} did not pass exactly.`);
  }
  assertEvidencePreimage(
    record.baseline_before,
    record.baseline_before_sha256,
    `${story.id} baseline before`,
  );
  assertEvidencePreimage(
    record.baseline_after,
    record.baseline_after_sha256,
    `${story.id} baseline after`,
  );
  assertPass(record.baseline_comparison, `${story.id} baseline comparison`);
  assertEvidencePreimage(
    record.baseline_comparison.evidence,
    record.baseline_comparison.evidence_sha256,
    `${story.id} baseline comparison evidence`,
  );
  if (
    !Array.isArray(record.steps) ||
    record.steps.length !== story.steps.length
  ) {
    throw new Error(
      `Hardware record ${story.id} has incomplete step coverage.`,
    );
  }
  record.steps.forEach((result, index) => {
    const step = story.steps[index];
    const assignment = storyPlan.steps[step.id];
    if (
      !isRecord(result) ||
      result.step_id !== step.id ||
      result.mode !== assignment.mode ||
      result.result !== "pass" ||
      !Number.isSafeInteger(result.duration_ms) ||
      result.duration_ms < 0
    ) {
      throw new Error(
        `Hardware step ${story.id}/${step.id} did not pass exactly.`,
      );
    }
    assertEvidencePreimage(
      result.evidence,
      result.evidence_sha256,
      `${story.id}/${step.id} evidence`,
    );
    if (assignment.assertion_ids !== undefined) {
      if (
        !Array.isArray(result.assertion_ids) ||
        sha256Canonical(result.assertion_ids) !==
          sha256Canonical(assignment.assertion_ids)
      ) {
        throw new Error(
          `Hardware step ${story.id}/${step.id} assertion IDs drifted.`,
        );
      }
    }
  });
  if (
    !Array.isArray(record.restores) ||
    record.restores.length !== story.restore.length
  ) {
    throw new Error(
      `Hardware record ${story.id} has incomplete restoration coverage.`,
    );
  }
  record.restores.forEach((result, index) => {
    const restore = story.restore[index];
    if (
      !isRecord(result) ||
      result.restore_id !== restore.id ||
      result.result !== "pass"
    ) {
      throw new Error(
        `Hardware restore ${story.id}/${restore.id} did not pass.`,
      );
    }
    assertEvidencePreimage(
      result.evidence,
      result.evidence_sha256,
      `${story.id}/${restore.id} restore evidence`,
    );
  });
  if (record.failure_count !== 0) {
    throw new Error(`Hardware record ${story.id} contains failures.`);
  }
}

export function validateHardwareReleaseEvidence({
  candidate,
  candidateSha256,
  stories,
  plan,
  summary,
  records,
  finalization,
  deviceTests,
}) {
  validateReleaseCandidateManifest(candidate);
  validateFinalization(finalization);
  validateDeviceGoTestEvidence(deviceTests);
  if (
    !isRecord(summary) ||
    summary.schema_version !== 1 ||
    summary.kind !== "jetkvm-mcp-hardware-release-evidence" ||
    summary.result !== "pass" ||
    typeof summary.run_id !== "string" ||
    summary.candidate_commit !== candidate.source.commit_sha
  ) {
    throw new Error("Hardware release summary did not pass exactly.");
  }
  const reviewedDeviceTestsSha256 =
    summary.deployment?.release_artifact?.device_tests_sha256;
  assertHash(reviewedDeviceTestsSha256, "Reviewed device test archive");
  if (deviceTests.command.args[6] !== reviewedDeviceTestsSha256) {
    throw new Error(
      "Executed device tests did not match the reviewed CI archive.",
    );
  }
  assertHash(candidateSha256, "Validated hardware candidate checksum");
  if (summary.candidate_sha256 !== candidateSha256) {
    throw new Error(
      "Hardware candidate checksum did not bind the validated candidate bytes.",
    );
  }
  const liveStories = stories.filter((story) =>
    story.environments.includes("live"),
  );
  if (!Array.isArray(records) || records.length !== liveStories.length) {
    throw new Error(
      "Hardware release evidence omitted canonical live stories.",
    );
  }
  liveStories.forEach((story, index) => {
    const record = records[index];
    if (record.story_id !== story.id) {
      throw new Error("Hardware live stories are not in canonical order.");
    }
    validateRecord(record, story, plan[story.id], summary.run_id);
  });
  const stepCount = records.reduce(
    (count, record) => count + record.steps.length,
    0,
  );
  const restoreCount = records.reduce(
    (count, record) => count + record.restores.length,
    0,
  );
  assertExactKeys(
    summary.device_identity,
    ["revision", "app_version", "process_start_time"],
    "Hardware device identity",
  );
  if (
    !["revision", "app_version", "process_start_time"].every(
      (field) =>
        typeof summary.device_identity[field] === "string" &&
        summary.device_identity[field].length > 0,
    )
  ) {
    throw new Error("Hardware device identity is incomplete.");
  }
  if (
    summary.story_count !== liveStories.length ||
    summary.step_count !== stepCount ||
    summary.restore_count !== restoreCount ||
    summary.device_identity?.revision !== candidate.source.commit_sha ||
    summary.source_identity?.commit_sha !== candidate.source.commit_sha ||
    summary.source_identity?.tree_sha !== candidate.source.tree_sha ||
    summary.source_identity?.package_lock_sha256 !==
      candidate.source.package_lock.sha256 ||
    summary.source_identity?.paste_harness_sha256 !==
      candidate.source.paste_harness.sha256 ||
    summary.installed_package?.package_name !== candidate.package.name ||
    summary.installed_package?.package_version !== candidate.package.version ||
    summary.installed_package?.consumer_package_sha256 !==
      candidate.installation.package_json.sha256 ||
    summary.installed_package?.consumer_package_lock_sha256 !==
      candidate.installation.package_lock.sha256 ||
    summary.installed_package?.production_resolution_sha256 !==
      candidate.installation.production_resolution_sha256 ||
    summary.installed_package?.node_modules_tree_sha256 !==
      candidate.installation.node_modules_tree_sha256 ||
    summary.tool_listing?.tool_count !== 10
  ) {
    throw new Error("Hardware release summary counts or identities drifted.");
  }
  assertHash(summary.atx_preflight_sha256, "ATX preflight evidence");
  assertHash(summary.device_tests_sha256, "Device test evidence");
  assertHash(summary.finalization_sha256, "Finalization evidence");
  if (
    summary.finalization_sha256 !== sha256Canonical(finalization) ||
    summary.device_tests_sha256 !== sha256Canonical(deviceTests)
  ) {
    throw new Error("Hardware summary evidence hashes drifted.");
  }
  return Object.freeze({
    schema_version: 1,
    result: "pass",
    candidate_commit: candidate.source.commit_sha,
    run_id: summary.run_id,
    story_count: liveStories.length,
    step_count: stepCount,
    restore_count: restoreCount,
    records_sha256: sha256Canonical(records),
  });
}

export async function validateEvidenceDirectory({
  directory,
  candidate,
  candidateSha256,
  stories,
  plan,
}) {
  directory = resolve(directory);
  const directoryFacts = await stat(directory);
  if (!directoryFacts.isDirectory() || (directoryFacts.mode & 0o222) !== 0) {
    throw new Error("Hardware evidence directory is not immutable.");
  }
  const summary = JSON.parse(
    await readFile(join(directory, "summary.json"), "utf8"),
  );
  const liveStories = stories.filter((story) =>
    story.environments.includes("live"),
  );
  const records = await Promise.all(
    liveStories.map((story) =>
      readFile(join(directory, `${story.id}.json`), "utf8").then(JSON.parse),
    ),
  );
  const [finalization, deviceTests] = await Promise.all([
    readFile(join(directory, "finalization.json"), "utf8").then(JSON.parse),
    readFile(join(directory, "device-go-tests.json"), "utf8").then(JSON.parse),
  ]);
  const audit = validateHardwareReleaseEvidence({
    candidate,
    candidateSha256,
    stories,
    plan,
    summary,
    records,
    finalization,
    deviceTests,
  });

  const manifestPath = join(directory, "manifest.json");
  const sidecarPath = join(directory, "manifest.sha256");
  const [manifestFacts, sidecarFacts] = await Promise.all([
    stat(manifestPath),
    stat(sidecarPath),
  ]);
  if (
    !manifestFacts.isFile() ||
    !sidecarFacts.isFile() ||
    (manifestFacts.mode & 0o777) !== 0o400 ||
    (sidecarFacts.mode & 0o777) !== 0o400
  ) {
    throw new Error("Hardware evidence manifest is not immutable.");
  }
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256Bytes(manifestBytes);
  const sidecar = await readFile(sidecarPath, "utf8");
  if (sidecar !== `${manifestSha256}  manifest.json\n`) {
    throw new Error(
      "Hardware evidence manifest checksum did not match exactly.",
    );
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!isRecord(manifest) || !Array.isArray(manifest.files)) {
    throw new Error("Hardware evidence manifest was malformed.");
  }
  if (sha256Canonical(manifest.files) !== manifest.sha256) {
    throw new Error("Hardware evidence manifest content hash did not match.");
  }
  for (const file of manifest.files) {
    if (
      typeof file.path !== "string" ||
      file.path.startsWith("/") ||
      file.path.includes("..") ||
      file.path.includes("\\")
    ) {
      throw new Error("Hardware evidence manifest contains an unsafe path.");
    }
    const facts = await stat(join(directory, file.path));
    if (
      !facts.isFile() ||
      (facts.mode & 0o777) !== file.mode ||
      facts.size !== file.size_bytes
    ) {
      throw new Error(`Hardware evidence file ${file.path} metadata drifted.`);
    }
    if ((await sha256File(join(directory, file.path))) !== file.sha256) {
      throw new Error(`Hardware evidence file ${file.path} drifted.`);
    }
  }

  const expectedFiles = [
    ...manifest.files.map((file) => file.path),
    "manifest.json",
    "manifest.sha256",
  ].sort();
  for (const path of expectedFiles) {
    const raw = await readFile(join(directory, path));
    if (containsPrivateReleaseMaterial(raw.toString("utf8"))) {
      throw new Error(
        `Hardware evidence file ${path} contains private path, topology, or credential material.`,
      );
    }
  }
  const directoryManifest = await buildDirectoryManifest(directory);
  const actualFiles = directoryManifest.files.map((file) => file.path).sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    throw new Error("Hardware evidence directory contains unmanifested files.");
  }
  return Object.freeze({
    ...audit,
    directory_sha256: directoryManifest.sha256,
    file_count: directoryManifest.files.length,
  });
}

async function run() {
  const directory = process.argv[2];
  const candidatePath = process.argv[3];
  if (directory === undefined || candidatePath === undefined) {
    throw new Error(
      "Usage: node scripts/validate-hardware-release-evidence.mjs <evidence-directory> <candidate.json>",
    );
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidateBytes = await readFile(candidatePath);
  const candidateSha256 = sha256Bytes(candidateBytes);
  const candidate = validateReleaseCandidateManifest(
    JSON.parse(candidateBytes.toString("utf8")),
  );
  const { loadAcceptanceStories } = await import("../dist/stories/manifest.js");
  const stories = await loadAcceptanceStories(
    resolve(packageRoot, "dist/stories"),
  );
  const branchMatrix = JSON.parse(
    await readFile(resolve(packageRoot, "reports/branch-matrix.json"), "utf8"),
  );
  const storyE2e = JSON.parse(
    await readFile(resolve(packageRoot, "reports/story-e2e.json"), "utf8"),
  );
  const resolver = createExecutionEvidenceResolver({ branchMatrix, storyE2e });
  const plan = materializeLiveExecutionPlan(stories, resolver);
  const audit = await validateEvidenceDirectory({
    directory,
    candidate,
    candidateSha256,
    stories,
    plan,
  });
  process.stdout.write(`${JSON.stringify(audit)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run();
}
