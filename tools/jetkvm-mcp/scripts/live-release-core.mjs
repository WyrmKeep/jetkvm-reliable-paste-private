import { sha256Canonical } from "./release-evidence.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MODES = new Set(["hardware", "controlled_live", "linked"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function sameIds(actual, expected) {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((id, index) => id === [...expected].sort()[index])
  );
}

function assertAssignment(assignment, storyId, stepId) {
  if (!isRecord(assignment) || !MODES.has(assignment.mode)) {
    throw new Error(`Live plan assignment ${storyId}/${stepId} is invalid.`);
  }
  const requiresAssertions = assignment.mode !== "hardware";
  const expectedKeys = requiresAssertions
    ? ["mode", "assertion_ids"]
    : ["mode"];
  if (!exactKeys(assignment, expectedKeys)) {
    throw new Error(`Live plan assignment ${storyId}/${stepId} is not strict.`);
  }
  if (
    requiresAssertions &&
    (!Array.isArray(assignment.assertion_ids) ||
      assignment.assertion_ids.length === 0 ||
      new Set(assignment.assertion_ids).size !==
        assignment.assertion_ids.length ||
      assignment.assertion_ids.some(
        (id) => typeof id !== "string" || id.length === 0,
      ))
  ) {
    throw new Error(
      `Live plan assignment ${storyId}/${stepId} lacks exact assertion IDs.`,
    );
  }
}

export function validateLiveExecutionPlan(stories, plan) {
  if (!Array.isArray(stories) || !isRecord(plan)) {
    throw new Error("Live execution plan inputs are invalid.");
  }
  const liveStories = stories.filter(
    (story) =>
      Array.isArray(story.environments) && story.environments.includes("live"),
  );
  const storyIds = liveStories.map((story) => story.id);
  if (
    new Set(storyIds).size !== storyIds.length ||
    !sameIds(Object.keys(plan), storyIds)
  ) {
    throw new Error(
      "Live plan must contain exactly the canonical live story IDs.",
    );
  }
  for (const story of liveStories) {
    const storyPlan = plan[story.id];
    if (!exactKeys(storyPlan, ["steps"]) || !isRecord(storyPlan.steps)) {
      throw new Error(`Live plan story ${story.id} is invalid.`);
    }
    const stepIds = story.steps.map((step) => step.id);
    if (
      new Set(stepIds).size !== stepIds.length ||
      !sameIds(Object.keys(storyPlan.steps), stepIds)
    ) {
      throw new Error(
        `Live plan story ${story.id} must contain exactly the canonical step IDs.`,
      );
    }
    for (const step of story.steps) {
      assertAssignment(storyPlan.steps[step.id], story.id, step.id);
    }
    if (
      !Array.isArray(story.restore) ||
      story.restore.length === 0 ||
      story.restore.some((restore) => restore.always !== true)
    ) {
      throw new Error(
        `Live story ${story.id} must have unconditional restoration.`,
      );
    }
  }
  return plan;
}

function publicFailure(code) {
  return Object.freeze({ result: "fail", error_code: code });
}

function assertDriverResult(value, label, { duration = true } = {}) {
  if (
    !isRecord(value) ||
    value.result !== "pass" ||
    typeof value.evidence_sha256 !== "string" ||
    !HASH_PATTERN.test(value.evidence_sha256) ||
    (duration &&
      (!Number.isSafeInteger(value.duration_ms) || value.duration_ms < 0))
  ) {
    throw new Error(`${label} returned malformed release evidence.`);
  }
  return value;
}

async function executeStep(driver, story, step, assignment) {
  switch (assignment.mode) {
    case "hardware":
      return driver.executeHardwareStep(story, step, assignment);
    case "controlled_live":
      return driver.executeControlledStep(story, step, assignment);
    case "linked":
      return driver.resolveLinkedStep(story, step, assignment);
    default:
      throw new Error("Unreachable live step mode.");
  }
}

