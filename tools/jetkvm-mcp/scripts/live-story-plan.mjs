import definitions from "./live-story-plan.json" with { type: "json" };

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
    if ([...hardware].some((id) => controlled.has(id))) {
      throw new Error(`Live story ${story.id} assigns one step twice.`);
    }
    const steps = {};
    for (const step of story.steps) {
      if (hardware.has(step.id)) {
        steps[step.id] = Object.freeze({ mode: "hardware" });
        continue;
      }
      const mode = controlled.has(step.id) ? "controlled_live" : "linked";
      const assertionIds = resolveAssertionIds(story, step, mode);
      steps[step.id] = Object.freeze({
        mode,
        assertion_ids: Object.freeze([...assertionIds]),
      });
    }
    plan[story.id] = Object.freeze({ steps: Object.freeze(steps) });
  }
  return Object.freeze(plan);
}
