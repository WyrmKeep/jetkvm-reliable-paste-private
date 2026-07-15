import definitions from "./live-story-plan.json" with { type: "json" };

import { sha256Canonical } from "./release-evidence.mjs";

const MODES = new Set(["hardware", "controlled_live", "linked"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAssignment(assignment, storyId, stepId) {
  if (!isRecord(assignment) || !MODES.has(assignment.mode)) {
    throw new Error(`Live plan assignment ${storyId}/${stepId} is invalid.`);
  }
  const requiresAssertions = assignment.mode !== "hardware";
  const expectedKeys = requiresAssertions
    ? ["mode", "requires_atx_wiring", "assertion_ids"]
    : ["mode", "requires_atx_wiring"];
  if (
    !exactKeys(assignment, expectedKeys) ||
    typeof assignment.requires_atx_wiring !== "boolean" ||
    (assignment.requires_atx_wiring && assignment.mode !== "hardware")
  ) {
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

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function sameIds(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function strictIdSet(value, available, label) {
  if (
    !Array.isArray(value) ||
    new Set(value).size !== value.length ||
    value.some((id) => typeof id !== "string" || !available.has(id))
  ) {
    throw new Error(`${label} contains invalid or duplicate step IDs.`);
  }
  return new Set(value);
}

export function materializeLiveExecutionPlan(stories, resolveAssertionIds) {
  if (!Array.isArray(stories) || typeof resolveAssertionIds !== "function") {
    throw new Error("Live story plan inputs are invalid.");
  }
  const liveStories = stories.filter(
    (story) =>
      Array.isArray(story.environments) && story.environments.includes("live"),
  );
  if (
    !sameIds(
      Object.keys(definitions),
      liveStories.map((story) => story.id),
    )
  ) {
    throw new Error("Canonical live story inventory changed.");
  }
  const plan = {};
  for (const story of liveStories) {
    const definition = definitions[story.id];
    if (
      !exactKeys(definition, [
        "step_ids_sha256",
        "hardware_step_ids",
        "controlled_step_ids",
        "atx_unavailable_step_ids",
        "atx_safe_without_wiring_step_ids",
      ]) ||
      sha256Canonical(story.steps.map((step) => step.id)) !==
        definition.step_ids_sha256
    ) {
      throw new Error(
        `Canonical live story ${story.id} step inventory changed.`,
      );
    }
    const available = new Set(story.steps.map((step) => step.id));
    const hardware = strictIdSet(
      definition.hardware_step_ids,
      available,
      `Live hardware plan ${story.id}`,
    );
    const controlled = strictIdSet(
      definition.controlled_step_ids,
      available,
      `Live controlled plan ${story.id}`,
    );
    const atxUnavailable = strictIdSet(
      definition.atx_unavailable_step_ids,
      available,
      `Live ATX-unavailable plan ${story.id}`,
    );
    const atxSafe = strictIdSet(
      definition.atx_safe_without_wiring_step_ids,
      available,
      `Live ATX-safe plan ${story.id}`,
    );
    if ([...hardware].some((id) => controlled.has(id))) {
      throw new Error(`Live story ${story.id} assigns one step twice.`);
    }
    if (
      [...atxUnavailable].some(
        (id) => !hardware.has(id) || atxSafe.has(id),
      ) ||
      [...atxSafe].some((id) => !hardware.has(id))
    ) {
      throw new Error(`Live story ${story.id} has invalid ATX classification.`);
    }
    for (const step of story.steps) {
      if (
        atxSafe.has(step.id) &&
        step.tool !== "jetkvm_power_control"
      ) {
        throw new Error(
          `Live story ${story.id} classified a non-power step as ATX-safe.`,
        );
      }
      if (
        hardware.has(step.id) &&
        step.tool === "jetkvm_power_control" &&
        Number(atxUnavailable.has(step.id)) + Number(atxSafe.has(step.id)) !== 1
      ) {
        throw new Error(
          `Live story ${story.id} has an unclassified hardware power step.`,
        );
      }
    }
    const steps = {};
    for (const step of story.steps) {
      const mode = hardware.has(step.id)
        ? "hardware"
        : controlled.has(step.id)
          ? "controlled_live"
          : "linked";
      const requiresAtxWiring = atxUnavailable.has(step.id);
      if (mode === "hardware") {
        steps[step.id] = Object.freeze({
          mode,
          requires_atx_wiring: requiresAtxWiring,
        });
        continue;
      }
      const assertionIds = resolveAssertionIds(story, step, mode);
      steps[step.id] = Object.freeze({
        mode,
        requires_atx_wiring: false,
        assertion_ids: Object.freeze([...assertionIds]),
      });
    }
    plan[story.id] = Object.freeze({ steps: Object.freeze(steps) });
  }
  return validateLiveExecutionPlan(stories, Object.freeze(plan));
}
