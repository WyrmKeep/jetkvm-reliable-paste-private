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
const readmePath = resolve(packageRoot, "README.md");
const securityPath = resolve(packageRoot, "SECURITY.md");

const [designText, planText, readmeText, securityText, storyFileNames] =
  await Promise.all([
    readFile(designPath, "utf8"),
    readFile(planPath, "utf8"),
    readFile(readmePath, "utf8"),
    readFile(securityPath, "utf8"),
    readdir(storiesDirectory),
  ]);

const storyIds = storyFileNames
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => name.replace(/^\d{2}-/, "").replace(/\.json$/, ""));

const mcpPhase3Command =
  "vitest run src/browser/bridgeProtocol.test.ts src/browser/BrowserController.test.ts src/browser/frames.test.ts src/browser/geometry.test.ts src/handlers/inputDisplay.matrix.test.ts src/native/JetKvmNativeControlPlane.test.ts src/planes/JetKvmBrowserPlane.test.ts src/test-support/PlaneSeams.test.ts src/test-support/ReplayPlanes.test.ts src/test-support/uiFixture.test.ts src/stories/manifest.test.ts src/stories/phase3.acceptance.test.ts && node --test scripts/check-docs-consistency.test.mjs";
const uiPhase3Command =
  "vitest run --config vitest.config.ts src/automation/bridge.test.ts src/automation/capture.test.ts src/automation/controller.test.ts src/automation/inputGuard.test.ts src/automation/paste.test.ts src/hooks/hidRpc.test.ts src/hooks/useJsonRpc.test.ts src/utils/hidRpcTransport.test.ts src/utils/keepaliveScheduler.test.ts src/utils/pasteBatches.test.ts src/utils/pasteMacro.test.ts src/utils/pasteText.test.ts";

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
    "test:phase3": mcpPhase3Command,
    typecheck: "tsc -p tsconfig.json --noEmit",
  },
};
const validUiPackageJson = {
  scripts: {
    "test:phase3": uiPhase3Command,
    typecheck: "npm run i18n:compile && tsc --noEmit -p tsconfig.app.json",
  },
};

const observationGeometryDeclaration = `interface ObservationGeometry {
  readonly contentX: number;
  readonly contentY: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
}`;
const browserCaptureMimeTypeDeclaration = `type BrowserCaptureMimeType = "image/jpeg" | "image/png";`;

