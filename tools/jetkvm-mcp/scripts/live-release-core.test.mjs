import assert from "node:assert/strict";
import test from "node:test";

import {
  runWithFinalization,
  runCanonicalLiveStories,
} from "./live-release-core.mjs";
import { CANONICAL_ATX_UNAVAILABLE_STEPS } from "./hardware-validation-profile.mjs";
import { validateLiveExecutionPlan } from "./live-plan-validation.mjs";

const FULL_HARDWARE_VALIDATION = Object.freeze({
  profile: "full",
  exception_code: null,
});
const ATX_UNAVAILABLE_VALIDATION = Object.freeze({
  profile: "atx_unavailable",
  exception_code: "ATX_WIRING_UNAVAILABLE",
});

function story(id, steps = ["one", "two"]) {
  return {
    id,
    title: id,
    environments: ["fake", "live"],
    preconditions: [{ id: "outer-device-lease", required: true }],
    steps: steps.map((stepId) => ({
      id: stepId,
      tool: "jetkvm_session_status",
      call: "tools/call",
      input: {},
      timeout_ms: 1000,
      expect: "pass",
    })),
    pass: [
      { id: "assertion-1", requirement: `contract:${id}`, assertion: "pass" },
    ],
    evidence: [
      {
        id: "evidence-1",
        requirement: `contract:${id}`,
        field: "requirement_result",
        source: "execution",
        retention: "release_manifest",
      },
    ],
    restore: [
      {
        id: "release-input",
        action: "release",
        assertion: "released",
        always: true,
      },
      {
        id: "reset-fixture",
        action: "reset",
        assertion: "reset",
        always: true,
      },
    ],
    privacy: [],
    requirements: [`contract:${id}`],
    tools: ["jetkvm_session_status"],
    fault_script: [],
  };
}

const STORIES = [story("story-a"), story("story-b", ["three"])];
const PLAN = {
  "story-a": {
    steps: {
      one: { mode: "hardware", requires_atx_wiring: false },
      two: {
        mode: "linked",
        requires_atx_wiring: false,
        assertion_ids: ["focused:two"],
      },
    },
  },
  "story-b": {
    steps: {
      three: {
        mode: "controlled_live",
        requires_atx_wiring: false,
        assertion_ids: ["focused:three"],
      },
    },
  },
};

test("runs finalization once and preserves operation plus cleanup failures", async () => {
  const order = [];
  await assert.rejects(
    runWithFinalization(
      async () => {
        order.push("operation");
        throw new Error("operation failed");
      },
      async (operationError) => {
        order.push("finalize");
        assert.match(operationError.message, /operation failed/u);
        throw new Error("finalization failed");
      },
    ),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /operation failed/u);
      assert.match(error.errors[1].message, /finalization failed/u);
      return true;
    },
  );
  assert.deepEqual(order, ["operation", "finalize"]);
});

test("validates explicit one-to-one step coverage and rejects silent linking", () => {
  assert.doesNotThrow(() => validateLiveExecutionPlan(STORIES, PLAN));
  const incomplete = structuredClone(PLAN);
  delete incomplete["story-a"].steps.two;
  assert.throws(
    () => validateLiveExecutionPlan(STORIES, incomplete),
    /exactly the canonical step IDs/u,
  );
  const extra = structuredClone(PLAN);
  extra["story-a"].steps.unknown = {
    mode: "linked",
    requires_atx_wiring: false,
    assertion_ids: ["x"],
  };
  assert.throws(
    () => validateLiveExecutionPlan(STORIES, extra),
    /exactly the canonical step IDs/u,
  );
});

test("runs stories in manifest order and blocks each next story on restore comparison", async () => {
  const calls = [];
  const records = [];
  const driver = {
    captureBaseline: async (storyValue, phase) => {
      calls.push(`baseline:${storyValue.id}:${phase}`);
      return { safe_state: true, story: storyValue.id };
    },
    executeHardwareStep: async (storyValue, step) => {
      calls.push(`hardware:${storyValue.id}:${step.id}`);
      return {
        result: "pass",
        evidence_sha256: "a".repeat(64),
        duration_ms: 1,
      };
    },
    executeControlledStep: async (storyValue, step) => {
      calls.push(`controlled:${storyValue.id}:${step.id}`);
      return {
        result: "pass",
        evidence_sha256: "b".repeat(64),
        duration_ms: 2,
      };
    },
    resolveLinkedStep: async (storyValue, step, assignment) => {
      calls.push(
        `linked:${storyValue.id}:${step.id}:${assignment.assertion_ids[0]}`,
      );
      return {
        result: "pass",
        evidence_sha256: "c".repeat(64),
        duration_ms: 0,
      };
    },
    restore: async (storyValue, restore) => {
      calls.push(`restore:${storyValue.id}:${restore.id}`);
      return { result: "pass", evidence_sha256: "d".repeat(64) };
    },
    compareBaseline: async (storyValue, before, after) => {
      calls.push(`compare:${storyValue.id}`);
      assert.deepEqual(after, before);
      return { result: "pass", evidence_sha256: "e".repeat(64) };
    },
  };

  const result = await runCanonicalLiveStories({
    stories: STORIES,
    plan: PLAN,
    driver,
    writeRecord: async (record) => records.push(record),
    runId: "release-run-1",
    hardwareValidation: FULL_HARDWARE_VALIDATION,
  });

  assert.equal(result.length, 2);
  assert.equal(records.length, 2);
  assert.deepEqual(
    result.map((record) => record.story_id),
    ["story-a", "story-b"],
  );
  assert.equal(
    result.every((record) => record.result === "pass"),
    true,
  );
  assert.deepEqual(calls.slice(0, 8), [
    "baseline:story-a:before",
    "hardware:story-a:one",
    "linked:story-a:two:focused:two",
    "restore:story-a:release-input",
    "restore:story-a:reset-fixture",
    "baseline:story-a:after",
    "compare:story-a",
    "baseline:story-b:before",
  ]);
});

