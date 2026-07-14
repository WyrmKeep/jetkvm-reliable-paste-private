import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._@/+-]+$/u;
const CANDIDATE_KEYS = Object.freeze([
  "schema_version",
  "kind",
  "package",
  "source",
  "runtime",
  "artifact",
]);

function isRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function normalizeJson(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON requires finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!isRecord(value))
    throw new Error("Canonical JSON requires plain JSON values.");
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        const child = value[key];
        if (child === undefined) {
          throw new Error("Canonical JSON forbids undefined values.");
        }
        return [key, normalizeJson(child)];
      }),
  );
}

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value));
}

export function sha256Canonical(value) {
  return sha256Bytes(canonicalJson(value));
}

export async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

function portableRelativePath(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("\\")
  ) {
    throw new Error("Release manifest path escaped its root.");
  }
  return value;
}

async function collectFiles(root, directory, files, include) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const facts = await lstat(path);
    if (facts.isSymbolicLink()) {
      throw new Error("Release manifests forbid symbolic links.");
    }
    if (facts.isDirectory()) {
      await collectFiles(root, path, files, include);
      continue;
    }
    if (!facts.isFile()) {
      throw new Error("Release manifests accept regular files only.");
    }
    const manifestPath = portableRelativePath(root, path);
    if (!include(manifestPath)) continue;
    files.push({
      path: manifestPath,
      mode: facts.mode & 0o777,
      size_bytes: facts.size,
      sha256: await sha256File(path),
    });
  }
}

export async function buildDirectoryManifest(
  root,
  { include = () => true } = {},
) {
  const files = [];
  await collectFiles(root, root, files, include);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const frozenFiles = files.map((file) => Object.freeze(file));
  return Object.freeze({
    files: Object.freeze(frozenFiles),
    sha256: sha256Canonical(frozenFiles),
  });
}

