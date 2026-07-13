import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  CANONICAL_BRANCHES,
  CANONICAL_PHASE_NAMES,
  CANONICAL_TOOL_NAMES,
  checkDocsConsistency,
} from "./check-docs-consistency.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const designPath = resolve(
  repositoryRoot,
  "docs/superpowers/specs/2026-07-12-jetkvm-computer-use-mcp-design.md",
);
const planPath = resolve(
  repositoryRoot,
  "docs/superpowers/plans/2026-07-12-jetkvm-computer-use-mcp.md",
);
const storiesDirectory = resolve(packageRoot, "src/stories");

const [designText, planText, storyFileNames] = await Promise.all([
  readFile(designPath, "utf8"),
  readFile(planPath, "utf8"),
  readdir(storiesDirectory),
]);

const storyIds = storyFileNames
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => name.replace(/^\d{2}-/, "").replace(/\.json$/, ""));

const validPackageJson = {
  scripts: {
    "docs:check": "node scripts/check-docs-consistency.mjs",
    "schemas:check": "node scripts/generate-schemas.mjs --check",
    "smoke:installed-contracts":
      "npm run build && node scripts/installed-contracts-smoke.mjs",
    "smoke:installed-stdio-protocol":
      "npm run build && node scripts/installed-stdio-protocol-smoke.mjs",
    "smoke:installed-sse-protocol":
      "npm run build && node scripts/installed-sse-protocol-smoke.mjs",
  },
};

function check(overrides = {}) {
  return checkDocsConsistency({
    designText,
    planText,
    packageJson: validPackageJson,
    storyIds,
    ...overrides,
  });
}

test("accepts the canonical docs, package hooks, tools, branches, phases, and 24 stories", () => {
  const result = check();
  assert.deepEqual(result.toolNames, [...CANONICAL_TOOL_NAMES]);
  assert.deepEqual(result.branches, [...CANONICAL_BRANCHES]);
  assert.deepEqual(result.phaseNames, [...CANONICAL_PHASE_NAMES]);
  assert.equal(result.storyCount, 24);
});

test("rejects drift in each of the exact ten tool inventories", () => {
  const driftedDesign = designText.replace(
    "jetkvm_power_control",
    "jetkvm_power_cycle",
  );
  assert.throws(
    () => check({ designText: driftedDesign }),
    /exact ten tool names/i,
  );

  const driftedPlan = planText.replace(
    "| `jetkvm_power_control` | NativeControlPlane | mutation | Phase 4 |",
    "| `jetkvm_power_cycle` | NativeControlPlane | mutation | Phase 4 |",
  );
  assert.throws(
    () => check({ planText: driftedPlan }),
    /exact ten tool names/i,
  );
});

test("rejects branch and phase-name drift", () => {
  const driftedBranch = designText.replace(
    "feat/jetkvm-mcp-input-display",
    "feat/jetkvm-mcp-display-input",
  );
  assert.throws(
    () => check({ designText: driftedBranch }),
    /six branch names/i,
  );

  const driftedPlanBranch = planText.replace(
    "create `feat/jetkvm-mcp-input-display`.",
    "create `feat/jetkvm-mcp-display-input`.",
  );
  assert.throws(
    () => check({ planText: driftedPlanBranch }),
    /six branch names/i,
  );

  const driftedPhase = planText.replace(
    "# Phase 4 — Power and session PR",
    "# Phase 4 — Session and power PR",
  );
  assert.throws(() => check({ planText: driftedPhase }), /six phase names/i);

  const missingPhaseHeading = planText.replace(
    "# Phase 6 — Hardware evidence and release PR",
    "## Hardware evidence and release",
  );
  assert.throws(
    () => check({ planText: missingPhaseHeading }),
    /exact six phase names/i,
  );

  const missingBranchDeclaration = planText.replace(
    "**Branch:** After Phase 5 is merged",
    "**Release branch:** After Phase 5 is merged",
  );
  assert.throws(
    () => check({ planText: missingBranchDeclaration }),
    /missing its branch name/i,
  );
});

test("rejects missing Phase 2 DeviceRpcAdapter or complete 24-story ownership", () => {
  const missingRpc = designText.replace(
    "single-session DeviceRpcAdapter lifecycle/injection/generation fencing",
    "session lifecycle/injection/generation fencing",
  );
  assert.throws(
    () => check({ designText: missingRpc }),
    /Phase 2.*DeviceRpcAdapter/i,
  );

  const missingPlanRpc = planText.replace(
    "one session-owned `DeviceRpcAdapter`",
    "one session-owned adapter",
  );
  assert.throws(
    () => check({ planText: missingPlanRpc }),
    /Phase 2.*DeviceRpcAdapter/i,
  );

  const movedManifest = planText.replace(
    "`DeviceRpcAdapter` and the complete manifest remain Phase 2-owned.",
    "The complete manifest becomes Phase 3-owned.",
  );
  assert.throws(
    () => check({ planText: movedManifest }),
    /Phase 2.*24-story manifest|duplicate ownership/i,
  );
});

