import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDirectoryManifest,
  createExecutionEvidenceResolver,
  sha256Canonical,
  sha256File,
  validateReleaseCandidateManifest,
} from "./release-evidence.mjs";
import { materializeLiveExecutionPlan } from "./live-story-plan.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const PRIVATE_PATTERN =
  /(?:\/Users\/|[A-Za-z]:\\|(?:^|[^0-9])(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)\d{1,3}\.\d{1,3}\.\d{1,3}|JETKVM_PASSWORD|JETKVM_CREDENTIAL|BEGIN [A-Z ]+PRIVATE KEY)/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertPass(value, label) {
  if (!isRecord(value) || value.result !== "pass") {
    throw new Error(`${label} did not pass.`);
  }
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
  assertHash(record.baseline_before_sha256, `${story.id} baseline before`);
  assertHash(record.baseline_after_sha256, `${story.id} baseline after`);
  assertPass(record.baseline_comparison, `${story.id} baseline comparison`);
  assertHash(
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
    assertHash(result.evidence_sha256, `${story.id}/${step.id} evidence`);
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
    assertHash(
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
  stories,
  plan,
  summary,
  records,
}) {
  validateReleaseCandidateManifest(candidate);
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
  assertHash(summary.candidate_sha256, "Hardware candidate checksum");
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
  if (
    summary.story_count !== liveStories.length ||
    summary.step_count !== stepCount ||
    summary.restore_count !== restoreCount ||
    summary.device_identity?.revision !== candidate.source.commit_sha ||
    summary.installed_package?.package_name !== candidate.package.name ||
    summary.installed_package?.package_version !== candidate.package.version ||
    summary.tool_listing?.tool_count !== 10
  ) {
    throw new Error("Hardware release summary counts or identities drifted.");
  }
  assertHash(summary.atx_preflight_sha256, "ATX preflight evidence");
  assertHash(summary.device_tests_sha256, "Device test evidence");
  if (
    summary.transport_reconnect?.connect?.ok !== true ||
    summary.transport_reconnect?.release?.ok !== true
  ) {
    throw new Error("Transport reconnect proof did not pass.");
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
  stories,
  plan,
}) {
  directory = resolve(directory);
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
  const audit = validateHardwareReleaseEvidence({
    candidate,
    stories,
    plan,
    summary,
    records,
  });
  if (
    (await sha256File(join(directory, "manifest.json"))) !==
    (await readFile(join(directory, "manifest.sha256"), "utf8")).split(
      /\s+/u,
    )[0]
  ) {
    throw new Error("Hardware evidence manifest checksum did not match.");
  }
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
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
  const serialized = JSON.stringify({ summary, records, manifest });
  if (PRIVATE_PATTERN.test(serialized)) {
    throw new Error(
      "Hardware evidence contains private path, topology, or credential material.",
    );
  }
  const directoryManifest = await buildDirectoryManifest(directory);
  const expectedFiles = [
    ...manifest.files.map((file) => file.path),
    "manifest.json",
    "manifest.sha256",
  ].sort();
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
  const candidate = validateReleaseCandidateManifest(
    JSON.parse(await readFile(candidatePath, "utf8")),
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
    stories,
    plan,
  });
  process.stdout.write(`${JSON.stringify(audit)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run();
}
