import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { browserLaunchArgsForTarget } from "../src/browser/browserLaunchPolicy.mjs";

import { freezeReleaseCandidate } from "./freeze-release-candidate.mjs";
import { ATX_UNAVAILABLE_ACKNOWLEDGEMENT } from "./hardware-validation-profile.mjs";
import {
  buildDirectoryManifest,
  sha256Canonical,
  sha256File,
  validateReleaseCandidateManifest,
} from "./release-evidence.mjs";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}
async function cleanupFixture(fixture) {
  await chmod(fixture.outputDirectory, 0o700).catch(() => undefined);
  await chmod(join(fixture.outputDirectory, "paste-harness"), 0o700).catch(
    () => undefined,
  );
  await rm(fixture.root, { recursive: true, force: true });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "jetkvm-candidate-freeze-"));
  const repositoryRoot = join(root, "repository");
  const packageRoot = join(repositoryRoot, "tools", "jetkvm-mcp");
  const outputDirectory = join(root, "candidate");
  const unpackedSource = join(root, "unpacked-source");
  const nodeExecutablePath = join(root, "node");
  const browserExecutablePath = join(root, "Google Chrome");
  const controlledEvidencePath = join(root, "controlled-evidence.json");
  await mkdir(packageRoot, { recursive: true });
  await writeJson(join(packageRoot, "package.json"), {
    name: "@wyrmkeep/jetkvm-mcp",
    version: "0.1.0",
    bin: { "jetkvm-mcp": "dist/bin.js" },
  });
  await writeJson(join(packageRoot, "package-lock.json"), {
    name: "@wyrmkeep/jetkvm-mcp",
    version: "0.1.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "@wyrmkeep/jetkvm-mcp",
        version: "0.1.0",
      },
    },
  });
  for (let index = 1; index <= 24; index += 1) {
    await writeJson(
      join(
        packageRoot,
        "src",
        "stories",
        `${String(index).padStart(2, "0")}.json`,
      ),
      { id: `story-${index}` },
    );
  }
  await writeFile(
    join(packageRoot, "src", "stories", "manifest.ts"),
    "ignored\n",
  );
  for (let index = 1; index <= 21; index += 1) {
    await writeJson(join(packageRoot, "schemas", `${index}.json`), { index });
  }
  await writeJson(join(packageRoot, "reports", "branch-matrix.json"), {
    schema_version: 1,
  });
  await writeJson(join(packageRoot, "reports", "story-e2e.json"), {
    schema_version: 1,
  });
  const harnessDist = join(repositoryRoot, "tools", "paste-harness", "dist");
  await mkdir(harnessDist, { recursive: true });
  await writeFile(join(harnessDist, "rig.js"), "export const rig = true;\n");
  await writeJson(join(unpackedSource, "package.json"), {
    name: "@wyrmkeep/jetkvm-mcp",
    version: "0.1.0",
    bin: { "jetkvm-mcp": "dist/bin.js" },
  });
  await mkdir(join(unpackedSource, "dist"), { recursive: true });
  await writeFile(
    join(unpackedSource, "dist", "bin.js"),
    "#!/usr/bin/env node\n",
    { mode: 0o644 },
  );
  await writeFile(nodeExecutablePath, "node-binary");
  await writeFile(browserExecutablePath, "browser-binary");
  await writeJson(controlledEvidencePath, {
    "controlled:story:step": { result: "pass" },
  });
  return {
    root,
    repositoryRoot,
    packageRoot,
    outputDirectory,
    unpackedSource,
    nodeExecutablePath,
    browserExecutablePath,
    browserTargetUrl: "http://192.0.2.1",
    controlledEvidencePath,
    hardwareValidationEnvironment: {},
  };
}

