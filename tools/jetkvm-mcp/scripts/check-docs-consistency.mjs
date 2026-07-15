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

const CANONICAL_PHASE_NUMBERS = Object.freeze([1, 2, 3, 4, 5, 6]);

const REQUIRED_INSTALLED_SMOKE_SCRIPTS = Object.freeze({
  "smoke:installed-contracts":
    "npm run build && node scripts/installed-contracts-smoke.mjs",
  "smoke:installed-stdio-protocol":
    "npm run build && node scripts/installed-stdio-protocol-smoke.mjs",
  "smoke:installed-sse-protocol":
    "npm run build && node scripts/installed-sse-protocol-smoke.mjs",
});
const REQUIRED_MCP_PHASE3_SCRIPT =
  "vitest run src/browser/bridgeProtocol.test.ts src/browser/BrowserController.test.ts src/browser/frames.test.ts src/browser/geometry.test.ts src/handlers/inputDisplay.matrix.test.ts src/native/JetKvmNativeControlPlane.test.ts src/planes/JetKvmBrowserPlane.test.ts src/test-support/PlaneSeams.test.ts src/test-support/ReplayPlanes.test.ts src/test-support/uiFixture.test.ts src/stories/manifest.test.ts src/stories/phase3.acceptance.test.ts && node --test scripts/check-docs-consistency.test.mjs";
const REQUIRED_UI_PHASE3_SCRIPT =
  "vitest run --config vitest.config.ts src/automation/bridge.test.ts src/automation/capture.test.ts src/automation/controller.test.ts src/automation/inputGuard.test.ts src/automation/paste.test.ts src/hooks/hidRpc.test.ts src/hooks/useJsonRpc.test.ts src/utils/hidRpcTransport.test.ts src/utils/keepaliveScheduler.test.ts src/utils/pasteBatches.test.ts src/utils/pasteMacro.test.ts src/utils/pasteText.test.ts";
const REQUIRED_MCP_TYPECHECK_SCRIPT = "tsc -p tsconfig.json --noEmit";
const REQUIRED_UI_TYPECHECK_SCRIPT =
  "npm run i18n:compile && tsc --noEmit -p tsconfig.app.json";

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

function rawMatches(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
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
  const phaseNumbers = headings.map((heading) => Number(heading[1]));
  if (!exactOrderedValues(phaseNumbers, CANONICAL_PHASE_NUMBERS)) {
    throw new Error(
      "Canonical plan phase numbers must be exactly [1, 2, 3, 4, 5, 6]",
    );
  }

  return headings.map((heading, index) => {
    const start = heading.index;
    const end = headings[index + 1]?.index ?? planText.length;
    return {
      number: phaseNumbers[index],
      name: heading[2],
      text: planText.slice(start, end),
    };
  });
}

function extractDesignPhaseRows(designText) {
  const rows = [
    ...designText.matchAll(/^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/gm),
  ];
  const phaseNumbers = rows.map((row) => Number(row[1]));
  if (!exactOrderedValues(phaseNumbers, CANONICAL_PHASE_NUMBERS)) {
    throw new Error(
      "Canonical design phase numbers must be exactly [1, 2, 3, 4, 5, 6]",
    );
  }
  return rows.map((row) => ({
    number: Number(row[1]),
    branch: row[2],
    deliverable: row[3],
  }));
}

const BROWSER_CONNECTION_CONTRACT = `interface BrowserConnection {
  readonly state: "ready";
  readonly ref: SessionRef;
  readonly binding: DeviceRpcBinding;
  readonly connectionEpoch: number;
  readonly browserChannelGeneration: number;
  readonly displayGeneration: number;
  readonly deviceRpc: DeviceRpcAdapter;
}`;

const OBSERVATION_GEOMETRY_CONTRACT = `interface ObservationGeometry {
  readonly contentX: number;
  readonly contentY: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
}`;

const OBSERVATION_CONTRACT = `interface Observation {
  readonly observationId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly connectionEpoch: number;
  readonly displayGeneration: number;
  readonly frameId: string;
  readonly capturedAt: string;
  readonly monotonicAgeMs: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly geometry: ObservationGeometry;
  readonly format: "jpeg" | "png";
  readonly sha256: string;
  readonly byteLength: number;
}`;

const BROWSER_CAPTURE_MIME_TYPE_CONTRACT = `type BrowserCaptureMimeType = "image/jpeg" | "image/png";`;

const BROWSER_CAPTURE_IMAGE_CONTRACT = `interface BrowserCaptureImage {
  readonly mimeType: BrowserCaptureMimeType;
  readonly bytes: Uint8Array;
}`;

const BROWSER_CAPTURE_ARTIFACT_CONTRACT = `interface BrowserCaptureArtifact {
  readonly observation: Observation;
  readonly image: BrowserCaptureImage;
}`;

