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
import {
  ATX_UNAVAILABLE_EXCEPTION_CODE,
  deriveHardwareValidationException,
  validateHardwareValidation,
} from "./hardware-validation-profile.mjs";
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

function validateRecord(record, story, storyPlan, runId, excludedStepKeys) {
  assertExactKeys(
    record,
    [
      "schema_version",
      "run_id",
      "story_id",
      "title",
      "result",
      "started_at",
      "completed_at",
      "precondition_ids",
      "baseline_before",
      "baseline_after",
      "baseline_before_sha256",
      "baseline_after_sha256",
      "baseline_comparison",
      "steps",
      "restores",
      "failure_count",
    ],
    `Hardware record ${story.id}`,
  );
  if (
    record.schema_version !== 1 ||
    record.run_id !== runId ||
    record.story_id !== story.id ||
    record.title !== story.title ||
    !Number.isFinite(Date.parse(record.started_at)) ||
    !Number.isFinite(Date.parse(record.completed_at)) ||
    sha256Canonical(record.precondition_ids) !==
      sha256Canonical(story.preconditions.map((condition) => condition.id))
  ) {
    throw new Error(`Hardware record ${story.id} has invalid identity.`);
  }
  const expectedExcludedCount = story.steps.filter((step) =>
    excludedStepKeys.has(`${story.id}\0${step.id}`),
  ).length;
  const expectedResult =
    expectedExcludedCount === 0 ? "pass" : "pass_with_exception";
  if (record.result !== expectedResult) {
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
  assertExactKeys(
    record.baseline_comparison,
    ["result", "evidence", "evidence_sha256"],
    `${story.id} baseline comparison`,
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
  let executedStepCount = 0;
  let excludedStepCount = 0;
  record.steps.forEach((result, index) => {
    const step = story.steps[index];
    const assignment = storyPlan.steps[step.id];
    const excluded = excludedStepKeys.has(`${story.id}\0${step.id}`);
    if (excluded) {
      assertExactKeys(
        result,
        ["step_id", "mode", "requires_atx_wiring", "result", "exception_code"],
        `Excluded hardware step ${story.id}/${step.id}`,
      );
      if (
        result.step_id !== step.id ||
        result.mode !== assignment.mode ||
        result.requires_atx_wiring !== true ||
        result.result !== "excluded" ||
        result.exception_code !== ATX_UNAVAILABLE_EXCEPTION_CODE
      ) {
        throw new Error(
          `Hardware step ${story.id}/${step.id} has invalid exception evidence.`,
        );
      }
      excludedStepCount += 1;
      return;
    }
    assertExactKeys(
      result,
      [
        "step_id",
        "mode",
        "requires_atx_wiring",
        "result",
        "started_at",
        "duration_ms",
        "evidence",
        "evidence_sha256",
        ...(assignment.assertion_ids === undefined ? [] : ["assertion_ids"]),
      ],
      `Hardware step ${story.id}/${step.id}`,
    );
    if (
      result.step_id !== step.id ||
      result.mode !== assignment.mode ||
      result.requires_atx_wiring !== assignment.requires_atx_wiring ||
      result.result !== "pass" ||
      !Number.isFinite(Date.parse(result.started_at)) ||
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
    if (
      assignment.assertion_ids !== undefined &&
      sha256Canonical(result.assertion_ids) !==
        sha256Canonical(assignment.assertion_ids)
    ) {
      throw new Error(
        `Hardware step ${story.id}/${step.id} assertion IDs drifted.`,
      );
    }
    executedStepCount += 1;
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
    assertExactKeys(
      result,
      ["restore_id", "result", "evidence", "evidence_sha256"],
      `Hardware restore ${story.id}/${restore.id}`,
    );
    if (result.restore_id !== restore.id || result.result !== "pass") {
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
  return Object.freeze({ executedStepCount, excludedStepCount });
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
  hardwareException = null,
}) {
  validateReleaseCandidateManifest(candidate);
  const candidateHardwareValidation = validateHardwareValidation(
    candidate.hardware_validation,
  );
  validateFinalization(finalization);
  validateDeviceGoTestEvidence(deviceTests);
  assertExactKeys(
    summary,
    [
      "schema_version",
      "kind",
      "run_id",
      "candidate_sha256",
      "candidate_commit",
      "source_identity",
      "hardware_validation",
      "result",
      "story_count",
      "step_count",
      "executed_step_count",
      "excluded_step_count",
      "restore_count",
      "installed_package",
      "installation",
      "device_identity",
      "device_tests_sha256",
      "deployment",
      "tool_listing",
      "transport_reconnect",
      "hardware_exception_sha256",
      "atx_preflight_sha256",
      "finalization_sha256",
      "mcp_stderr",
    ],
    "Hardware release summary",
  );
  const summaryHardwareValidation = validateHardwareValidation(
    summary.hardware_validation,
  );
  const expectedHardwareException = deriveHardwareValidationException({
    stories,
    plan,
    hardwareValidation: candidateHardwareValidation,
  });
  const expectedSummaryResult =
    expectedHardwareException === null ? "pass" : "pass_with_exception";
  if (
    summary.schema_version !== 2 ||
    summary.kind !== "jetkvm-mcp-hardware-release-evidence" ||
    summary.result !== expectedSummaryResult ||
    typeof summary.run_id !== "string" ||
    summary.run_id.length === 0 ||
    summary.candidate_commit !== candidate.source.commit_sha ||
    sha256Canonical(summaryHardwareValidation) !==
      sha256Canonical(candidateHardwareValidation)
  ) {
    throw new Error("Hardware release summary did not pass exactly.");
  }
  if (expectedHardwareException === null) {
    if (
      hardwareException !== null ||
      summary.hardware_exception_sha256 !== null
    ) {
      throw new Error(
        "Full hardware validation must not contain an ATX exception.",
      );
    }
    assertHash(summary.atx_preflight_sha256, "ATX preflight evidence");
  } else {
    if (
      !isRecord(hardwareException) ||
      sha256Canonical(hardwareException) !==
        sha256Canonical(expectedHardwareException) ||
      summary.hardware_exception_sha256 !==
        sha256Canonical(expectedHardwareException) ||
      summary.atx_preflight_sha256 !== null
    ) {
      throw new Error(
        "ATX-unavailable exception evidence did not match the canonical plan.",
      );
    }
  }
  const excludedStepKeys = new Set(
    (expectedHardwareException?.excluded_steps ?? []).map(
      (step) => `${step.story_id}\0${step.step_id}`,
    ),
  );
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
  let executedStepCount = 0;
  let excludedStepCount = 0;
  liveStories.forEach((story, index) => {
    const record = records[index];
    if (record.story_id !== story.id) {
      throw new Error("Hardware live stories are not in canonical order.");
    }
    const counts = validateRecord(
      record,
      story,
      plan[story.id],
      summary.run_id,
      excludedStepKeys,
    );
    executedStepCount += counts.executedStepCount;
    excludedStepCount += counts.excludedStepCount;
  });
  const stepCount = executedStepCount + excludedStepCount;
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
  assertExactKeys(
    summary.mcp_stderr,
    ["replacement", "initial"],
    "Hardware summary MCP stderr",
  );
  for (const client of finalization.clients) {
    if (
      sha256Canonical(summary.mcp_stderr[client.label]) !==
      sha256Canonical(client.stderr)
    ) {
      throw new Error("Hardware summary MCP stderr evidence drifted.");
    }
  }
  if (
    !isRecord(summary.installation) ||
    summary.story_count !== liveStories.length ||
    summary.step_count !== stepCount ||
    summary.executed_step_count !== executedStepCount ||
    summary.excluded_step_count !== excludedStepCount ||
    excludedStepCount !== excludedStepKeys.size ||
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
    result: expectedSummaryResult,
    hardware_validation: candidateHardwareValidation,
    candidate_commit: candidate.source.commit_sha,
    run_id: summary.run_id,
    story_count: liveStories.length,
    step_count: stepCount,
    executed_step_count: executedStepCount,
    excluded_step_count: excludedStepCount,
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
  const hardwareValidation = validateHardwareValidation(
    candidate.hardware_validation,
  );
  const hardwareException =
    hardwareValidation.profile === "atx_unavailable"
      ? JSON.parse(
          await readFile(join(directory, "hardware-exception.json"), "utf8"),
        )
      : null;
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
    hardwareException,
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
  assertExactKeys(
    manifest,
    ["schema_version", "files", "sha256"],
    "Hardware evidence manifest",
  );
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("Hardware evidence manifest was malformed.");
  }
  if (sha256Canonical(manifest.files) !== manifest.sha256) {
    throw new Error("Hardware evidence manifest content hash did not match.");
  }
  const expectedPayloadFiles = [
    "summary.json",
    ...liveStories.map((story) => `${story.id}.json`),
    "finalization.json",
    "device-go-tests.json",
    ...(hardwareValidation.profile === "atx_unavailable"
      ? ["hardware-exception.json"]
      : []),
  ].sort();
  const manifestedPayloadFiles = manifest.files.map((file) => file.path).sort();
  if (
    manifestedPayloadFiles.length !== expectedPayloadFiles.length ||
    manifestedPayloadFiles.some(
      (file, index) => file !== expectedPayloadFiles[index],
    )
  ) {
    throw new Error(
      "Hardware evidence manifest does not match the profile inventory.",
    );
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
