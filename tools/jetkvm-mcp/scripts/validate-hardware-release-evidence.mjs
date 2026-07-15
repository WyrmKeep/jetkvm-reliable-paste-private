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

function assertNoRawTransportIdentifiers(value, label) {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertNoRawTransportIdentifiers(child, `${label}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "request_id" || key === "session_id") {
      throw new Error(`${label} exposed a raw transport identifier.`);
    }
    assertNoRawTransportIdentifiers(child, `${label}.${key}`);
  }
}

function validateFreshTransportEvidence(proof) {
  if (!isRecord(proof)) {
    throw new Error("fresh transport evidence is missing or malformed.");
  }
  assertExactKeys(
    proof,
    ["tool_listing", "connect", "release"],
    "fresh transport evidence",
  );
  assertExactKeys(
    proof.tool_listing,
    ["tool_count", "tool_names_sha256"],
    "fresh transport tool listing",
  );
  if (proof.tool_listing.tool_count !== 10) {
    throw new Error("fresh transport did not expose exactly ten tools.");
  }
  assertHash(
    proof.tool_listing.tool_names_sha256,
    "fresh transport tool listing",
  );

  const validateCall = (call, kind) => {
    assertExactKeys(
      call,
      [
        "request",
        "request_sha256",
        "response",
        "response_sha256",
        "correlation",
        "correlation_sha256",
      ],
      `fresh transport ${kind}`,
    );
    assertEvidencePreimage(
      call.request,
      call.request_sha256,
      `fresh transport ${kind} request`,
    );
    assertEvidencePreimage(
      call.response,
      call.response_sha256,
      `fresh transport ${kind} response`,
    );
    assertEvidencePreimage(
      call.correlation,
      call.correlation_sha256,
      `fresh transport ${kind} correlation`,
    );
    assertExactKeys(
      call.correlation,
      ["request_id_sha256", "session_id_sha256", "session_generation"],
      `fresh transport ${kind} correlation`,
    );
    assertHash(
      call.correlation.request_id_sha256,
      `fresh transport ${kind} request correlation`,
    );
    assertHash(
      call.correlation.session_id_sha256,
      `fresh transport ${kind} session correlation`,
    );
    if (!Number.isSafeInteger(call.correlation.session_generation)) {
      throw new Error(`fresh transport ${kind} generation is malformed.`);
    }
    const structured = call.response.structured;
    assertNoRawTransportIdentifiers(
      structured,
      `fresh transport ${kind} response`,
    );
    const result = isRecord(structured?.result) ? structured.result : undefined;
    if (
      !isRecord(structured) ||
      structured.ok !== true ||
      structured.tool !==
        (kind === "connect"
          ? "jetkvm_session_connect"
          : "jetkvm_input_release") ||
      structured.session_generation !== call.correlation.session_generation ||
      !isRecord(result) ||
      !["applied", "already_applied"].includes(result.outcome) ||
      result.verification !== "device_state_verified" ||
      result.safe_to_retry !== false ||
      result.required_next_step !== "none"
    ) {
      throw new Error(
        `fresh transport ${kind} did not persist a definitive response.`,
      );
    }
    return result;
  };

  const connectResult = validateCall(proof.connect, "connect");
  const releaseResult = validateCall(proof.release, "release");
  assertExactKeys(
    proof.connect.request,
    ["request_id_sha256", "takeover", "timeout_ms"],
    "fresh transport connect request",
  );
  assertExactKeys(
    proof.release.request,
    [
      "session_id_sha256",
      "session_generation",
      "request_id_sha256",
      "timeout_ms",
    ],
    "fresh transport release request",
  );
  if (
    proof.connect.request.request_id_sha256 !==
      proof.connect.correlation.request_id_sha256 ||
    proof.connect.request.takeover !== false ||
    proof.connect.request.timeout_ms !== 60_000 ||
    connectResult.state !== "ready" ||
    proof.release.request.request_id_sha256 !==
      proof.release.correlation.request_id_sha256 ||
    proof.release.request.session_id_sha256 !==
      proof.release.correlation.session_id_sha256 ||
    proof.release.request.session_id_sha256 !==
      proof.connect.correlation.session_id_sha256 ||
    proof.release.request.session_generation !==
      proof.release.correlation.session_generation ||
    proof.release.request.session_generation !==
      proof.connect.correlation.session_generation ||
    proof.release.request.timeout_ms !== 30_000
  ) {
    throw new Error("fresh transport request/response correlation drifted.");
  }
  if (
    releaseResult.mutation_gate_closed !== true ||
    releaseResult.deferred_producers_joined !== true ||
    !["cancelled", "inactive"].includes(releaseResult.paste_terminal) ||
    releaseResult.ordinary_leases_zero !== true ||
    releaseResult.keyboard_zero !== true ||
    releaseResult.pointer_zero !== true ||
    releaseResult.generation_drained !== true
  ) {
    throw new Error(
      "fresh transport release did not prove producer-zero state.",
    );
  }
}

function validateSuccessfulSshEvidence(value, label) {
  assertExactKeys(
    value,
    [
      "command",
      "exit_code",
      "signal",
      "timed_out",
      "stdout_bytes",
      "stdout_sha256",
      "stderr_bytes",
      "stderr_sha256",
    ],
    label,
  );
  if (
    typeof value.command !== "string" ||
    value.command.length === 0 ||
    value.exit_code !== 0 ||
    value.signal !== null ||
    value.timed_out !== false ||
    !Number.isSafeInteger(value.stdout_bytes) ||
    value.stdout_bytes < 0 ||
    !Number.isSafeInteger(value.stderr_bytes) ||
    value.stderr_bytes < 0
  ) {
    throw new Error(`${label} did not complete successfully.`);
  }
  assertHash(value.stdout_sha256, `${label} stdout`);
  assertHash(value.stderr_sha256, `${label} stderr`);
}

function validateDeploymentEvidence(deployment, summarySource, candidate) {
  assertExactKeys(
    deployment,
    [
      "deployment",
      "source_identity",
      "release_artifact",
      "local_binary_sha256",
      "installed_binary_sha256",
      "staged_update_absent",
    ],
    "Hardware deployment evidence",
  );
  assertExactKeys(
    deployment.deployment,
    ["upload", "staged_verification", "reboot", "staged_binary_sha256"],
    "Hardware deployment operation",
  );
  for (const field of ["upload", "staged_verification", "reboot"]) {
    validateSuccessfulSshEvidence(
      deployment.deployment[field],
      `Hardware deployment ${field}`,
    );
  }
  assertExactKeys(
    summarySource,
    ["commit_sha", "tree_sha", "package_lock_sha256", "paste_harness_sha256"],
    "Hardware source identity",
  );
  assertExactKeys(
    deployment.source_identity,
    ["commit_sha", "tree_sha", "package_lock_sha256", "paste_harness_sha256"],
    "Hardware deployment source identity",
  );
  if (
    sha256Canonical(deployment.source_identity) !==
      sha256Canonical(summarySource) ||
    summarySource.commit_sha !== candidate.source.commit_sha ||
    summarySource.tree_sha !== candidate.source.tree_sha ||
    summarySource.package_lock_sha256 !==
      candidate.source.package_lock.sha256 ||
    summarySource.paste_harness_sha256 !== candidate.source.paste_harness.sha256
  ) {
    throw new Error("Hardware deployment source identity drifted.");
  }
  const artifact = deployment.release_artifact;
  assertExactKeys(
    artifact,
    [
      "size_bytes",
      "sha256",
      "device_tests_sha256",
      "provenance_sha256",
      "source_commit",
      "builder",
      "go_version_report_sha256",
    ],
    "Hardware release artifact",
  );
  assertExactKeys(
    artifact.builder,
    ["repository", "workflow_ref", "run_id", "run_attempt"],
    "Hardware release artifact builder",
  );
  for (const [value, label] of [
    [artifact.sha256, "Hardware release artifact"],
    [artifact.device_tests_sha256, "Reviewed device test archive"],
    [artifact.provenance_sha256, "Device release provenance"],
    [artifact.go_version_report_sha256, "Go version report"],
    [deployment.local_binary_sha256, "Local promoted device binary"],
    [deployment.installed_binary_sha256, "Installed device binary"],
    [deployment.deployment.staged_binary_sha256, "Staged device binary"],
  ]) {
    assertHash(value, label);
  }
  const trustedRepository = "WyrmKeep/jetkvm-reliable-paste-private";
  if (
    !Number.isSafeInteger(artifact.size_bytes) ||
    artifact.size_bytes < 1 ||
    artifact.source_commit !== candidate.source.commit_sha ||
    artifact.builder.repository !== trustedRepository ||
    typeof artifact.builder.workflow_ref !== "string" ||
    !artifact.builder.workflow_ref.startsWith(
      `${trustedRepository}/.github/workflows/build.yml@`,
    ) ||
    typeof artifact.builder.run_id !== "string" ||
    !/^[1-9][0-9]*$/u.test(artifact.builder.run_id) ||
    !Number.isSafeInteger(artifact.builder.run_attempt) ||
    artifact.builder.run_attempt < 1 ||
    artifact.sha256 !== deployment.local_binary_sha256 ||
    artifact.sha256 !== deployment.installed_binary_sha256 ||
    artifact.sha256 !== deployment.deployment.staged_binary_sha256 ||
    deployment.staged_update_absent !== true
  ) {
    throw new Error(
      "Hardware deployment did not bind the reviewed promoted binary.",
    );
  }
  return artifact.device_tests_sha256;
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
  validateFreshTransportEvidence(summary.transport_reconnect);
  const reviewedDeviceTestsSha256 = validateDeploymentEvidence(
    summary.deployment,
    summary.source_identity,
    candidate,
  );
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
