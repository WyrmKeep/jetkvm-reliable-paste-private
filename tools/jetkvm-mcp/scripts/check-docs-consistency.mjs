#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_TOOL_NAMES = Object.freeze([
  "jetkvm_session_connect",
  "jetkvm_session_status",
  "jetkvm_session_reconnect",
  "jetkvm_display_capture",
  "jetkvm_display_status",
  "jetkvm_input_mouse",
  "jetkvm_input_keyboard",
  "jetkvm_input_paste",
  "jetkvm_input_release",
  "jetkvm_power_control",
]);

export const CANONICAL_BRANCHES = Object.freeze([
  "feat/jetkvm-mcp-foundation",
  "feat/jetkvm-mcp-transport-api",
  "feat/jetkvm-mcp-input-display",
  "feat/jetkvm-mcp-power-session",
  "feat/jetkvm-mcp-system-e2e-docs",
  "feat/jetkvm-mcp-hardware-release",
]);

export const CANONICAL_PHASE_NAMES = Object.freeze([
  "Foundation safety",
  "Transport/API contracts",
  "Input and display",
  "Power and session",
  "System E2E, docs, and packaging",
  "Hardware evidence and release",
]);

const REQUIRED_INSTALLED_SMOKE_SCRIPTS = Object.freeze({
  "smoke:installed-contracts":
    "npm run build && node scripts/installed-contracts-smoke.mjs",
  "smoke:installed-stdio-protocol":
    "npm run build && node scripts/installed-stdio-protocol-smoke.mjs",
  "smoke:installed-sse-protocol":
    "npm run build && node scripts/installed-sse-protocol-smoke.mjs",
});

function countOccurrences(text, literal) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(literal, offset)) !== -1) {
    count += 1;
    offset += literal.length;
  }
  return count;
}

function sectionBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Missing documentation marker: ${startMarker}`);
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`Missing documentation marker: ${endMarker}`);
  }
  return text.slice(start, end);
}

function exactOrderedValues(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function uniqueMatches(text, pattern) {
  const values = [...text.matchAll(pattern)].map((match) => match[1]);
  return [...new Set(values)];
}

function extractStoryIds(section) {
  return [...section.matchAll(/^\d+\. `([a-z0-9]+(?:-[a-z0-9]+)*)`$/gm)].map(
    (match) => match[1],
  );
}

function extractPlanPhaseBlocks(planText) {
  const headings = [...planText.matchAll(/^# Phase ([1-6]) — (.+?) PR$/gm)];
  if (headings.length !== 6) {
    throw new Error("The plan must contain the exact six phase names once");
  }

  return headings.map((heading, index) => {
    const start = heading.index;
    const end = headings[index + 1]?.index ?? planText.length;
    return {
      number: Number(heading[1]),
      name: heading[2],
      text: planText.slice(start, end),
    };
  });
}

function extractDesignPhaseRow(designText, phase) {
  const row = designText.match(
    new RegExp(
      `^\\|\\s*${phase}\\s*\\|\\s*\x60([^\x60]+)\x60\\s*\\|\\s*(.+?)\\s*\\|$`,
      "m",
    ),
  );
  if (row === null) {
    throw new Error(`Canonical design is missing Phase ${phase}`);
  }
  return { branch: row[1], deliverable: row[2] };
}

export function checkDocsConsistency({
  designText,
  planText,
  packageJson,
  storyIds,
}) {
  if (
    countOccurrences(
      designText,
      "The v0.1 public tool catalogue is exactly:",
    ) !== 1
  ) {
    throw new Error("Canonical design contains a duplicate tool inventory");
  }
  if (countOccurrences(planText, "### 0.2 Exact public catalogue") !== 1) {
    throw new Error("Canonical plan contains a duplicate tool inventory");
  }
  if (countOccurrences(designText, "Required named stories include:") !== 1) {
    throw new Error("Canonical design contains a duplicate story inventory");
  }
  if (
    countOccurrences(
      planText,
      "The reviewed Phase 2 manifest contains all 24 complete canonical stories—never placeholders or uppercase aliases:",
    ) !== 1
  ) {
    throw new Error("Canonical plan contains a duplicate story inventory");
  }

  const designToolSection = sectionBetween(
    designText,
    "The v0.1 public tool catalogue is exactly:",
    "No aliases or additional public tools ship in v0.1.",
  );
  const planToolSection = sectionBetween(
    planText,
    "### 0.2 Exact public catalogue",
    "### 0.3 Shared public contracts",
  );
  const designTools = uniqueMatches(
    designToolSection,
    /^\d+\. `([a-z0-9_]+)`$/gm,
  );
  const planTools = uniqueMatches(
    planToolSection,
    /^\|\s*`([a-z0-9_]+)`\s*\|/gm,
  );
  if (
    !exactOrderedValues(designTools, CANONICAL_TOOL_NAMES) ||
    !exactOrderedValues(planTools, CANONICAL_TOOL_NAMES)
  ) {
    throw new Error(
      "Canonical docs must contain the exact ten tool names in canonical order",
    );
  }

  for (const [label, text] of [
    ["design", designText],
    ["plan", planText],
  ]) {
    const successContract = sectionBetween(
      text,
      "type Success<T> = {",
      "type MutationState = {",
    );
    if (
      !/session_id:\s*string;/.test(successContract) ||
      !/session_generation:\s*number;/.test(successContract) ||
      /session_(?:id|generation):[^;\n]*null/.test(successContract)
    ) {
      throw new Error(
        `Canonical ${label} Success contract must require non-null session identity`,
      );
    }
  }

  const designPhaseRows = [1, 2, 3, 4, 5, 6].map((phase) =>
    extractDesignPhaseRow(designText, phase),
  );
  const designBranches = designPhaseRows.map(({ branch }) => branch);
  const planPhaseBlocks = extractPlanPhaseBlocks(planText);
  const planPhaseNames = planPhaseBlocks.map(({ name }) => name);
  const planBranches = planPhaseBlocks.map(({ text }, index) => {
    const branchLine = text.match(
      /^\*\*Branch:\*\*[^\n]*`(feat\/jetkvm-mcp-[a-z0-9-]+)`/m,
    );
    if (branchLine === null) {
      throw new Error(`Plan Phase ${index + 1} is missing its branch name`);
    }
    return branchLine[1];
  });

  if (
    !exactOrderedValues(designBranches, CANONICAL_BRANCHES) ||
    !exactOrderedValues(planBranches, CANONICAL_BRANCHES)
  ) {
    throw new Error(
      "Canonical docs must contain the exact six branch names in phase order",
    );
  }
  if (!exactOrderedValues(planPhaseNames, CANONICAL_PHASE_NAMES)) {
    throw new Error(
      "Canonical plan must contain the exact six phase names in order",
    );
  }

  const designStorySection = sectionBetween(
    designText,
    "Required named stories include:",
    "The shared `DeviceRpcAdapter` has no separate story ID.",
  );
  const planStorySection = sectionBetween(
    planText,
    "The reviewed Phase 2 manifest contains all 24 complete canonical stories—never placeholders or uppercase aliases:",
    "Each story has complete setup/preconditions",
  );
  const designStoryIds = extractStoryIds(designStorySection);
  const planStoryIds = extractStoryIds(planStorySection);
  const storyIdsUnique = new Set(storyIds);
  if (storyIds.length !== 24) {
    throw new Error(
      "The manifest must contain exactly 24 story IDs and never story25",
    );
  }
  if (storyIdsUnique.size !== storyIds.length) {
    throw new Error("The manifest contains duplicate canonical story IDs");
  }
  if (
    !exactOrderedValues(storyIds, designStoryIds) ||
    !exactOrderedValues(storyIds, planStoryIds) ||
    storyIds.some((id) => id === "story25")
  ) {
    throw new Error(
      "Manifest and docs must contain the same exact canonical story IDs",
    );
  }

  const phase2Design = designPhaseRows[1].deliverable;
  const phase3Design = designPhaseRows[2].deliverable;
  const phase2Plan = planPhaseBlocks[1].text;
  const phase3Plan = planPhaseBlocks[2].text;
  const phase2PlanOutcome =
    phase2Plan.match(/^\*\*Outcome:\*\* (.+)$/m)?.[1] ?? "";
  const phase3PlanOutcome =
    phase3Plan.match(/^\*\*Outcome:\*\* (.+)$/m)?.[1] ?? "";
  if (
    !/DeviceRpcAdapter/.test(phase2Design) ||
    !/complete strict 24-story manifest/.test(phase2Design)
  ) {
    throw new Error(
      "Phase 2 must own DeviceRpcAdapter and the complete 24-story manifest in the design",
    );
  }
  if (
    !/DeviceRpcAdapter/.test(phase2PlanOutcome) ||
    !/complete reviewed story manifest/.test(phase2PlanOutcome)
  ) {
    throw new Error(
      "Phase 2 must own DeviceRpcAdapter and the complete 24-story manifest in the plan",
    );
  }
  if (
    !/(?:display capture|frame capture|capture\/observation)/i.test(
      phase3Design,
    ) ||
    !/(?:display status|status\/display)/i.test(phase3Design)
  ) {
    throw new Error(
      "Phase 3 must own display capture and display status in the design",
    );
  }
  if (!/read-only EDID/i.test(phase3Design)) {
    throw new Error("Phase 3 must own read-only EDID in the design");
  }
  if (
    !/(?:display capture|frame capture)/i.test(phase3PlanOutcome) ||
    !/display status/i.test(phase3PlanOutcome)
  ) {
    throw new Error(
      "Phase 3 must own display capture and display status in the plan",
    );
  }
  if (!/read-only EDID/i.test(phase3PlanOutcome)) {
    throw new Error("Phase 3 must own read-only EDID in the plan");
  }

  const explicitOwnershipClaims = [
    ...planText.matchAll(
      /(?:DeviceRpcAdapter|(?:complete )?(?:24-story )?manifest)[^\n]{0,100}?Phase ([1-6])[- ]owned/gi,
    ),
  ];
  if (explicitOwnershipClaims.some((claim) => claim[1] !== "2")) {
    throw new Error(
      "DeviceRpcAdapter or complete manifest has duplicate ownership outside Phase 2",
    );
  }
  if (
    !/`DeviceRpcAdapter` and the complete manifest remain Phase 2-owned\./.test(
      phase3Plan,
    )
  ) {
    throw new Error(
      "Phase 2 ownership of DeviceRpcAdapter and the complete 24-story manifest drifted",
    );
  }

  const scripts = packageJson?.scripts;
  if (scripts?.["docs:check"] !== "node scripts/check-docs-consistency.mjs") {
    throw new Error(
      "package.json must define docs:check as node scripts/check-docs-consistency.mjs",
    );
  }
  if (
    scripts?.["schemas:check"] !== "node scripts/generate-schemas.mjs --check"
  ) {
    throw new Error(
      "package.json must define schemas:check as node scripts/generate-schemas.mjs --check",
    );
  }
  for (const [scriptName, command] of Object.entries(
    REQUIRED_INSTALLED_SMOKE_SCRIPTS,
  )) {
    if (scripts?.[scriptName] !== command) {
      throw new Error(`package.json must define ${scriptName} as ${command}`);
    }
  }

  return {
    toolNames: [...CANONICAL_TOOL_NAMES],
    branches: [...CANONICAL_BRANCHES],
    phaseNames: [...CANONICAL_PHASE_NAMES],
    storyCount: storyIds.length,
  };
}

async function run() {
  const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(scriptsDirectory, "..");
  const repositoryRoot = resolve(packageRoot, "../..");
  const storiesDirectory = resolve(packageRoot, "src/stories");
  const [designText, planText, packageJsonText, storyFiles] = await Promise.all(
    [
      readFile(
        resolve(
          repositoryRoot,
          "docs/superpowers/specs/2026-07-12-jetkvm-computer-use-mcp-design.md",
        ),
        "utf8",
      ),
      readFile(
        resolve(
          repositoryRoot,
          "docs/superpowers/plans/2026-07-12-jetkvm-computer-use-mcp.md",
        ),
        "utf8",
      ),
      readFile(resolve(packageRoot, "package.json"), "utf8"),
      readdir(storiesDirectory),
    ],
  );
  const storyIds = storyFiles
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => name.replace(/^\d{2}-/, "").replace(/\.json$/, ""));

  const result = checkDocsConsistency({
    designText,
    planText,
    packageJson: JSON.parse(packageJsonText),
    storyIds,
  });
  process.stdout.write(
    `docs consistent: ${result.toolNames.length} tools, ${result.branches.length} phases, ${result.storyCount} stories\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await run();
}
