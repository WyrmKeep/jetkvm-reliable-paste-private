import {
  ATX_UNAVAILABLE_EXCEPTION_CODE,
  deriveHardwareValidationException,
} from "./hardware-validation-profile.mjs";

import { sha256Canonical } from "./release-evidence.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  hardwareValidation,
  writeRecord,
  runId,
  now = () => new Date(),
}) {
  const hardwareException = deriveHardwareValidationException({
    stories,
    plan,
    hardwareValidation,
  });
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
        if (
          hardwareException !== null &&
          assignment.requires_atx_wiring
        ) {
          steps.push({
            step_id: step.id,
            mode: assignment.mode,
            requires_atx_wiring: true,
            result: "excluded",
            exception_code: ATX_UNAVAILABLE_EXCEPTION_CODE,
          });
          continue;
        }
        const stepStartedAt = now().toISOString();
        try {
          const result = assertDriverResult(
            await executeStep(driver, story, step, assignment),
            `Live step ${story.id}/${step.id}`,
          );
          steps.push({
            step_id: step.id,
            mode: assignment.mode,
            requires_atx_wiring: assignment.requires_atx_wiring,
            result: "pass",
            started_at: stepStartedAt,
            duration_ms: result.duration_ms,
            evidence: result.evidence,
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
            requires_atx_wiring: assignment.requires_atx_wiring,
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
            evidence: result.evidence,
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
      result:
        failures.length > 0
          ? "fail"
          : steps.some((step) => step.result === "excluded")
            ? "pass_with_exception"
            : "pass",
      started_at: startedAt,
      completed_at: now().toISOString(),
      precondition_ids: story.preconditions.map((condition) => condition.id),
      baseline_before: baselineBefore ?? null,
      baseline_after: baselineAfter ?? null,
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
                evidence: baselineComparison.evidence,
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