test("excludes only ATX-wiring steps and completes the mixed story", async () => {
  const grouped = new Map();
  for (const pair of CANONICAL_ATX_UNAVAILABLE_STEPS) {
    const stepIds = grouped.get(pair.story_id) ?? [];
    stepIds.push(pair.step_id);
    grouped.set(pair.story_id, stepIds);
  }
  const stories = [...grouped].map(([storyId, stepIds], index) =>
    story(storyId, [
      ...(index === 0 ? ["safe-before"] : []),
      ...stepIds,
      ...(index === 0 ? ["safe-after"] : []),
    ]),
  );
  const excludedStepIds = new Set(
    CANONICAL_ATX_UNAVAILABLE_STEPS.map((pair) => pair.step_id),
  );
  const plan = Object.fromEntries(
    stories.map((storyValue) => [
      storyValue.id,
      {
        steps: Object.fromEntries(
          storyValue.steps.map((step) => [
            step.id,
            {
              mode: "hardware",
              requires_atx_wiring: excludedStepIds.has(step.id),
            },
          ]),
        ),
      },
    ]),
  );
  const calls = [];
  const records = [];
  const driver = {
    captureBaseline: async (_story, phase) => {
      calls.push(`baseline:${phase}`);
      return { safe: true };
    },
    executeHardwareStep: async (_story, step) => {
      calls.push(`step:${step.id}`);
      return {
        result: "pass",
        duration_ms: 1,
        evidence: { step: step.id },
        evidence_sha256: "a".repeat(64),
      };
    },
    restore: async (_story, restore) => {
      calls.push(`restore:${restore.id}`);
      return {
        result: "pass",
        evidence: { restore: restore.id },
        evidence_sha256: "b".repeat(64),
      };
    },
    compareBaseline: async () => {
      calls.push("compare");
      return {
        result: "pass",
        evidence: { equal: true },
        evidence_sha256: "c".repeat(64),
      };
    },
  };

  const result = await runCanonicalLiveStories({
    stories,
    plan,
    driver,
    hardwareValidation: ATX_UNAVAILABLE_VALIDATION,
    writeRecord: async (record) => records.push(record),
    runId: "release-run-atx-unavailable",
  });

  assert.deepEqual(
    calls.filter((call) => call.startsWith("step:")),
    ["step:safe-before", "step:safe-after"],
  );
  assert.equal(
    calls.filter((call) => call.startsWith("restore:")).length,
    stories.length * 2,
  );
  assert.equal(result.length, stories.length);
  assert.equal(
    result.every((record) => record.result === "pass_with_exception"),
    true,
  );
  assert.deepEqual(
    result.flatMap((record) =>
      record.steps
        .filter((step) => step.result === "excluded")
        .map((step) => ({
          story_id: record.story_id,
          step_id: step.step_id,
        })),
    ),
    CANONICAL_ATX_UNAVAILABLE_STEPS,
  );
  assert.deepEqual(records, result);
});

test("always runs every restore, writes the failed record, and stops before the next story", async () => {
  const calls = [];
  const records = [];
  const driver = {
    captureBaseline: async (storyValue) => ({ story: storyValue.id }),
    executeHardwareStep: async () => {
      throw new Error("step failed");
    },
    executeControlledStep: async () => ({ result: "pass" }),
    resolveLinkedStep: async () => ({ result: "pass" }),
    restore: async (storyValue, restore) => {
      calls.push(`${storyValue.id}:${restore.id}`);
      if (restore.id === "release-input") throw new Error("release failed");
      return { result: "pass", evidence_sha256: "d".repeat(64) };
    },
    compareBaseline: async () => ({
      result: "pass",
      evidence_sha256: "e".repeat(64),
    }),
  };

  await assert.rejects(
    runCanonicalLiveStories({
      stories: STORIES,
      plan: PLAN,
      driver,
      writeRecord: async (record) => records.push(record),
      runId: "release-run-2",
      hardwareValidation: FULL_HARDWARE_VALIDATION,
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
  assert.deepEqual(calls, ["story-a:release-input", "story-a:reset-fixture"]);
  assert.equal(records.length, 1);
  assert.equal(records[0].result, "fail");
  assert.equal(records[0].story_id, "story-a");
});