function commandHarness(
  fixture,
  statusValues = ["", ""],
  { mutateStagedArtifact = false } = {},
) {
  const calls = [];
  const locations = [];
  let statusIndex = 0;
  let stagedArtifactPath;
  const runCommand = async (command, args, { cwd } = {}) => {
    calls.push([command, ...args]);
    locations.push({ command, args: [...args], cwd });
    if (command === "git" && args[0] === "worktree" && args[1] === "add") {
      await cp(fixture.repositoryRoot, args[3], { recursive: true });
      return "";
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
      await rm(args.at(-1), { recursive: true, force: true });
      return "";
    }
    if (command === "git" && args[0] === "status") {
      return statusValues[statusIndex++] ?? statusValues.at(-1) ?? "";
    }
    if (command === "git" && args.join(" ") === "rev-parse HEAD^{commit}") {
      return `${COMMIT}\n`;
    }
    if (command === "git" && args.join(" ") === "rev-parse HEAD^{tree}") {
      return `${TREE}\n`;
    }
    if (command === "npm" && args.join(" ") === "run build") {
      if (cwd.endsWith(join("tools", "paste-harness"))) {
        const harnessDist = join(cwd, "dist");
        await mkdir(harnessDist, { recursive: true });
        await writeFile(
          join(harnessDist, "rig.js"),
          "export const rig = true;\n",
        );
      }
      return "";
    }
    if (command === "npm" && args[0] === "pack") {
      const filename = "wyrmkeep-jetkvm-mcp-0.1.0.tgz";
      const destination = args[args.indexOf("--pack-destination") + 1];
      stagedArtifactPath = join(destination, filename);
      await writeFile(stagedArtifactPath, "frozen-tarball");
      return `${JSON.stringify([{ filename }])}\n`;
    }
    if (
      command === "npm" &&
      args[0] === "install" &&
      args.includes("--package-lock-only")
    ) {
      if (mutateStagedArtifact) {
        await writeFile(stagedArtifactPath, "concurrent-mutation");
      }
      const consumer = JSON.parse(
        await readFile(join(cwd, "package.json"), "utf8"),
      );
      await writeJson(join(cwd, "package-lock.json"), {
        name: consumer.name,
        version: consumer.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": consumer,
          "node_modules/@wyrmkeep/jetkvm-mcp": {
            version: "0.1.0",
            resolved: "file:wyrmkeep-jetkvm-mcp-0.1.0.tgz",
          },
        },
      });
      return "";
    }
    if (command === "npm" && args[0] === "ci" && !args.includes("--omit=dev")) {
      return "";
    }
    if (command === "npm" && args[0] === "ci") {
      const installedPackage = join(
        cwd,
        "node_modules",
        "@wyrmkeep",
        "jetkvm-mcp",
      );
      await cp(fixture.unpackedSource, installedPackage, { recursive: true });
      await chmod(join(installedPackage, "dist", "bin.js"), 0o755);
      return "";
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, locations, runCommand };
}

