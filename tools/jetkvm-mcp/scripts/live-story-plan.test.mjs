import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CONTROLLED_TRACE_REPORT_PATHS,
  buildControlledReleaseEvidence,
  mergeControlledTraceReports,
  validateControlledReleaseEvidence,
} from "./build-controlled-release-evidence.mjs";
import {
  materializeLiveExecutionPlan,
  validateLiveExecutionPlan,
} from "./live-story-plan.mjs";
import { createExecutionEvidenceResolver } from "./release-evidence.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ATX_UNAVAILABLE_STEPS = [
  ["power-three-semantic-actions", "establish-definitive-atx-session"],
  ["power-three-semantic-actions", "prove-press-power-baseline"],
  ["power-three-semantic-actions", "press-power"],
  [
    "power-three-semantic-actions",
    "restore-and-prove-hold-power-baseline",
  ],
  ["power-three-semantic-actions", "hold-power"],
  [
    "power-three-semantic-actions",
    "restore-and-prove-reset-baseline",
  ],
  ["power-three-semantic-actions", "press-reset"],
  [
    "power-three-semantic-actions",
    "restore-and-prove-post-reset-baseline",
  ],
  [
    "duplicate-request-id-definitive-replay",
    "prepare-duplicate-power-case",
  ],
  [
    "duplicate-request-id-definitive-replay",
    "duplicate-initial-jetkvm-power-control",
  ],
  [
    "duplicate-request-id-definitive-replay",
    "duplicate-same-request-digest-jetkvm-power-control",
  ],
  [
    "duplicate-request-id-definitive-replay",
    "duplicate-changed-digest-jetkvm-power-control",
  ],
  [
    "duplicate-request-id-definitive-replay",
    "restore-and-prove-after-duplicate-power",
  ],
  [
    "atx-extension-serialization-idempotency-and-nonproof",
    "prove-serialized-power-baseline",
  ],
  [
    "atx-extension-serialization-idempotency-and-nonproof",
    "serialized-power-short",
  ],
  [
    "atx-extension-serialization-idempotency-and-nonproof",
    "repeat-power-short",
  ],
  [
    "atx-extension-serialization-idempotency-and-nonproof",
    "restore-and-prove-prewrite-baseline",
  ],
];

const ATX_SAFE_HARDWARE_STEPS = [
  [
    "session-connect-without-takeover-busy",
    "reject-strict-schema-jetkvm-power-control",
  ],
  ["stale-generation-zero-downstream-write", "stale-power-generation"],
  [
    "stale-generation-zero-downstream-write",
    "stale-keyboard-generation-jetkvm-power-control",
  ],
];


async function loadStories() {
  const directory = join(packageRoot, "src", "stories");
  const files = (await readdir(directory))
    .filter((name) => /^\d{2}-.*\.json$/u.test(name))
    .sort();
  return Promise.all(
    files.map(async (name) =>
      JSON.parse(await readFile(join(directory, name), "utf8")),
    ),
  );
}

test("materializes explicit coverage for all 18 canonical live stories", async () => {
  const stories = await loadStories();
  const plan = materializeLiveExecutionPlan(stories, (story, step, mode) => [
    `${mode}:${story.id}:${step.id}`,
  ]);

  assert.doesNotThrow(() => validateLiveExecutionPlan(stories, plan));
  assert.equal(Object.keys(plan).length, 18);
  assert.equal(
    Object.values(plan).every((storyPlan) =>
      Object.values(storyPlan.steps).some(
        (assignment) => assignment.mode !== "linked",
      ),
    ),
    true,
  );
  assert.equal(
    Object.values(plan)
      .flatMap((storyPlan) => Object.values(storyPlan.steps))
      .some((assignment) => assignment.mode === "linked"),
    true,
  );
  assert.equal(
    Object.values(
      plan["permission-and-capability-errors-actionable"].steps,
    ).every((assignment) => assignment.mode === "controlled_live"),
    true,
  );
  assert.equal(
    plan["display-status-cached-freshness-and-streaming-omission"].steps[
      "recover-after-device-rpc-adapter-release-loss"
    ].mode,
    "hardware",
  );
  const classifiedAssignments = stories
    .filter((story) => story.environments.includes("live"))
    .flatMap((story) =>
      story.steps.map((step) => ({
        story,
        step,
        assignment: plan[story.id].steps[step.id],
      })),
    );
  assert.equal(
    classifiedAssignments.every(
      ({ assignment }) =>
        typeof assignment.requires_atx_wiring === "boolean",
    ),
    true,
  );
  assert.deepEqual(
    classifiedAssignments
      .filter(({ assignment }) => assignment.requires_atx_wiring)
      .map(({ story, step }) => [story.id, step.id]),
    ATX_UNAVAILABLE_STEPS,
  );
  assert.deepEqual(
    classifiedAssignments
      .filter(
        ({ step, assignment }) =>
          step.tool === "jetkvm_power_control" &&
          assignment.mode === "hardware" &&
          assignment.requires_atx_wiring === false,
      )
      .map(({ story, step }) => [story.id, step.id]),
    ATX_SAFE_HARDWARE_STEPS,
  );
});

