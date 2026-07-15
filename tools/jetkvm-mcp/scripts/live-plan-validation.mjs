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
  const left = [...actual].sort();
  const right = [...expected].sort();
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
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