test("freezes one clean candidate and binds the exact unpacked package tree", async () => {
  const fixture = await createFixture();
  const commands = commandHarness(fixture);
  try {
    const result = await freezeReleaseCandidate({
      ...fixture,
      runCommand: commands.runCommand,
      nodeVersion: "v22.23.1",
      platform: "darwin",
      architecture: "arm64",
    });

    assert.equal((await stat(fixture.outputDirectory)).mode & 0o777, 0o500);
    for (const path of [
      result.candidatePath,
      result.checksumPath,
      result.tarballPath,
      result.consumerPackagePath,
      result.consumerPackageLockPath,
      result.controlledEvidencePath,
    ]) {
      assert.equal((await stat(path)).mode & 0o777, 0o400);
    }
    const frozenHarnessPath = join(
      fixture.outputDirectory,
      "paste-harness",
      "rig.js",
    );
    assert.equal((await stat(frozenHarnessPath)).mode & 0o777, 0o400);
    assert.equal(
      await readFile(frozenHarnessPath, "utf8"),
      "export const rig = true;\n",
    );
    const parsed = validateReleaseCandidateManifest(
      JSON.parse(await readFile(result.candidatePath, "utf8")),
    );
    assert.deepEqual(parsed.hardware_validation, {
      profile: "full",
      exception_code: null,
    });
    assert.equal(parsed.source.commit_sha, COMMIT);
    assert.equal(parsed.source.tree_sha, TREE);
    assert.equal(parsed.source.story_manifest.count, 24);
    assert.equal(parsed.source.schemas.count, 21);
    assert.match(parsed.source.paste_harness.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      parsed.source.paste_harness.sha256,
      (
        await buildDirectoryManifest(
          join(fixture.outputDirectory, "paste-harness"),
        )
      ).sha256,
    );
    assert.deepEqual(
      parsed.artifact.files.map((file) => file.path),
      ["dist/bin.js", "package.json"],
    );
    assert.equal(
      parsed.artifact.files.find((file) => file.path === "dist/bin.js").mode,
      0o755,
    );
    assert.equal(
      parsed.runtime.node.executable_sha256,
      await sha256File(fixture.nodeExecutablePath),
    );
    assert.equal(
      parsed.runtime.browser.executable_sha256,
      await sha256File(fixture.browserExecutablePath),
    );
    assert.equal(parsed.runtime.browser.headless, false);
    assert.equal(parsed.runtime.browser.chromium_sandbox, true);
    assert.equal(
      parsed.runtime.browser.launch_args_sha256,
      sha256Canonical(browserLaunchArgsForTarget(fixture.browserTargetUrl)),
    );
    assert.equal(
      parsed.source.controlled_evidence_sha256,
      await sha256File(fixture.controlledEvidencePath),
    );
    assert.equal(
      await sha256File(result.controlledEvidencePath),
      await sha256File(fixture.controlledEvidencePath),
    );
    assert.equal(
      await sha256File(result.consumerPackagePath),
      parsed.installation.package_json.sha256,
    );
    assert.equal(
      await sha256File(result.consumerPackageLockPath),
      parsed.installation.package_lock.sha256,
    );
    assert.equal(parsed.installation.files.length, 2);
    assert.equal(
      await readFile(result.checksumPath, "utf8"),
      `${await sha256File(result.candidatePath)}  candidate.json\n`,
    );
    assert.equal(
      commands.calls.filter(
        ([command, first, second]) =>
          command === "npm" && first === "run" && second === "build",
      ).length,
      2,
    );
    assert.equal(
      commands.calls.filter(
        ([command, first]) => command === "npm" && first === "pack",
      ).length,
      1,
    );
    assert.equal(
      commands.calls.filter(
        ([command, first]) => command === "npm" && first === "ci",
      ).length,
      3,
    );
    const packLocation = commands.locations.find(
      (entry) => entry.command === "npm" && entry.args[0] === "pack",
    );
    assert.notEqual(packLocation.cwd, fixture.packageRoot);
    assert.equal(
      commands.calls.some(
        ([command, subcommand]) =>
          command === "git" && subcommand === "worktree",
      ),
      true,
    );
    assert.equal(
      commands.calls.filter(
        ([command, first, ...args]) =>
          command === "npm" &&
          first === "install" &&
          args.includes("--package-lock-only"),
      ).length,
      1,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("reuses the captured tarball bytes despite a concurrent path mutation", async () => {
  const fixture = await createFixture();
  const commands = commandHarness(fixture, ["", ""], {
    mutateStagedArtifact: true,
  });
  try {
    const result = await freezeReleaseCandidate({
      ...fixture,
      runCommand: commands.runCommand,
      nodeVersion: "v22.23.1",
      platform: "darwin",
      architecture: "arm64",
    });
    assert.equal(await readFile(result.tarballPath, "utf8"), "frozen-tarball");
    const parsed = JSON.parse(await readFile(result.candidatePath, "utf8"));
    assert.equal(parsed.artifact.sha256, await sha256File(result.tarballPath));
  } finally {
    await cleanupFixture(fixture);
  }
});

test("requires the exact ATX acknowledgement at the exported freeze boundary", async () => {
  const fixture = await createFixture();
  const commands = commandHarness(fixture);
  try {
    await assert.rejects(
      freezeReleaseCandidate({
        ...fixture,
        hardwareValidationEnvironment: {
          JETKVM_RELEASE_HARDWARE_PROFILE: "atx_unavailable",
        },
        runCommand: commands.runCommand,
        nodeVersion: "v22.23.1",
        platform: "darwin",
        architecture: "arm64",
      }),
      /acknowledgement/u,
    );
    assert.deepEqual(commands.calls, []);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("freezes the acknowledged ATX-unavailable profile", async () => {
  const fixture = await createFixture();
  const commands = commandHarness(fixture);
  try {
    const result = await freezeReleaseCandidate({
      ...fixture,
      hardwareValidationEnvironment: {
        JETKVM_RELEASE_HARDWARE_PROFILE: "atx_unavailable",
        JETKVM_RELEASE_ATX_UNAVAILABLE_ACKNOWLEDGEMENT:
          ATX_UNAVAILABLE_ACKNOWLEDGEMENT,
      },
      runCommand: commands.runCommand,
      nodeVersion: "v22.23.1",
      platform: "darwin",
      architecture: "arm64",
    });
    assert.deepEqual(result.candidate.hardware_validation, {
      profile: "atx_unavailable",
      exception_code: "ATX_WIRING_UNAVAILABLE",
    });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("refuses dirty source before build or candidate output", async () => {
  const fixture = await createFixture();
  const commands = commandHarness(fixture, [" M src/runtime.ts\n"]);
  try {
    await assert.rejects(
      freezeReleaseCandidate({
        ...fixture,
        runCommand: commands.runCommand,
        nodeVersion: "v22.23.1",
        platform: "darwin",
        architecture: "arm64",
      }),
      /Release candidate source tree is dirty/u,
    );
    assert.equal(
      commands.calls.some(([command]) => command === "npm"),
      false,
    );
    await assert.rejects(
      readFile(join(fixture.outputDirectory, "candidate.json")),
    );
  } finally {
    await cleanupFixture(fixture);
  }
});
