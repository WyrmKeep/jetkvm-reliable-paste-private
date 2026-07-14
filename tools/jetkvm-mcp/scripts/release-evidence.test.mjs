import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertCurrentRuntimeMatchesCandidate,
  buildDirectoryManifest,
  buildReleaseCandidateManifest,
  canonicalJson,
  createExecutionEvidenceResolver,
  sha256Canonical,
  sha256File,
  sha256Text,
  validateReleaseCandidateManifest,
} from "./release-evidence.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const GIT_A = "a".repeat(40);
const GIT_B = "b".repeat(40);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

function candidateInput() {
  return {
    packageName: "@wyrmkeep/jetkvm-mcp",
    packageVersion: "0.1.0",
    commitSha: GIT_A,
    treeSha: GIT_B,
    packageLockSha256: HASH_C,
    storyManifestSha256: HASH_D,
    storyCount: 24,
    schemasSha256: HASH_E,
    schemaCount: 21,
    branchMatrixSha256: HASH_F,
    storyE2eSha256: HASH_1,
    nodeVersion: "v22.23.1",
    nodeExecutableName: "node",
    nodeExecutableSha256: HASH_2,
    platform: "darwin",
    architecture: "arm64",
    browserExecutableName: "Google Chrome",
    browserExecutableSha256: HASH_A,
    browserHeadless: false,
    browserChromiumSandbox: true,
    browserLaunchArgs: [],
    browserTargetUrlSha256: HASH_B,
    browserCredentialSource: "environment",
    browserManagedProfile: "ephemeral",
    artifactFilename: "wyrmkeep-jetkvm-mcp-0.1.0.tgz",
    artifactSizeBytes: 1234,
    artifactSha256: HASH_A,
    packageFiles: [
      {
        path: "package.json",
        mode: 0o644,
        size_bytes: 12,
        sha256: HASH_B,
      },
      {
        path: "dist/bin.js",
        mode: 0o755,
        size_bytes: 34,
        sha256: HASH_C,
      },
    ],
  };
}

test("canonical JSON and hashes are independent of object insertion order", () => {
  const left = { z: [{ b: 2, a: 1 }], a: true };
  const right = { a: true, z: [{ a: 1, b: 2 }] };

  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(sha256Canonical(left), sha256Canonical(right));
});

test("directory manifests are sorted, content-addressed, and reject symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "jetkvm-release-manifest-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "z.txt"), "last", { mode: 0o600 });
    await writeFile(join(root, "nested", "a.txt"), "first", { mode: 0o644 });

    const manifest = await buildDirectoryManifest(root);
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["nested/a.txt", "z.txt"],
    );
    assert.match(manifest.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(manifest.files[0].size_bytes, 5);
    assert.equal(manifest.files[1].mode, 0o600);

    await symlink("z.txt", join(root, "linked.txt"));
    await assert.rejects(
      buildDirectoryManifest(root),
      /Release manifests forbid symbolic links/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate manifests bind every frozen source, runtime, and package identity", () => {
  const candidate = buildReleaseCandidateManifest(candidateInput());

  assert.deepEqual(validateReleaseCandidateManifest(candidate), candidate);
  assert.equal(candidate.source.commit_sha, GIT_A);
  assert.equal(candidate.source.tree_sha, GIT_B);
  assert.equal(candidate.source.story_manifest.count, 24);
  assert.equal(candidate.runtime.node.version, "v22.23.1");
  assert.equal(candidate.runtime.browser.chromium_sandbox, true);
  assert.equal(candidate.runtime.browser.headless, false);
  assert.deepEqual(candidate.runtime.browser.launch_args, []);
  assert.equal(candidate.runtime.browser.target_url_sha256, HASH_B);
  assert.equal(candidate.artifact.files.length, 2);
  assert.equal(
    candidate.artifact.package_tree_sha256,
    sha256Canonical(candidate.artifact.files),
  );
  assert.equal(Object.isFrozen(candidate), true);
});