const BROWSER_PLANE_CONTRACT = `interface BrowserPlane {
  readonly deviceRpc: DeviceRpcAdapter;
  connect(ref: SessionRef, deadline: Deadline): Promise<BrowserConnection>;
  reconnect(ref: SessionRef, deadline: Deadline): Promise<BrowserConnection>;
  capture(
    ref: SessionRef,
    request: CaptureRequest,
    deadline: Deadline,
  ): Promise<BrowserCaptureArtifact>;
  mouse(
    ref: SessionRef,
    request: MouseRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt>;
  keyboard(
    ref: SessionRef,
    request: KeyboardRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt>;
  paste(
    ref: SessionRef,
    request: PasteRequest,
    deadline: Deadline,
  ): Promise<PasteReceipt>;
  release(
    ref: SessionRef,
    request: ReleaseRequest,
    deadline: Deadline,
  ): Promise<ReleaseReceipt>;
  close(ref: SessionRef, deadline: Deadline): Promise<void>;
}`;

const STATUS_POLL_CONTRACT =
  "`getVideoState` validates state only and never creates `cached_snapshot`.";
const STATUS_EVENT_PRECEDENCE_CONTRACT =
  "A valid `videoInputState` event wins every concurrent or later poll, and fact age derives from that event's recorded timestamp.";

function assertCanonicalBrowserPlaneContract(text, label) {
  if (countOccurrences(text, "  readonly deviceRpc: DeviceRpcAdapter;") !== 2) {
    throw new Error(
      `Canonical ${label} shared deviceRpc contract must match BrowserConnection and BrowserPlane`,
    );
  }
  if (
    countOccurrences(text, "interface BrowserConnection {") !== 1 ||
    !text.includes(BROWSER_CONNECTION_CONTRACT)
  ) {
    throw new Error(
      `Canonical ${label} BrowserConnection binding contract drifted`,
    );
  }
  if (
    countOccurrences(text, "interface ObservationGeometry {") !== 1 ||
    !text.includes(OBSERVATION_GEOMETRY_CONTRACT)
  ) {
    throw new Error(`Canonical ${label} ObservationGeometry contract drifted`);
  }
  if (
    countOccurrences(text, "interface Observation {") !== 1 ||
    !text.includes(OBSERVATION_CONTRACT)
  ) {
    throw new Error(`Canonical ${label} must define byte-free Observation`);
  }
  if (
    countOccurrences(text, "type BrowserCaptureMimeType =") !== 1 ||
    !text.includes(BROWSER_CAPTURE_MIME_TYPE_CONTRACT)
  ) {
    throw new Error(
      `Canonical ${label} BrowserCaptureMimeType contract drifted`,
    );
  }
  if (
    countOccurrences(text, "interface BrowserCaptureImage {") !== 1 ||
    !text.includes(BROWSER_CAPTURE_IMAGE_CONTRACT)
  ) {
    throw new Error(`Canonical ${label} BrowserCaptureImage contract drifted`);
  }
  if (
    countOccurrences(text, "interface BrowserCaptureArtifact {") !== 1 ||
    !text.includes(BROWSER_CAPTURE_ARTIFACT_CONTRACT)
  ) {
    throw new Error(
      `Canonical ${label} BrowserCaptureArtifact contract drifted`,
    );
  }
  if (
    countOccurrences(text, "interface BrowserPlane {") !== 1 ||
    !text.includes(BROWSER_PLANE_CONTRACT)
  ) {
    throw new Error(`Canonical ${label} BrowserPlane capture contract drifted`);
  }
}

function assertCanonicalStatusProvenance(text, label) {
  if (
    !text.includes(STATUS_POLL_CONTRACT) ||
    !text.includes(STATUS_EVENT_PRECEDENCE_CONTRACT) ||
    !/before any valid `videoInputState`[^\n.]*(?:`none`\/unknown\/null|source:"none")/i.test(
      text,
    )
  ) {
    throw new Error(`Canonical ${label} status provenance contract drifted`);
  }
  for (const statement of text.split(/[.\n]/)) {
    if (
      statement.includes("getVideoState") &&
      statement.includes("cached_snapshot") &&
      !/(?:never|cannot|validation-only|validation only|no `cached_snapshot` fabrication)/i.test(
        statement,
      )
    ) {
      throw new Error(
        `Canonical ${label} status provenance fabricates cached_snapshot`,
      );
    }
  }
}

