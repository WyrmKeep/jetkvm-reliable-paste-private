import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDirectoryManifest,
  buildReleaseCandidateManifest,
  sha256Canonical,
  sha256File,
} from "./release-evidence.mjs";
import {
  containsPrivateReleaseMaterial,
  validateEvidenceDirectory,
  validateHardwareReleaseEvidence,
} from "./validate-hardware-release-evidence.mjs";

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);
const TREE = "c".repeat(40);

function candidate() {
  return buildReleaseCandidateManifest({
    packageName: "@wyrmkeep/jetkvm-mcp",
    packageVersion: "0.1.0",
    commitSha: COMMIT,
    treeSha: TREE,
    packageLockSha256: HASH,
    storyManifestSha256: HASH,
    storyCount: 24,
    schemasSha256: HASH,
    schemaCount: 21,
    pasteHarnessSha256: HASH,
    branchMatrixSha256: HASH,
    storyE2eSha256: HASH,
    controlledEvidenceSha256: HASH,
    nodeVersion: "v22.23.1",
    nodeExecutableName: "node",
    nodeExecutableSha256: HASH,
    platform: "darwin",
    architecture: "arm64",
    browserExecutableName: "Google Chrome",
    browserExecutableSha256: HASH,
    browserHeadless: false,
    browserChromiumSandbox: true,
    browserLaunchArgs: [],
    browserTargetUrlSha256: HASH,
    browserCredentialSource: "environment",
    browserManagedProfile: "ephemeral",
    artifactFilename: "candidate.tgz",
    artifactSizeBytes: 1,
    artifactSha256: HASH,
    consumerPackageJsonSha256: HASH,
    consumerPackageLockSha256: HASH,
    productionResolutionSha256: HASH,
    installationFiles: [
      {
        path: "@wyrmkeep/jetkvm-mcp/package.json",
        mode: 0o644,
        size_bytes: 1,
        sha256: HASH,
      },
    ],
    packageFiles: [
      { path: "package.json", mode: 0o644, size_bytes: 1, sha256: HASH },
    ],
  });
}

