import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createExecutionEvidenceResolver,
  canonicalJson,
  sha256Canonical,
} from "./release-evidence.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildControlledReleaseEvidence({
  stories,
  plan,
  branchMatrix,
  storyE2e,
}) {
  const resolver = createExecutionEvidenceResolver({ branchMatrix, storyE2e });
  const evidence = {};
  for (const story of stories.filter((candidate) =>
    candidate.environments.includes("live"),
  )) {
    const storyPlan = plan[story.id];
    if (!isRecord(storyPlan) || !isRecord(storyPlan.steps)) {
      throw new Error(`Controlled release plan omitted story ${story.id}.`);
    }
    for (const step of story.steps) {
      const assignment = storyPlan.steps[step.id];
      if (!isRecord(assignment) || assignment.mode !== "controlled_live")
        continue;
      const identity = `controlled:${story.id}:${step.id}`;
      const executionIdentities = resolver(story, step, "linked");
      evidence[identity] = Object.freeze({
        result: "pass",
        execution_identities: Object.freeze(executionIdentities),
        branch_matrix_sha256: sha256Canonical(branchMatrix),
        story_e2e_sha256: sha256Canonical(storyE2e),
      });
    }
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(evidence).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

export function validateControlledReleaseEvidence(input) {
  if (!isRecord(input?.evidence)) {
    throw new Error("Controlled release evidence must be an object.");
  }
  const expected = buildControlledReleaseEvidence(input);
  if (canonicalJson(input.evidence) !== canonicalJson(expected)) {
    throw new Error(
      "Controlled release evidence does not match the reviewed inventory and hashes.",
    );
  }
  return expected;
}

export async function writeControlledReleaseEvidence(path, evidence) {
  path = resolve(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function run() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex < 0 || typeof process.argv[outputIndex + 1] !== "string") {
    throw new Error(
      "Usage: node scripts/build-controlled-release-evidence.mjs --output <path>",
    );
  }
  const [
    { loadAcceptanceStories },
    { materializeLiveExecutionPlan },
    branchMatrix,
    storyE2e,
  ] = await Promise.all([
    import("../dist/stories/manifest.js"),
    import("./live-story-plan.mjs"),
    readFile(resolve(packageRoot, "reports/branch-matrix.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(resolve(packageRoot, "reports/story-e2e.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  const stories = await loadAcceptanceStories(
    resolve(packageRoot, "dist/stories"),
  );
  const resolver = createExecutionEvidenceResolver({ branchMatrix, storyE2e });
  const plan = materializeLiveExecutionPlan(stories, resolver);
  const evidence = buildControlledReleaseEvidence({
    stories,
    plan,
    branchMatrix,
    storyE2e,
  });
  await writeControlledReleaseEvidence(process.argv[outputIndex + 1], evidence);
  process.stdout.write(
    `Controlled release evidence: ${Object.keys(evidence).length}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run();
}