function assertOperatorDocumentation(readmeText, securityText) {
  const status =
    "The all-ten production registry and Phase 5 release gates are active. The package is a standalone `0.1.0` release candidate; only the separately leased live-hardware validation and publication/release steps remain.";
  if (
    !readmeText.includes(status) ||
    /(?:production registry remains inactive|lists no production tools|no public CLI entry point)/i.test(
      readmeText,
    ) ||
    !readmeText.includes("## Standalone CLI") ||
    !/device-keyed lease/i.test(readmeText)
  ) {
    throw new Error(
      "Phase 4 production activation and standalone CLI documentation drifted",
    );
  }
  if (
    !readmeText.includes(
      "Coordinates are interpreted against the source image geometry",
    ) ||
    !/fresh single-use observation/i.test(readmeText)
  ) {
    throw new Error("Phase 3 coordinate and observation documentation drifted");
  }
  if (
    !readmeText.includes(
      "Physical keyboard actions accept canonical physical keys only",
    ) ||
    !/Reliable Paste/i.test(readmeText)
  ) {
    throw new Error(
      "Phase 3 physical keyboard versus paste documentation drifted",
    );
  }
  if (
    !readmeText.includes("nominal ~91 source characters per second") ||
    !/terminal.*target application|target application.*terminal/i.test(
      readmeText,
    )
  ) {
    throw new Error(
      "Phase 3 91 cps and terminal semantics documentation drifted",
    );
  }
  if (
    !readmeText.includes("Release is the recovery primitive") ||
    !/inspect.*release.*reconnect.*fresh capture/i.test(readmeText)
  ) {
    throw new Error("Phase 3 release recovery documentation drifted");
  }
  if (
    !readmeText.includes("per-fact provenance") ||
    !/cached_event.*none.*unknown/is.test(readmeText)
  ) {
    throw new Error("Phase 3 display provenance documentation drifted");
  }
  if (!readmeText.includes("read-only EDID")) {
    throw new Error("Phase 3 read-only EDID documentation drifted");
  }
  const atxAcknowledgementDeclaration =
    "export JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT='selected_fixture_has_no_usable_atx_motherboard_leads'";
  if (
    countOccurrences(readmeText, atxAcknowledgementDeclaration) !== 1 ||
    /JETKVM_RELEASE_ATX_UNAVAILABLE_ACK=/u.test(readmeText)
  ) {
    throw new Error(
      "Hardware release ATX-unavailable acknowledgement documentation drifted",
    );
  }
  if (
    !/preserve the browser sandbox/i.test(securityText) ||
    !securityText.includes("authorized MCP image content block")
  ) {
    throw new Error(
      "Phase 3 browser sandbox and image privacy documentation drifted",
    );
  }
  if (!securityText.includes("paste text is ephemeral")) {
    throw new Error("Phase 3 paste text must remain documented as ephemeral");
  }
}

export function checkDocsConsistency({
  designText,
  planText,
  readmeText,
  securityText,
  packageJson,
  uiPackageJson,
  storyIds,
}) {
  for (const [label, text] of [
    ["design", designText],
    ["plan", planText],
  ]) {
    assertCanonicalBrowserPlaneContract(text, label);
    assertCanonicalStatusProvenance(text, label);
  }
  assertOperatorDocumentation(readmeText, securityText);
  if (
    countOccurrences(designText, "    content_index: 1;") !== 1 ||
    !planText.includes(
      "public `DisplayCaptureResult.image.content_index` is the literal `1`",
    )
  ) {
    throw new Error(
      "Canonical content_index declaration must remain literal 1",
    );
  }
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
  const designTools = rawMatches(designToolSection, /^\d+\. `([a-z0-9_]+)`$/gm);
  const planTools = rawMatches(planToolSection, /^\|\s*`([a-z0-9_]+)`\s*\|/gm);
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

  const designPhaseRows = extractDesignPhaseRows(designText);
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
  if (scripts?.["test:phase3"] !== REQUIRED_MCP_PHASE3_SCRIPT) {
    throw new Error(
      "Phase 3 MCP test:phase3 hook must contain the exact focused gate",
    );
  }
  if (scripts?.typecheck !== REQUIRED_MCP_TYPECHECK_SCRIPT) {
    throw new Error("Phase 3 MCP typecheck hook must remain deterministic");
  }
  const uiScripts = uiPackageJson?.scripts;
  if (uiScripts?.["test:phase3"] !== REQUIRED_UI_PHASE3_SCRIPT) {
    throw new Error(
      "Phase 3 UI test:phase3 hook must contain the exact focused gate",
    );
  }
  if (uiScripts?.typecheck !== REQUIRED_UI_TYPECHECK_SCRIPT) {
    throw new Error("Phase 3 UI typecheck hook must remain deterministic");
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
  const [
    designText,
    planText,
    readmeText,
    securityText,
    packageJsonText,
    uiPackageJsonText,
    storyFiles,
  ] = await Promise.all([
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
    readFile(resolve(packageRoot, "README.md"), "utf8"),
    readFile(resolve(packageRoot, "SECURITY.md"), "utf8"),
    readFile(resolve(packageRoot, "package.json"), "utf8"),
    readFile(resolve(repositoryRoot, "ui/package.json"), "utf8"),
    readdir(storiesDirectory),
  ]);
  const storyIds = storyFiles
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => name.replace(/^\d{2}-/, "").replace(/\.json$/, ""));

  const result = checkDocsConsistency({
    designText,
    planText,
    readmeText,
    securityText,
    packageJson: JSON.parse(packageJsonText),
    uiPackageJson: JSON.parse(uiPackageJsonText),
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
