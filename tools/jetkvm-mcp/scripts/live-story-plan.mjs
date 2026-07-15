import definitions from "./live-story-plan.json" with { type: "json" };

import { CANONICAL_ATX_UNAVAILABLE_STEPS } from "./hardware-validation-profile.mjs";
import { validateLiveExecutionPlan } from "./live-plan-validation.mjs";

import { sha256Canonical } from "./release-evidence.mjs";

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

function sameIdsInOrder(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((id, index) => id === expected[index])
  );
}

export function assertCanonicalAtxUnavailableClassification(storyId, stepIds) {
  const expected = CANONICAL_ATX_UNAVAILABLE_STEPS.filter(
    (entry) => entry.story_id === storyId,
  ).map((entry) => entry.step_id);
  if (
    !Object.hasOwn(definitions, storyId) ||
    !Array.isArray(stepIds) ||
    !sameIdsInOrder(stepIds, expected)
  ) {
    throw new Error(
      `Live story ${storyId} ATX-unavailable classification drifted.`,
    );
  }
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
    !sameIdsInOrder(
      Object.keys(definitions),
      liveStories.map((story) => story.id),
    )
  ) {
    throw new Error("Canonical live story inventory order changed.");
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
    assertCanonicalAtxUnavailableClassification(story.id, [...atxUnavailable]);
    const atxSafe = strictIdSet(
      definition.atx_safe_without_wiring_step_ids,
      available,
      `Live ATX-safe plan ${story.id}`,
    );
    if ([...hardware].some((id) => controlled.has(id))) {
      throw new Error(`Live story ${story.id} assigns one step twice.`);
    }
    if (
      [...atxUnavailable].some((id) => !hardware.has(id) || atxSafe.has(id)) ||
      [...atxSafe].some((id) => !hardware.has(id))
    ) {
      throw new Error(`Live story ${story.id} has invalid ATX classification.`);
    }
    for (const step of story.steps) {
      if (atxSafe.has(step.id) && step.tool !== "jetkvm_power_control") {
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
