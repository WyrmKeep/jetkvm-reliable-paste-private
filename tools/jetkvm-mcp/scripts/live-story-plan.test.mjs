import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateLiveExecutionPlan } from "./live-release-core.mjs";
import { materializeLiveExecutionPlan } from "./live-story-plan.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
});

test("fails closed when canonical story steps drift from the reviewed live plan", async () => {
  const stories = await loadStories();
  stories[0].steps[0].id = "drifted-step";

  assert.throws(
    () => materializeLiveExecutionPlan(stories, () => ["assertion"]),
    /step inventory changed/u,
  );
});