test("matches the executing Node, browser, platform, and target to the frozen candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-match-"));
  try {
    const nodePath = join(root, "node");
    const browserPath = join(root, "Google Chrome");
    await writeFile(nodePath, "node-runtime");
    await writeFile(browserPath, "browser-runtime");
    const targetUrl = "http://192.0.2.1";
    const input = candidateInput();
    input.nodeExecutableSha256 = await sha256File(nodePath);
    input.browserExecutableSha256 = await sha256File(browserPath);
    input.browserTargetUrlSha256 = sha256Text(targetUrl);
    const candidate = buildReleaseCandidateManifest(input);
    const runtime = {
      nodeVersion: "v22.23.1",
      nodeExecutablePath: nodePath,
      platform: "darwin",
      architecture: "arm64",
      browserExecutablePath: browserPath,
      targetUrl,
    };

    await assert.doesNotReject(
      assertCurrentRuntimeMatchesCandidate(candidate, runtime),
    );
    for (const [field, value] of [
      ["nodeVersion", "v22.23.2"],
      ["nodeExecutablePath", browserPath],
      ["platform", "linux"],
      ["architecture", "x64"],
      ["browserExecutablePath", nodePath],
      ["targetUrl", "http://192.0.2.2"],
    ]) {
      await assert.rejects(
        assertCurrentRuntimeMatchesCandidate(candidate, {
          ...runtime,
          [field]: value,
        }),
        /runtime did not match the frozen candidate/u,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate validation fails closed on drift, extra fields, and private paths", () => {
  const candidate = structuredClone(
    buildReleaseCandidateManifest(candidateInput()),
  );

  candidate.artifact.files[0].sha256 = HASH_D;
  assert.throws(
    () => validateReleaseCandidateManifest(candidate),
    /package tree hash does not match/u,
  );

  const extra = structuredClone(
    buildReleaseCandidateManifest(candidateInput()),
  );
  extra.target_url = "https://192.168.1.110";
  assert.throws(
    () => validateReleaseCandidateManifest(extra),
    /unexpected candidate field/u,
  );

  const privatePath = candidateInput();
  privatePath.nodeExecutableName = "/Users/operator/.nvm/node";
  assert.throws(
    () => buildReleaseCandidateManifest(privatePath),
    /executable name must be a basename/u,
  );

  const unsafeBrowser = candidateInput();
  unsafeBrowser.browserHeadless = true;
  assert.throws(
    () => buildReleaseCandidateManifest(unsafeBrowser),
    /visible for hardware release/u,
  );
});

test("resolves linked steps to exact passing assertion or scenario identities", () => {
  const resolver = createExecutionEvidenceResolver({
    branchMatrix: {
      cells: [
        {
          applicability: "applicable",
          story_id: "story-a",
          step_id: "focused-step",
          focused_assertion_id: "unit:focused-step",
          test_file: "src/focused.test.ts",
          test_identity: "Focused suite > focused step",
          execution_result: "pass",
        },
        {
          applicability: "not_applicable",
          requirement: "branch:irrelevant",
          tool: "jetkvm_display_status",
          rationale: "Reviewed and irrelevant.",
        },
      ],
    },
    storyE2e: {
      scenarios: [
        {
          story_id: "story-a",
          scenario_id: "story-a:success",
          step_ids: ["focused-step", "fixture-step"],
          grounded_test_identities: ["Focused suite > focused step"],
          result: "pass",
        },
      ],
    },
  });

  assert.deepEqual(
    resolver({ id: "story-a" }, { id: "focused-step" }, "linked"),
    ["focused:unit:focused-step"],
  );
  assert.deepEqual(
    resolver({ id: "story-a" }, { id: "fixture-step" }, "linked"),
    ["scenario:story-a:success"],
  );
  assert.deepEqual(
    resolver({ id: "story-a" }, { id: "fixture-step" }, "controlled_live"),
    ["controlled:story-a:fixture-step"],
  );
  assert.throws(
    () => resolver({ id: "story-a" }, { id: "missing-step" }, "linked"),
    /lacks execution-produced evidence/u,
  );
});