export async function runWithFinalization(operation, finalize) {
  let operationResult;
  let operationError;
  try {
    operationResult = await operation();
  } catch (error) {
    operationError = error;
  }
  let finalizationError;
  try {
    await finalize(operationError);
  } catch (error) {
    finalizationError = error;
  }
  if (operationError !== undefined && finalizationError !== undefined) {
    throw new AggregateError(
      [operationError, finalizationError],
      "Live hardware operation and finalization both failed.",
      { cause: operationError },
    );
  }
  if (operationError !== undefined) throw operationError;
  if (finalizationError !== undefined) throw finalizationError;
  return operationResult;
}

export async function runCanonicalLiveStories({
  stories,
  plan,
  driver,
  writeRecord,
  runId,
  now = () => new Date(),
}) {
  validateLiveExecutionPlan(stories, plan);
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    typeof writeRecord !== "function"
  ) {
    throw new Error("Live runner identity or record writer is invalid.");
  }
  const records = [];
  const liveStories = stories.filter((story) =>
    story.environments.includes("live"),
  );
  for (const story of liveStories) {
    const failures = [];
    const steps = [];
    const restores = [];
    const startedAt = now().toISOString();
    let baselineBefore;
    let baselineAfter;
    let baselineComparison;
    try {
      baselineBefore = await driver.captureBaseline(story, "before");
      for (const step of story.steps) {
        const assignment = plan[story.id].steps[step.id];
        const stepStartedAt = now().toISOString();
        try {
          const result = assertDriverResult(
            await executeStep(driver, story, step, assignment),
            `Live step ${story.id}/${step.id}`,
          );
          steps.push({
            step_id: step.id,
            mode: assignment.mode,
            result: "pass",
            started_at: stepStartedAt,
            duration_ms: result.duration_ms,
            evidence_sha256: result.evidence_sha256,
            ...(assignment.assertion_ids === undefined
              ? {}
              : { assertion_ids: [...assignment.assertion_ids] }),
          });
        } catch (error) {
          failures.push(error);
          steps.push({
            step_id: step.id,
            mode: assignment.mode,
            ...publicFailure("STEP_FAILED"),
            started_at: stepStartedAt,
          });
          break;
        }
      }
    } catch (error) {
      failures.push(error);
    } finally {
      for (const restore of story.restore) {
        try {
          const result = assertDriverResult(
            await driver.restore(story, restore),
            `Live restore ${story.id}/${restore.id}`,
            { duration: false },
          );
          restores.push({
            restore_id: restore.id,
            result: "pass",
            evidence_sha256: result.evidence_sha256,
          });
        } catch (error) {
          failures.push(error);
          restores.push({
            restore_id: restore.id,
            ...publicFailure("RESTORE_FAILED"),
          });
        }
      }
      if (baselineBefore !== undefined) {
        try {
          baselineAfter = await driver.captureBaseline(story, "after");
          baselineComparison = assertDriverResult(
            await driver.compareBaseline(story, baselineBefore, baselineAfter),
            `Live baseline comparison ${story.id}`,
            { duration: false },
          );
        } catch (error) {
          failures.push(error);
          baselineComparison = publicFailure("BASELINE_MISMATCH");
        }
      }
    }

    const record = {
      schema_version: 1,
      run_id: runId,
      story_id: story.id,
      title: story.title,
      result: failures.length === 0 ? "pass" : "fail",
      started_at: startedAt,
      completed_at: now().toISOString(),
      precondition_ids: story.preconditions.map((condition) => condition.id),
      baseline_before_sha256:
        baselineBefore === undefined ? null : sha256Canonical(baselineBefore),
      baseline_after_sha256:
        baselineAfter === undefined ? null : sha256Canonical(baselineAfter),
      baseline_comparison:
        baselineComparison === undefined
          ? publicFailure("BASELINE_NOT_CAPTURED")
          : baselineComparison.result === "pass"
            ? {
                result: "pass",
                evidence_sha256: baselineComparison.evidence_sha256,
              }
            : baselineComparison,
      steps,
      restores,
      failure_count: failures.length,
    };
    try {
      await writeRecord(record);
    } catch (error) {
      failures.push(error);
    }
    records.push(record);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Live story ${story.id} failed.`);
    }
  }
  return records;
}
