import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleaseCandidateManifest,
  sha256Canonical,
} from "./release-evidence.mjs";
import { validateHardwareReleaseEvidence } from "./validate-hardware-release-evidence.mjs";

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
  const record = {
    schema_version: 1,
    run_id: runId,
    story_id: story.id,
    title: story.title,
    result: "pass",
    baseline_before_sha256: HASH,
    baseline_after_sha256: HASH,
    baseline_comparison: { result: "pass", evidence_sha256: HASH },
    steps: [
      {
        step_id: "hardware-step",
        mode: "hardware",
        result: "pass",
        duration_ms: 1,
        evidence_sha256: HASH,
      },
      {
        step_id: "linked-step",
        mode: "linked",
        result: "pass",
        duration_ms: 0,
        evidence_sha256: HASH,
        assertion_ids: ["focused:one"],
      },
    ],
    restores: [
      { restore_id: "release-input", result: "pass", evidence_sha256: HASH },
    ],
    failure_count: 0,
  };
  const deviceTests = {
    ok: true,
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:01:00.000Z",
    command: {
      executable: "./dev_deploy.sh",
      args: ["-r", "<configured-target>", "--run-go-tests-only"],
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
    device_identity: { revision: COMMIT },
    tool_listing: { tool_count: 10 },
    atx_preflight_sha256: HASH,
    device_tests_sha256: sha256Canonical(deviceTests),
    finalization_sha256: sha256Canonical(finalization),
    transport_reconnect: { connect: { ok: true }, release: { ok: true } },
  };
  return { story, plan, record, summary, deviceTests, finalization };
}

test("accepts complete canonical hardware evidence", () => {
  const { story, plan, record, summary, finalization, deviceTests } = fixture();
  const audit = validateHardwareReleaseEvidence({
    candidate: candidate(),
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

test("fails closed on a missing step or restore", () => {
  const { story, plan, record, summary, finalization, deviceTests } = fixture();
  const incomplete = structuredClone(record);
  incomplete.steps.pop();
  assert.throws(
    () =>
      validateHardwareReleaseEvidence({
        candidate: candidate(),
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