function fixture() {
  const story = {
    id: "live-story",
    title: "Live story",
    environments: ["live"],
    preconditions: [{ id: "safe" }],
    steps: [{ id: "hardware-step" }, { id: "linked-step" }],
    restore: [{ id: "release-input" }],
  };
  const plan = {
    "live-story": {
      steps: {
        "hardware-step": { mode: "hardware" },
        "linked-step": { mode: "linked", assertion_ids: ["focused:one"] },
      },
    },
  };
  const runId = "run-one";
  const baselineBefore = { state: "safe", phase: "before" };
  const baselineAfter = { state: "safe", phase: "after" };
  const baselineEvidence = { before: baselineBefore, after: baselineAfter };
  const structured = { ok: true, tool: "jetkvm_display_status" };
  const hardwareEvidence = {
    tool_evidence: {
      structured,
      structured_sha256: sha256Canonical(structured),
    },
  };
  const linkedEvidence = { assertion_id: "focused:one" };
  const restoreEvidence = { held_input_released: true };
  const record = {
    schema_version: 1,
    run_id: runId,
    story_id: story.id,
    title: story.title,
    result: "pass",
    baseline_before: baselineBefore,
    baseline_after: baselineAfter,
    baseline_before_sha256: sha256Canonical(baselineBefore),
    baseline_after_sha256: sha256Canonical(baselineAfter),
    baseline_comparison: {
      result: "pass",
      evidence: baselineEvidence,
      evidence_sha256: sha256Canonical(baselineEvidence),
    },
    steps: [
      {
        step_id: "hardware-step",
        mode: "hardware",
        result: "pass",
        duration_ms: 1,
        evidence: hardwareEvidence,
        evidence_sha256: sha256Canonical(hardwareEvidence),
      },
      {
        step_id: "linked-step",
        mode: "linked",
        result: "pass",
        duration_ms: 0,
        evidence: linkedEvidence,
        evidence_sha256: sha256Canonical(linkedEvidence),
        assertion_ids: ["focused:one"],
      },
    ],
    restores: [
      {
        restore_id: "release-input",
        result: "pass",
        evidence: restoreEvidence,
        evidence_sha256: sha256Canonical(restoreEvidence),
      },
    ],
    failure_count: 0,
  };
  const deviceTests = {
    ok: true,
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:01:00.000Z",
    command: {
      executable: "./dev_deploy.sh",
      args: [
        "-r",
        "<configured-target>",
        "--run-go-tests-only",
        "--device-tests-archive",
        "<reviewed-device-tests>",
        "--device-tests-sha256",
        HASH,
      ],
    },
    before: {
      revision: COMMIT,
      appVersion: "0.5.5",
      processStartTime: "1000.5",
    },
    after: {
      revision: COMMIT,
      appVersion: "0.5.5",
      processStartTime: "1000.5",
    },
    child: { code: 0, signal: null },
  };
  const finalization = {
    schema_version: 1,
    kind: "jetkvm-mcp-hardware-finalization",
    result: "pass",
    completed_at: "2026-07-14T00:02:00.000Z",
    release_and_baseline_evidence_sha256: HASH,
    safe_baseline_proven: true,
    manual_recovery_required: false,
    clients: [
      {
        label: "replacement",
        closed: true,
        stderr: { byte_length: 0, sha256: HASH },
      },
      {
        label: "initial",
        closed: true,
        stderr: { byte_length: 0, sha256: HASH },
      },
    ],
    failure_count: 0,
    failure_stages: [],
  };
  const connectRequest = {
    request_id: "fresh-connect-request",
    takeover: false,
    timeout_ms: 60_000,
  };
  const connectStructured = {
    ok: true,
    tool: "jetkvm_session_connect",
    session_id: "fresh-session",
    session_generation: 9,
    result: {
      request_id: connectRequest.request_id,
      outcome: "applied",
      verification: "device_state_verified",
      safe_to_retry: false,
      required_next_step: "none",
      state: "ready",
    },
  };
  const releaseRequest = {
    session_id: "fresh-session",
    session_generation: 9,
    request_id: "fresh-release-request",
    timeout_ms: 30_000,
  };
  const releaseStructured = {
    ok: true,
    tool: "jetkvm_input_release",
    session_id: "fresh-session",
    session_generation: 9,
    result: {
      request_id: releaseRequest.request_id,
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
  const boundCall = (request, structured) => {
    const sanitizedStructured = structuredClone(structured);
    delete sanitizedStructured.session_id;
    delete sanitizedStructured.result.request_id;
    const requestPreimage = Object.hasOwn(request, "session_id")
      ? {
          session_id_sha256: sha256Canonical(request.session_id),
          session_generation: request.session_generation,
          request_id_sha256: sha256Canonical(request.request_id),
          timeout_ms: request.timeout_ms,
        }
      : {
          request_id_sha256: sha256Canonical(request.request_id),
          takeover: request.takeover,
          timeout_ms: request.timeout_ms,
        };
    const response = {
      structured: sanitizedStructured,
      structured_sha256: sha256Canonical(sanitizedStructured),
    };
    const correlation = {
      request_id_sha256: sha256Canonical(structured.result.request_id),
      session_id_sha256: sha256Canonical(structured.session_id),
      session_generation: structured.session_generation,
    };
    return {
      request: requestPreimage,
      request_sha256: sha256Canonical(requestPreimage),
      response,
      response_sha256: sha256Canonical(response),
      correlation,
      correlation_sha256: sha256Canonical(correlation),
    };
  };
  const transportReconnect = {
    tool_listing: {
      tool_count: 10,
      tool_names_sha256: HASH,
    },
    connect: boundCall(connectRequest, connectStructured),
    release: boundCall(releaseRequest, releaseStructured),
  };
  const sshEvidence = {
    command: "ssh",
    exit_code: 0,
    signal: null,
    timed_out: false,
    stdout_bytes: 0,
    stdout_sha256: HASH,
    stderr_bytes: 0,
    stderr_sha256: HASH,
  };
  const summary = {
    schema_version: 1,
    kind: "jetkvm-mcp-hardware-release-evidence",
    run_id: runId,
    candidate_sha256: HASH,
    candidate_commit: COMMIT,
    source_identity: {
      commit_sha: COMMIT,
      tree_sha: TREE,
      package_lock_sha256: HASH,
      paste_harness_sha256: HASH,
    },
    result: "pass",
    story_count: 1,
    step_count: 2,
    restore_count: 1,
    installed_package: {
      package_name: "@wyrmkeep/jetkvm-mcp",
      package_version: "0.1.0",
      consumer_package_sha256: HASH,
      consumer_package_lock_sha256: HASH,
      production_resolution_sha256: HASH,
      node_modules_tree_sha256:
        candidate().installation.node_modules_tree_sha256,
    },
    device_identity: {
      revision: COMMIT,
      app_version: "0.4.0",
      process_start_time: "1.717e+09",
    },
    deployment: {
      deployment: {
        upload: { ...sshEvidence },
        staged_verification: { ...sshEvidence },
        reboot: { ...sshEvidence },
        staged_binary_sha256: HASH,
      },
      source_identity: {
        commit_sha: COMMIT,
        tree_sha: TREE,
        package_lock_sha256: HASH,
        paste_harness_sha256: HASH,
      },
      release_artifact: {
        size_bytes: 1,
        sha256: HASH,
        device_tests_sha256: HASH,
        provenance_sha256: HASH,
        source_commit: COMMIT,
        builder: {
          repository: "WyrmKeep/jetkvm-reliable-paste-private",
          workflow_ref:
            "WyrmKeep/jetkvm-reliable-paste-private/.github/workflows/build.yml@refs/heads/main",
          run_id: "123456",
          run_attempt: 1,
        },
        go_version_report_sha256: HASH,
      },
      local_binary_sha256: HASH,
      installed_binary_sha256: HASH,
      staged_update_absent: true,
    },
    tool_listing: { tool_count: 10 },
    transport_reconnect: transportReconnect,
    atx_preflight_sha256: HASH,
    device_tests_sha256: sha256Canonical(deviceTests),
    finalization_sha256: sha256Canonical(finalization),
  };
  return { story, plan, record, summary, deviceTests, finalization };
}
async function evidenceDirectory(extraFile) {
  const evidence = fixture();
  const directory = await mkdtemp(join(tmpdir(), "jetkvm-evidence-test-"));
  const jsonFiles = {
    "summary.json": evidence.summary,
    [`${evidence.story.id}.json`]: evidence.record,
    "finalization.json": evidence.finalization,
    "device-go-tests.json": evidence.deviceTests,
  };
  for (const [name, value] of Object.entries(jsonFiles)) {
    await writeFile(
      join(directory, name),
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
  }
  if (extraFile !== undefined) {
    await writeFile(join(directory, extraFile.name), extraFile.content, "utf8");
  }
  const writablePayload = await buildDirectoryManifest(directory);
  for (const file of writablePayload.files) {
    await chmod(join(directory, file.path), 0o400);
  }
  const payload = await buildDirectoryManifest(directory);
  const manifest = {
    schema_version: 1,
    files: payload.files,
    sha256: payload.sha256,
  };
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const manifestSha256 = await sha256File(join(directory, "manifest.json"));
  await writeFile(
    join(directory, "manifest.sha256"),
    `${manifestSha256}  manifest.json\n`,
    "utf8",
  );
  await chmod(join(directory, "manifest.json"), 0o400);
  await chmod(join(directory, "manifest.sha256"), 0o400);
  await chmod(directory, 0o500);
  return { directory, evidence };
}

test("accepts complete canonical hardware evidence", () => {
  const { story, plan, record, summary, finalization, deviceTests } = fixture();
  const audit = validateHardwareReleaseEvidence({
    candidate: candidate(),
    candidateSha256: summary.candidate_sha256,
    stories: [story],
    plan,
    summary,
    records: [record],
    finalization,
    deviceTests,
  });
  assert.equal(audit.result, "pass");
  assert.equal(audit.step_count, 2);
});

test("fails closed without fresh-transport producer-zero evidence", () => {
  const evidence = fixture();
  const summary = structuredClone(evidence.summary);
  delete summary.transport_reconnect;
  assert.throws(
    () =>
      validateHardwareReleaseEvidence({
        candidate: candidate(),
        candidateSha256: summary.candidate_sha256,
        stories: [evidence.story],
        plan: evidence.plan,
        summary,
        records: [evidence.record],
        finalization: evidence.finalization,
        deviceTests: evidence.deviceTests,
      }),
    /fresh transport evidence/u,
  );
});

test("rejects drifted fresh-transport correlation, zero state, or privacy", () => {
  const evidence = fixture();
  const cases = [
    (proof) => {
      proof.release.correlation.session_id_sha256 = "e".repeat(64);
      proof.release.correlation_sha256 = sha256Canonical(
        proof.release.correlation,
      );
    },
    (proof) => {
      proof.release.response.structured.result.pointer_zero = false;
      proof.release.response.structured_sha256 = sha256Canonical(
        proof.release.response.structured,
      );
      proof.release.response_sha256 = sha256Canonical(proof.release.response);
    },
    (proof) => {
      proof.connect.response.structured.session_id = "raw-session-leak";
      proof.connect.response.structured_sha256 = sha256Canonical(
        proof.connect.response.structured,
      );
      proof.connect.response_sha256 = sha256Canonical(proof.connect.response);
    },
  ];
  for (const mutate of cases) {
    const summary = structuredClone(evidence.summary);
    mutate(summary.transport_reconnect);
    assert.throws(() =>
      validateHardwareReleaseEvidence({
        candidate: candidate(),
        candidateSha256: summary.candidate_sha256,
        stories: [evidence.story],
        plan: evidence.plan,
        summary,
        records: [evidence.record],
        finalization: evidence.finalization,
        deviceTests: evidence.deviceTests,
      }),
    );
  }
});

test("rejects incomplete or drifted promoted device deployment evidence", () => {
  const evidence = fixture();
  const cases = [
    (deployment) => {
      delete deployment.installed_binary_sha256;
    },
    (deployment) => {
      deployment.local_binary_sha256 = "e".repeat(64);
    },
    (deployment) => {
      deployment.source_identity.tree_sha = "e".repeat(40);
    },
    (deployment) => {
      deployment.staged_update_absent = false;
    },
    (deployment) => {
      deployment.release_artifact.provenance_sha256 = "invalid";
    },
  ];
  for (const mutate of cases) {
    const summary = structuredClone(evidence.summary);
    mutate(summary.deployment);
    assert.throws(() =>
      validateHardwareReleaseEvidence({
        candidate: candidate(),
        candidateSha256: summary.candidate_sha256,
        stories: [evidence.story],
        plan: evidence.plan,
        summary,
        records: [evidence.record],
        finalization: evidence.finalization,
        deviceTests: evidence.deviceTests,
      }),
    );
  }
});

test("binds the summary to the exact validated candidate bytes", () => {
  const { story, plan, record, summary, finalization, deviceTests } = fixture();
  assert.throws(
    () =>
      validateHardwareReleaseEvidence({
        candidate: candidate(),
        candidateSha256: "f".repeat(64),
        stories: [story],
        plan,
        summary,
        records: [record],
        finalization,
        deviceTests,
      }),
    /did not bind the validated candidate bytes/u,
  );
});

test("fails closed on a missing step or restore", () => {
  const { story, plan, record, summary, finalization, deviceTests } = fixture();
  const incomplete = structuredClone(record);
  incomplete.steps.pop();
  assert.throws(
    () =>
      validateHardwareReleaseEvidence({
        candidate: candidate(),
        candidateSha256: summary.candidate_sha256,
        stories: [story],
        plan,
        summary,
        records: [incomplete],
        finalization,
        deviceTests,
      }),
    /incomplete step coverage/u,
  );
});

test("fails closed on finalization or device-test evidence drift", () => {
  const evidence = fixture();
  for (const [field, mutate] of [
    ["finalization", (value) => (value.safe_baseline_proven = false)],
    ["deviceTests", (value) => (value.child.code = 1)],
  ]) {
    const changed = structuredClone(evidence[field]);
    mutate(changed);
    assert.throws(() =>
      validateHardwareReleaseEvidence({
        candidate: candidate(),
        candidateSha256: evidence.summary.candidate_sha256,
        stories: [evidence.story],
        plan: evidence.plan,
        summary: evidence.summary,
        records: [evidence.record],
        finalization:
          field === "finalization" ? changed : evidence.finalization,
        deviceTests: field === "deviceTests" ? changed : evidence.deviceTests,
      }),
    );
  }
});

test("binds executed device tests to the reviewed CI archive", () => {
  const evidence = fixture();
  const changed = structuredClone(evidence.deviceTests);
  changed.command.args[6] = "e".repeat(64);
  const summary = {
    ...evidence.summary,
    device_tests_sha256: sha256Canonical(changed),
  };
  assert.throws(
    () =>
      validateHardwareReleaseEvidence({
        candidate: candidate(),
        candidateSha256: summary.candidate_sha256,
        stories: [evidence.story],
        plan: evidence.plan,
        summary,
        records: [evidence.record],
        finalization: evidence.finalization,
        deviceTests: changed,
      }),
    /reviewed CI archive/u,
  );
});

test("detects complete private IPv4 address families without partial matching", () => {
  for (const address of [
    "10.2.3.4",
    "127.0.0.1",
    "169.254.8.9",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.110",
  ]) {
    assert.equal(containsPrivateReleaseMaterial(`target=${address}`), true);
  }
  assert.equal(containsPrivateReleaseMaterial("target=172.32.0.1"), false);
  assert.equal(containsPrivateReleaseMaterial("target=8.8.8.8"), false);
});

test("validates exact checksum sidecars and scans every raw manifested file", async () => {
  const valid = await evidenceDirectory();
  try {
    const audit = await validateEvidenceDirectory({
      directory: valid.directory,
      candidate: candidate(),
      candidateSha256: valid.evidence.summary.candidate_sha256,
      stories: [valid.evidence.story],
      plan: valid.evidence.plan,
    });
    assert.equal(audit.result, "pass");
    await chmod(valid.directory, 0o700);
    await assert.rejects(
      validateEvidenceDirectory({
        directory: valid.directory,
        candidate: candidate(),
        candidateSha256: valid.evidence.summary.candidate_sha256,
        stories: [valid.evidence.story],
        plan: valid.evidence.plan,
      }),
      /not immutable/u,
    );
    const checksumPath = join(valid.directory, "manifest.sha256");
    const checksum = await sha256File(join(valid.directory, "manifest.json"));
    await chmod(checksumPath, 0o600);
    await writeFile(
      checksumPath,
      `${checksum}  manifest.json\n${checksum}  extra.json\n`,
      "utf8",
    );
    await chmod(checksumPath, 0o400);
    await chmod(valid.directory, 0o500);
    await assert.rejects(
      validateEvidenceDirectory({
        directory: valid.directory,
        candidate: candidate(),
        candidateSha256: valid.evidence.summary.candidate_sha256,
        stories: [valid.evidence.story],
        plan: valid.evidence.plan,
      }),
      /checksum did not match exactly/u,
    );
  } finally {
    await chmod(valid.directory, 0o700);
    await rm(valid.directory, { recursive: true, force: true });
  }

  const privateEvidence = await evidenceDirectory({
    name: "raw.log",
    content: "unparsed target=10.2.3.4\n",
  });
  try {
    await assert.rejects(
      validateEvidenceDirectory({
        directory: privateEvidence.directory,
        candidate: candidate(),
        candidateSha256: privateEvidence.evidence.summary.candidate_sha256,
        stories: [privateEvidence.evidence.story],
        plan: privateEvidence.evidence.plan,
      }),
      /raw\.log contains private path, topology, or credential material/u,
    );
  } finally {
    await chmod(privateEvidence.directory, 0o700);
    await rm(privateEvidence.directory, { recursive: true, force: true });
  }
});