export function createExecutionEvidenceResolver({ branchMatrix, storyE2e }) {
  if (
    !isRecord(branchMatrix) ||
    !Array.isArray(branchMatrix.cells) ||
    !isRecord(storyE2e) ||
    !Array.isArray(storyE2e.scenarios)
  ) {
    throw new Error("Execution-produced release reports are malformed.");
  }
  const focusedByStep = new Map();
  const focusedEvidence = new Map();
  for (const cell of branchMatrix.cells) {
    if (!isRecord(cell)) {
      throw new Error(
        "Focused execution-produced release evidence is malformed.",
      );
    }
    if (cell.applicability === "not_applicable") continue;
    if (
      !isRecord(cell) ||
      cell.applicability !== "applicable" ||
      typeof cell.story_id !== "string" ||
      typeof cell.step_id !== "string" ||
      typeof cell.focused_assertion_id !== "string" ||
      typeof cell.test_file !== "string" ||
      typeof cell.test_identity !== "string" ||
      cell.execution_result !== "pass"
    ) {
      throw new Error(
        "Focused execution-produced release evidence is malformed.",
      );
    }
    const identity = `focused:${cell.focused_assertion_id}`;
    if (focusedEvidence.has(identity)) {
      throw new Error(
        "Focused release evidence contains a duplicate assertion ID.",
      );
    }
    focusedEvidence.set(
      identity,
      Object.freeze({
        assertion_id: cell.focused_assertion_id,
        test_file: cell.test_file,
        test_identity: cell.test_identity,
      }),
    );
    const key = `${cell.story_id}\u0000${cell.step_id}`;
    const identities = focusedByStep.get(key) ?? [];
    identities.push(identity);
    focusedByStep.set(key, identities);
  }
  const scenariosByStep = new Map();
  const scenarioEvidence = new Map();
  for (const scenario of storyE2e.scenarios) {
    if (
      !isRecord(scenario) ||
      typeof scenario.story_id !== "string" ||
      typeof scenario.scenario_id !== "string" ||
      !Array.isArray(scenario.step_ids) ||
      !Array.isArray(scenario.grounded_test_identities) ||
      scenario.grounded_test_identities.length === 0 ||
      scenario.result !== "pass"
    ) {
      throw new Error(
        "Story execution-produced release evidence is malformed.",
      );
    }
    const identity = `scenario:${scenario.scenario_id}`;
    if (scenarioEvidence.has(identity)) {
      throw new Error(
        "Story release evidence contains a duplicate scenario ID.",
      );
    }
    scenarioEvidence.set(
      identity,
      Object.freeze({
        scenario_id: scenario.scenario_id,
        test_identities: Object.freeze([...scenario.grounded_test_identities]),
      }),
    );
    for (const stepId of scenario.step_ids) {
      if (typeof stepId !== "string" || stepId.length === 0) {
        throw new Error("Story release evidence contains an invalid step ID.");
      }
      const key = `${scenario.story_id}\u0000${stepId}`;
      const identities = scenariosByStep.get(key) ?? [];
      identities.push(identity);
      scenariosByStep.set(key, identities);
    }
  }
  const resolver = (story, step, mode) => {
    if (mode === "controlled_live") {
      return [`controlled:${story.id}:${step.id}`];
    }
    const key = `${story.id}\u0000${step.id}`;
    const focused = focusedByStep.get(key);
    if (focused !== undefined && focused.length > 0) {
      return [...focused].sort();
    }
    const scenarios = scenariosByStep.get(key);
    if (scenarios !== undefined && scenarios.length > 0) {
      return [...scenarios].sort();
    }
    throw new Error(
      `Live step ${story.id}/${step.id} lacks execution-produced evidence.`,
    );
  };
  Object.defineProperty(resolver, "evidence", {
    value: Object.freeze({
      focused: Object.freeze(Object.fromEntries(focusedEvidence)),
      scenarios: Object.freeze(Object.fromEntries(scenarioEvidence)),
    }),
    enumerable: true,
  });
  return Object.freeze(resolver);
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`Found an unexpected candidate field in ${label}.`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertSafeName(value, label) {
  assertString(value, label);
  if (!SAFE_NAME_PATTERN.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

function assertBrowserExecutableName(value) {
  assertString(value, "Browser executable name");
  if (
    basename(value) !== value ||
    value.includes("\\") ||
    !/^[A-Za-z0-9][ A-Za-z0-9._+-]{0,127}$/u.test(value)
  ) {
    throw new Error("Browser executable name must be a safe basename.");
  }
}

function assertHash(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertGitObject(value, label) {
  if (typeof value !== "string" || !GIT_OBJECT_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase Git object identifier.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertFilePath(value) {
  assertString(value, "Artifact file path");
  if (
    value.startsWith("/") ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("/../") ||
    value.includes("\\")
  ) {
    throw new Error("Artifact file path must be package-relative.");
  }
}

function validateArtifactFile(value) {
  assertExactKeys(
    value,
    ["path", "mode", "size_bytes", "sha256"],
    "artifact file",
  );
  assertFilePath(value.path);
  if (
    !Number.isSafeInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0o777
  ) {
    throw new Error("Artifact file mode must be a Unix permission mode.");
  }
  if (!Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0) {
    throw new Error("Artifact file size must be a non-negative safe integer.");
  }
  assertHash(value.sha256, "Artifact file hash");
}

export function validateReleaseCandidateManifest(value) {
  assertExactKeys(value, CANDIDATE_KEYS, "candidate");
  if (value.schema_version !== 1) {
    throw new Error("Candidate schema version must be 1.");
  }
  if (value.kind !== "jetkvm-mcp-release-candidate") {
    throw new Error("Candidate kind is invalid.");
  }

  assertExactKeys(value.package, ["name", "version"], "candidate package");
  if (value.package.name !== "@wyrmkeep/jetkvm-mcp") {
    throw new Error("Candidate package name is invalid.");
  }
  if (value.package.version !== "0.1.0") {
    throw new Error("Candidate package version is invalid.");
  }

  assertExactKeys(
    value.source,
    [
      "commit_sha",
      "tree_sha",
      "package_lock",
      "story_manifest",
      "schemas",
      "branch_matrix_sha256",
      "story_e2e_sha256",
    ],
    "candidate source",
  );
  assertGitObject(value.source.commit_sha, "Candidate commit");
  assertGitObject(value.source.tree_sha, "Candidate tree");
  assertHash(value.source.branch_matrix_sha256, "Branch matrix hash");
  assertHash(value.source.story_e2e_sha256, "Story E2E hash");
  for (const [name, expectedPath, expectedCount] of [
    ["package_lock", "tools/jetkvm-mcp/package-lock.json", null],
    ["story_manifest", "tools/jetkvm-mcp/src/stories", 24],
    ["schemas", "tools/jetkvm-mcp/schemas", 21],
  ]) {
    const identity = value.source[name];
    assertExactKeys(
      identity,
      expectedCount === null ? ["path", "sha256"] : ["path", "count", "sha256"],
      `candidate ${name}`,
    );
    if (identity.path !== expectedPath) {
      throw new Error(`Candidate ${name} path is invalid.`);
    }
    if (expectedCount !== null && identity.count !== expectedCount) {
      throw new Error(`Candidate ${name} count is invalid.`);
    }
    assertHash(identity.sha256, `Candidate ${name} hash`);
  }

  assertExactKeys(value.runtime, ["node", "browser"], "candidate runtime");
  assertExactKeys(
    value.runtime.node,
    [
      "version",
      "executable_name",
      "executable_sha256",
      "platform",
      "architecture",
    ],
    "candidate Node runtime",
  );
  if (value.runtime.node.version !== "v22.23.1") {
    throw new Error("Candidate Node version must be v22.23.1.");
  }
  assertSafeName(value.runtime.node.executable_name, "Node executable name");
  if (
    basename(value.runtime.node.executable_name) !==
      value.runtime.node.executable_name ||
    value.runtime.node.executable_name.includes("\\")
  ) {
    throw new Error("Node executable name must be a basename.");
  }
  assertHash(value.runtime.node.executable_sha256, "Node executable hash");
  assertSafeName(value.runtime.node.platform, "Node platform");
  assertSafeName(value.runtime.node.architecture, "Node architecture");
  assertExactKeys(
    value.runtime.browser,
    [
      "executable_name",
      "executable_sha256",
      "headless",
      "chromium_sandbox",
      "launch_args",
      "target_url_sha256",
      "credential_source",
      "managed_profile",
    ],
    "candidate browser runtime",
  );
  assertBrowserExecutableName(value.runtime.browser.executable_name);
  assertHash(
    value.runtime.browser.executable_sha256,
    "Browser executable hash",
  );
  if (value.runtime.browser.headless !== false) {
    throw new Error("Candidate browser must be visible for hardware release.");
  }
  if (value.runtime.browser.chromium_sandbox !== true) {
    throw new Error("Candidate browser must enable the Chromium sandbox.");
  }
  if (
    !Array.isArray(value.runtime.browser.launch_args) ||
    value.runtime.browser.launch_args.length !== 0
  ) {
    throw new Error(
      "Candidate browser launch args must be the reviewed empty list.",
    );
  }
  assertHash(
    value.runtime.browser.target_url_sha256,
    "Browser target URL hash",
  );
  if (value.runtime.browser.credential_source !== "environment") {
    throw new Error("Candidate browser credential source is invalid.");
  }
  if (value.runtime.browser.managed_profile !== "ephemeral") {
    throw new Error("Candidate browser profile mode is invalid.");
  }

  assertExactKeys(
    value.artifact,
    ["filename", "size_bytes", "sha256", "package_tree_sha256", "files"],
    "candidate artifact",
  );
  assertSafeName(value.artifact.filename, "Artifact filename");
  if (
    basename(value.artifact.filename) !== value.artifact.filename ||
    !value.artifact.filename.endsWith(".tgz")
  ) {
    throw new Error("Artifact filename must be a tgz basename.");
  }
  assertPositiveInteger(value.artifact.size_bytes, "Artifact size");
  assertHash(value.artifact.sha256, "Artifact hash");
  assertHash(value.artifact.package_tree_sha256, "Package tree hash");
  if (
    !Array.isArray(value.artifact.files) ||
    value.artifact.files.length === 0
  ) {
    throw new Error("Candidate artifact must contain files.");
  }
  let previousPath = "";
  for (const file of value.artifact.files) {
    validateArtifactFile(file);
    if (file.path.localeCompare(previousPath) <= 0) {
      throw new Error("Artifact files must be uniquely sorted by path.");
    }
    previousPath = file.path;
  }
  if (
    sha256Canonical(value.artifact.files) !== value.artifact.package_tree_sha256
  ) {
    throw new Error(
      "Candidate package tree hash does not match its file manifest.",
    );
  }

  return deepFreeze(value);
}

export function buildReleaseCandidateManifest(input) {
  const files = input.packageFiles.map((file) => ({ ...file }));
  files.sort((left, right) => left.path.localeCompare(right.path));
  const candidate = {
    schema_version: 1,
    kind: "jetkvm-mcp-release-candidate",
    package: {
      name: input.packageName,
      version: input.packageVersion,
    },
    source: {
      commit_sha: input.commitSha,
      tree_sha: input.treeSha,
      package_lock: {
        path: "tools/jetkvm-mcp/package-lock.json",
        sha256: input.packageLockSha256,
      },
      story_manifest: {
        path: "tools/jetkvm-mcp/src/stories",
        count: input.storyCount,
        sha256: input.storyManifestSha256,
      },
      schemas: {
        path: "tools/jetkvm-mcp/schemas",
        count: input.schemaCount,
        sha256: input.schemasSha256,
      },
      branch_matrix_sha256: input.branchMatrixSha256,
      story_e2e_sha256: input.storyE2eSha256,
    },
    runtime: {
      node: {
        version: input.nodeVersion,
        executable_name: input.nodeExecutableName,
        executable_sha256: input.nodeExecutableSha256,
        platform: input.platform,
        architecture: input.architecture,
      },
      browser: {
        executable_name: input.browserExecutableName,
        executable_sha256: input.browserExecutableSha256,
        headless: input.browserHeadless,
        chromium_sandbox: input.browserChromiumSandbox,
        launch_args: [...input.browserLaunchArgs],
        target_url_sha256: input.browserTargetUrlSha256,
        credential_source: input.browserCredentialSource,
        managed_profile: input.browserManagedProfile,
      },
    },
    artifact: {
      filename: input.artifactFilename,
      size_bytes: input.artifactSizeBytes,
      sha256: input.artifactSha256,
      package_tree_sha256: sha256Canonical(files),
      files,
    },
  };
  return validateReleaseCandidateManifest(candidate);
}