test("rejects missing Phase 3 display capture, display status, or read-only EDID ownership", () => {
  const missingEdid = designText.replace(
    "qualified optional read-only EDID over the injected adapter",
    "qualified optional display metadata over the injected adapter",
  );
  assert.throws(
    () => check({ designText: missingEdid }),
    /Phase 3.*read-only EDID/i,
  );

  const missingDesignDisplay = designText
    .replace(
      "BrowserPlane capture/observation fences",
      "BrowserPlane observation fences",
    )
    .replace("status/display semantics", "native semantics");
  assert.throws(
    () => check({ designText: missingDesignDisplay }),
    /Phase 3.*display capture.*display status/i,
  );

  const missingDisplay = planText.replace(
    "browser frame capture plus native display status and read-only EDID",
    "browser observations plus native metadata",
  );
  assert.throws(
    () => check({ planText: missingDisplay }),
    /Phase 3.*display capture.*display status/i,
  );

  const missingPlanEdid = planText.replace(
    "browser frame capture plus native display status and read-only EDID",
    "browser frame capture plus native display status and display metadata",
  );
  assert.throws(
    () => check({ planText: missingPlanEdid }),
    /Phase 3.*read-only EDID/i,
  );
});

test("rejects a duplicate public inventory or a second story inventory", () => {
  const duplicateTools = `${designText}\nThe v0.1 public tool catalogue is exactly:\n`;
  assert.throws(
    () => check({ designText: duplicateTools }),
    /duplicate tool inventory/i,
  );

  const duplicateStories = `${planText}\nThe reviewed Phase 2 manifest contains all 24 complete canonical stories—never placeholders or uppercase aliases:\n`;
  assert.throws(
    () => check({ planText: duplicateStories }),
    /duplicate story inventory/i,
  );

  const duplicatePlanTools = `${planText}\n### 0.2 Exact public catalogue\n`;
  assert.throws(
    () => check({ planText: duplicatePlanTools }),
    /duplicate tool inventory/i,
  );

  const duplicateDesignStories = `${designText}\nRequired named stories include:\n`;
  assert.throws(
    () => check({ designText: duplicateDesignStories }),
    /duplicate story inventory/i,
  );

  const missingToolSectionEnd = designText.replace(
    "No aliases or additional public tools ship in v0.1.",
    "Aliases remain prohibited.",
  );
  assert.throws(
    () => check({ designText: missingToolSectionEnd }),
    /missing documentation marker/i,
  );
});

test("rejects missing, renamed, duplicate, or 25th story IDs", () => {
  assert.throws(
    () => check({ storyIds: storyIds.slice(0, 23) }),
    /exactly 24 story ids/i,
  );
  assert.throws(
    () => check({ storyIds: [...storyIds.slice(0, 23), "story25"] }),
    /canonical story ids|story25/i,
  );
  assert.throws(
    () => check({ storyIds: [...storyIds.slice(0, 23), storyIds[0]] }),
    /canonical story ids|duplicate/i,
  );

  const driftedDesignStory = designText.replace(
    "1. `session-connect-without-takeover-busy`",
    "1. `session-connect-busy`",
  );
  assert.throws(
    () => check({ designText: driftedDesignStory }),
    /same exact canonical story ids/i,
  );

  const driftedPlanStory = planText.replace(
    "24. `sse-session-id-is-routing-not-authentication`",
    "24. `sse-routing-id-authenticates`",
  );
  assert.throws(
    () => check({ planText: driftedPlanStory }),
    /same exact canonical story ids/i,
  );
});

test("rejects missing or renamed installed Phase 2 smoke hooks", () => {
  for (const scriptName of [
    "smoke:installed-contracts",
    "smoke:installed-stdio-protocol",
    "smoke:installed-sse-protocol",
  ]) {
    const packageJson = structuredClone(validPackageJson);
    delete packageJson.scripts[scriptName];
    assert.throws(() => check({ packageJson }), new RegExp(scriptName));

    packageJson.scripts[scriptName] = "node scripts/wrong-smoke.mjs";
    assert.throws(() => check({ packageJson }), new RegExp(scriptName));
  }
});

test("rejects missing package docs and schema consistency hooks", () => {
  assert.throws(
    () =>
      check({
        packageJson: {
          scripts: {
            "schemas:check": "node scripts/generate-schemas.mjs --check",
          },
        },
      }),
    /docs:check/i,
  );
  assert.throws(
    () =>
      check({
        packageJson: {
          scripts: { "docs:check": "node scripts/check-docs-consistency.mjs" },
        },
      }),
    /schemas:check/i,
  );

  assert.throws(
    () =>
      check({
        packageJson: {
          scripts: {
            "docs:check": "node scripts/other-docs-check.mjs",
            "schemas:check": "node scripts/generate-schemas.mjs --check",
          },
        },
      }),
    /docs:check/i,
  );
  assert.throws(
    () =>
      check({
        packageJson: {
          scripts: {
            "docs:check": "node scripts/check-docs-consistency.mjs",
            "schemas:check": "node scripts/other-schema-check.mjs",
          },
        },
      }),
    /schemas:check/i,
  );
});
