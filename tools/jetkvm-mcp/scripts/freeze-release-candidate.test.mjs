import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { freezeReleaseCandidate } from "./freeze-release-candidate.mjs";
import {
  sha256File,
  validateReleaseCandidateManifest,
} from "./release-evidence.mjs";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "jetkvm-candidate-freeze-"));
  const repositoryRoot = join(root, "repository");
  const packageRoot = join(repositoryRoot, "tools", "jetkvm-mcp");
  const outputDirectory = join(root, "candidate");
  const unpackedSource = join(root, "unpacked-source");
  const nodeExecutablePath = join(root, "node");
  const browserExecutablePath = join(root, "Google Chrome");
  await mkdir(packageRoot, { recursive: true });
  await writeJson(join(packageRoot, "package.json"), {
    name: "@wyrmkeep/jetkvm-mcp",
    version: "0.1.0",
    bin: { "jetkvm-mcp": "dist/bin.js" },
  });
  await writeJson(join(packageRoot, "package-lock.json"), {
    lockfileVersion: 3,
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
  return {
    root,
    repositoryRoot,
    packageRoot,
    outputDirectory,
    unpackedSource,
    nodeExecutablePath,
    browserExecutablePath,
    browserTargetUrl: "http://192.0.2.1",
  };
}

function commandHarness(fixture, statusValues = ["", ""]) {
  const calls = [];
  let statusIndex = 0;
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "status") {
      return statusValues[statusIndex++] ?? statusValues.at(-1) ?? "";
    }
    if (command === "git" && args.join(" ") === "rev-parse HEAD^{commit}") {
      return `${COMMIT}\n`;
    }
    if (command === "git" && args.join(" ") === "rev-parse HEAD^{tree}") {
      return `${TREE}\n`;
    }
    if (command === "npm" && args.join(" ") === "run build") return "";
    if (command === "npm" && args[0] === "pack") {
      const filename = "wyrmkeep-jetkvm-mcp-0.1.0.tgz";
      const destination = args[args.indexOf("--pack-destination") + 1];
      await writeFile(join(destination, filename), "frozen-tarball");
      return `${JSON.stringify([{ filename }])}\n`;
    }
    if (command === "npm" && args[0] === "install") {
      const prefix = args[args.indexOf("--prefix") + 1];
      const installedPackage = join(
        prefix,
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
  return { calls, runCommand };
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

    const parsed = validateReleaseCandidateManifest(
      JSON.parse(await readFile(result.candidatePath, "utf8")),
    );
    assert.equal(parsed.source.commit_sha, COMMIT);
    assert.equal(parsed.source.tree_sha, TREE);
    assert.equal(parsed.source.story_manifest.count, 24);
    assert.equal(parsed.source.schemas.count, 21);
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
      await readFile(result.checksumPath, "utf8"),
      `${await sha256File(result.candidatePath)}  candidate.json\n`,
    );
    assert.equal(
      commands.calls.filter(
        ([command, first, second]) =>
          command === "npm" && first === "run" && second === "build",
      ).length,
      1,
    );
    assert.equal(
      commands.calls.filter(
        ([command, first]) => command === "npm" && first === "pack",
      ).length,
      1,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
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
    await rm(fixture.root, { recursive: true, force: true });
  }
});