test("validates exact controlled evidence inventory, pass state, and hashes", async () => {
  const stories = await loadStories();
  const [branchMatrix, storyE2e, ...traceReports] = await Promise.all([
    readFile(join(packageRoot, "reports", "branch-matrix.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(join(packageRoot, "reports", "story-e2e.json"), "utf8").then(
      JSON.parse,
    ),
    ...CONTROLLED_TRACE_REPORT_PATHS.map((path) =>
      readFile(resolve(packageRoot, path), "utf8").then(JSON.parse),
    ),
  ]);
  const executionTraces = mergeControlledTraceReports(traceReports);
  const resolver = createExecutionEvidenceResolver({ branchMatrix, storyE2e });
  const plan = materializeLiveExecutionPlan(stories, resolver);
  const evidence = buildControlledReleaseEvidence({
    stories,
    plan,
    branchMatrix,
    storyE2e,
    executionTraces,
  });
  const input = {
    evidence,
    stories,
    plan,
    branchMatrix,
    storyE2e,
    executionTraces,
  };

  for (const story of stories) {
    const storyPlan = plan[story.id];
    for (const step of story.steps) {
      if (storyPlan?.steps?.[step.id]?.mode !== "controlled_live") continue;
      const stepEvidence = evidence[`controlled:${story.id}:${step.id}`];
      assert.equal(
        JSON.stringify(stepEvidence).includes("deferred_live_evidence"),
        false,
        `${story.id}/${step.id} used deferred evidence`,
      );
      if (step.tool !== null) {
        assert.equal(
          stepEvidence.request_response_traces.some((trace) =>
            trace.calls.some((call) => call.tool === step.tool),
          ),
          true,
          `${story.id}/${step.id} lacked a ${step.tool} exchange`,
        );
      }
    }
  }

  const controlledPermissionStory = stories.find((story) =>
    story.steps.some(
      (step) =>
        step.tool !== null &&
        /\bPERMISSION_DENIED\b/u.test(step.expect) &&
        plan[story.id]?.steps?.[step.id]?.mode === "controlled_live",
    ),
  );
  const controlledPermissionStep = controlledPermissionStory?.steps.find(
    (step) =>
      step.tool !== null &&
      /\bPERMISSION_DENIED\b/u.test(step.expect) &&
      plan[controlledPermissionStory.id]?.steps?.[step.id]?.mode ===
        "controlled_live",
  );
  assert.ok(controlledPermissionStory);
  assert.ok(controlledPermissionStep);
  const [permissionIdentity] = resolver(
    controlledPermissionStory,
    controlledPermissionStep,
    "linked",
  );
  const substituted = {
    ...executionTraces,
    [permissionIdentity]: {
      ...executionTraces[permissionIdentity],
      test_identity: "unrelated selected trace",
    },
  };
  assert.throws(
    () =>
      buildControlledReleaseEvidence({
        stories,
        plan,
        branchMatrix,
        storyE2e,
        executionTraces: substituted,
      }),
    /exact selected test identity/u,
  );
  const semanticallyTampered = structuredClone(executionTraces);
  const permissionCall = semanticallyTampered[permissionIdentity].calls.find(
    (call) => call.tool === controlledPermissionStep.tool,
  );
  permissionCall.response = {
    ok: true,
    tool: controlledPermissionStep.tool,
    result: { outcome: "applied" },
  };
  assert.throws(
    () =>
      buildControlledReleaseEvidence({
        stories,
        plan,
        branchMatrix,
        storyE2e,
        executionTraces: semanticallyTampered,
      }),
    /exact expected outcome/u,
  );

  assert.deepEqual(validateControlledReleaseEvidence(input), evidence);
  const identity = Object.keys(evidence)[0];
  for (const mutate of [
    (value) => {
      value[identity].result = "fail";
    },
    (value) => {
      value[identity].branch_matrix_sha256 = "0".repeat(64);
    },
    (value) => {
      value["controlled:extra:step"] = value[identity];
    },
    (value) => {
      delete value[identity];
    },
  ]) {
    const changed = structuredClone(evidence);
    mutate(changed);
    assert.throws(
      () => validateControlledReleaseEvidence({ ...input, evidence: changed }),
      /reviewed inventory and hashes/u,
    );
  }
});

test("fails closed when canonical story steps drift from the reviewed live plan", async () => {
  const stories = await loadStories();
  stories[0].steps[0].id = "drifted-step";

  assert.throws(
    () => materializeLiveExecutionPlan(stories, () => ["assertion"]),
    /step inventory changed/u,
  );
});

test("fails closed when hardware power wiring classifications drift", async () => {
  const safeDrift = await loadStories();
  safeDrift
    .find((story) => story.id === "session-connect-without-takeover-busy")
    .steps.find(
      (step) => step.id === "reject-strict-schema-jetkvm-power-control",
    ).tool = "jetkvm_session_status";
  assert.throws(
    () => materializeLiveExecutionPlan(safeDrift, () => ["assertion"]),
    /classified a non-power step as ATX-safe/u,
  );

  const unclassified = await loadStories();
  unclassified
    .find((story) => story.id === "session-connect-without-takeover-busy")
    .steps.find((step) => step.id === "connect-without-takeover").tool =
    "jetkvm_power_control";
  assert.throws(
    () => materializeLiveExecutionPlan(unclassified, () => ["assertion"]),
    /unclassified hardware power step/u,
  );
});