function check(overrides = {}) {
  return checkDocsConsistency({
    designText,
    planText,
    readmeText,
    securityText,
    packageJson: validPackageJson,
    uiPackageJson: validUiPackageJson,
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

test("rejects BrowserPlane byte, artifact, capture-return, and shared-binding drift", () => {
  for (const [label, textKey, text] of [
    ["design", "designText", designText],
    ["plan", "planText", planText],
  ]) {
    const observationWithBytes = text.replace(
      "  readonly byteLength: number;\n}",
      "  readonly byteLength: number;\n  readonly bytes: Uint8Array;\n}",
    );
    assert.throws(
      () => check({ [textKey]: observationWithBytes }),
      /byte-free Observation/i,
      `${label} must keep Observation byte-free`,
    );

    const missingArtifactBytes = text.replace(
      "  readonly bytes: Uint8Array;",
      "  readonly data: string;",
    );
    assert.throws(
      () => check({ [textKey]: missingArtifactBytes }),
      /BrowserCaptureImage/i,
      `${label} must define the authorized capture image`,
    );

    const wrongCaptureReturn = text.replace(
      "  ): Promise<BrowserCaptureArtifact>;",
      "  ): Promise<Observation>;",
    );
    assert.throws(
      () => check({ [textKey]: wrongCaptureReturn }),
      /BrowserPlane capture contract/i,
      `${label} must return the capture artifact`,
    );

    const optionalBinding = text.replace(
      "  readonly binding: DeviceRpcBinding;",
      "  readonly binding?: DeviceRpcBinding;",
    );
    assert.throws(
      () => check({ [textKey]: optionalBinding }),
      /BrowserConnection binding contract/i,
      `${label} must require the exact BrowserConnection binding fields`,
    );

    const optionalSharedAdapter = text.replaceAll(
      "  readonly deviceRpc: DeviceRpcAdapter;",
      "  readonly deviceRpc?: DeviceRpcAdapter;",
    );
    assert.throws(
      () => check({ [textKey]: optionalSharedAdapter }),
      /shared deviceRpc contract/i,
      `${label} must require the shared adapter`,
    );
  }
});

test("rejects nested bytes and extra fields in ObservationGeometry in either canonical document", () => {
  for (const [label, textKey, text] of [
    ["design", "designText", designText],
    ["plan", "planText", planText],
  ]) {
    const nestedBytes = text.replace(
      "  readonly contentHeight: number;\n}",
      "  readonly contentHeight: number;\n  readonly bytes: Uint8Array;\n}",
    );
    assert.throws(
      () => check({ [textKey]: nestedBytes }),
      /ObservationGeometry/i,
      `${label} must keep ObservationGeometry byte-free`,
    );

    const extraGeometryField = text.replace(
      "  readonly contentHeight: number;\n}",
      "  readonly contentHeight: number;\n  readonly scale: number;\n}",
    );
    assert.throws(
      () => check({ [textKey]: extraGeometryField }),
      /ObservationGeometry/i,
      `${label} must keep ObservationGeometry exact`,
    );
  }
});

test("rejects widened or duplicate referenced capture declarations in either canonical document", () => {
  for (const [label, textKey, text] of [
    ["design", "designText", designText],
    ["plan", "planText", planText],
  ]) {
    const widenedMimeType = text.replace(
      browserCaptureMimeTypeDeclaration,
      `type BrowserCaptureMimeType = "image/jpeg" | "image/png" | "image/webp";`,
    );
    assert.throws(
      () => check({ [textKey]: widenedMimeType }),
      /BrowserCaptureMimeType/i,
      `${label} must reject MIME widening`,
    );

    const duplicateGeometry = text.replace(
      observationGeometryDeclaration,
      `${observationGeometryDeclaration}\n\n${observationGeometryDeclaration}`,
    );
    assert.throws(
      () => check({ [textKey]: duplicateGeometry }),
      /ObservationGeometry/i,
      `${label} must define ObservationGeometry once`,
    );

    const duplicateMimeType = text.replace(
      browserCaptureMimeTypeDeclaration,
      `${browserCaptureMimeTypeDeclaration}\n${browserCaptureMimeTypeDeclaration}`,
    );
    assert.throws(
      () => check({ [textKey]: duplicateMimeType }),
      /BrowserCaptureMimeType/i,
      `${label} must define BrowserCaptureMimeType once`,
    );
  }
});

test("rejects native video status provenance drift in either canonical document", () => {
  for (const [textKey, text] of [
    ["designText", designText],
    ["planText", planText],
  ]) {
    const fabricatedSnapshot = text.replace(
      "`getVideoState` validates state only and never creates `cached_snapshot`.",
      "`getVideoState` creates `cached_snapshot`.",
    );
    assert.throws(
      () => check({ [textKey]: fabricatedSnapshot }),
      /status provenance/i,
    );

    const eventLosesToPoll = text.replace(
      "A valid `videoInputState` event wins every concurrent or later poll, and fact age derives from that event's recorded timestamp.",
      "A later poll replaces any prior event and resets fact age.",
    );
    assert.throws(
      () => check({ [textKey]: eventLosesToPoll }),
      /status provenance/i,
    );
  }
});

test("rejects public capture content-index drift from literal 1", () => {
  const driftedDesign = designText.replace(
    "    content_index: 1;",
    "    content_index: number;",
  );
  assert.throws(
    () => check({ designText: driftedDesign }),
    /content_index.*literal 1/i,
  );

  const driftedPlan = planText.replace(
    "public `DisplayCaptureResult.image.content_index` is the literal `1`",
    "public `DisplayCaptureResult.image.content_index` is a number",
  );
  assert.throws(
    () => check({ planText: driftedPlan }),
    /content_index.*literal 1/i,
  );
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
    /^(\|\s*)`jetkvm_power_control`/m,
    "$1`jetkvm_power_cycle`",
  );
  assert.throws(
    () => check({ planText: driftedPlan }),
    /exact ten tool names/i,
  );
});

test("rejects a duplicate tool row in either canonical inventory", () => {
  const duplicateDesignRow = designText.replace(
    "10. `jetkvm_power_control`",
    "10. `jetkvm_power_control`\n10. `jetkvm_power_control`",
  );
  assert.throws(
    () => check({ designText: duplicateDesignRow }),
    /exact ten tool names/i,
  );

  const duplicatePlanRow = planText.replace(
    /^(\|\s*`jetkvm_power_control`[^\n]*)$/m,
    "$1\n$1",
  );
  assert.throws(
    () => check({ planText: duplicatePlanRow }),
    /exact ten tool names/i,
  );
});

test("rejects nullable success identity in either canonical document", () => {
  const makeSuccessIdentityNullable = (text) =>
    text.replace(
      /(type Success<T> = \{[\s\S]*?session_id:)\s*string;/,
      "$1 string | null;",
    );

  assert.throws(
    () => check({ designText: makeSuccessIdentityNullable(designText) }),
    /Success contract must require non-null session identity/i,
  );
  assert.throws(
    () => check({ planText: makeSuccessIdentityNullable(planText) }),
    /Success contract must require non-null session identity/i,
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

test("rejects duplicate and missing parsed phase numbers", () => {
  const duplicateTwoMissingThree = planText.replace(
    "# Phase 3 — Input and display PR",
    "# Phase 2 — Input and display PR",
  );
  assert.throws(
    () => check({ planText: duplicateTwoMissingThree }),
    /phase numbers.*1.*2.*3.*4.*5.*6/i,
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

test("rejects missing or drifted Phase 3 MCP/UI test and typecheck hooks", () => {
  for (const [packageKey, valid, scriptName] of [
    ["packageJson", validPackageJson, "test:phase3"],
    ["packageJson", validPackageJson, "typecheck"],
    ["uiPackageJson", validUiPackageJson, "test:phase3"],
    ["uiPackageJson", validUiPackageJson, "typecheck"],
  ]) {
    const candidate = structuredClone(valid);
    delete candidate.scripts[scriptName];
    assert.throws(
      () => check({ [packageKey]: candidate }),
      new RegExp(`Phase 3.*${scriptName}|${scriptName}.*Phase 3`, "i"),
    );

    candidate.scripts[scriptName] = "vitest run";
    assert.throws(
      () => check({ [packageKey]: candidate }),
      new RegExp(`Phase 3.*${scriptName}|${scriptName}.*Phase 3`, "i"),
    );
  }
});

test("rejects Phase 3 semantic drift or production activation drift", () => {
  for (const [replacement, expected] of [
    [
      "Coordinates are interpreted against the source image geometry",
      /coordinate.*observation/i,
    ],
    [
      "Physical keyboard actions accept canonical physical keys only",
      /physical keyboard.*paste/i,
    ],
    ["nominal ~91 source characters per second", /91.*terminal/i],
    ["Release is the recovery primitive", /release.*recovery/i],
    ["per-fact provenance", /display.*provenance/i],
    ["read-only EDID", /read-only EDID/i],
  ]) {
    assert.throws(
      () => check({ readmeText: readmeText.replace(replacement, "drifted") }),
      expected,
    );
  }

  assert.throws(
    () =>
      check({
        readmeText: readmeText.replace(
          "The all-ten production registry and Phase 5 release gates are active.",
          "The production registry remains inactive.",
        ),
      }),
    /Phase 4 production activation/i,
  );
  assert.throws(
    () =>
      check({
        readmeText: readmeText.replace("## Standalone CLI", "## Library only"),
      }),
    /Phase 4 production activation/i,
  );
  assert.throws(
    () =>
      check({
        securityText: securityText
          .replace("browser sandbox", "browser isolation")
          .replace("authorized MCP image content block", "ordinary log"),
      }),
    /browser sandbox.*image privacy/i,
  );
  assert.throws(
    () =>
      check({
        securityText: securityText.replace(
          "paste text is ephemeral",
          "paste text may be retained",
        ),
      }),
    /paste text.*ephemeral/i,
  );
});

test("rejects a drifted ATX-unavailable acknowledgement command", () => {
  assert.throws(
    () =>
      check({
        readmeText: readmeText.replace(
          "JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT=",
          "JETKVM_RELEASE_ATX_UNAVAILABLE_ACK=",
        ),
      }),
    /ATX-unavailable acknowledgement documentation drifted/u,
  );
});
