import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  buildDirectoryManifest,
  buildLockedConsumerPackageLock,
  buildReleaseCandidateManifest,
  buildProductionResolution,
  isGeneratedInstalledBinLink,
  canonicalJson,
  sha256Canonical,
  sha256Bytes,
  sha256File,
} from "./release-evidence.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60_000;

function isOutside(parent, child) {
  const path = relative(parent, child);
  return path === ".." || path.startsWith(`..${sep}`);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function defaultRunCommand(command, args, { cwd }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const append = (chunks, chunk) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > COMMAND_OUTPUT_LIMIT_BYTES) {
        child.kill("SIGKILL");
        finish(() =>
          rejectRun(new Error("Release command output exceeded its bound.")),
        );
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.once("error", (error) => finish(() => rejectRun(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (code === 0 && signal === null) {
          resolveRun(Buffer.concat(stdout).toString("utf8"));
          return;
        }
        rejectRun(new Error("Release command failed."));
      });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        rejectRun(new Error("Release command exceeded its deadline.")),
      );
    }, COMMAND_TIMEOUT_MS);
  });
}

function parsePackFilename(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack returned malformed JSON.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    typeof parsed[0] !== "object" ||
    parsed[0] === null ||
    typeof parsed[0].filename !== "string" ||
    parsed[0].filename.length === 0 ||
    basename(parsed[0].filename) !== parsed[0].filename ||
    !parsed[0].filename.endsWith(".tgz")
  ) {
    throw new Error("npm pack did not produce exactly one tgz artifact.");
  }
  return parsed[0].filename;
}

function trimmedIdentifier(value, label) {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("\n") ||
    trimmed.includes("\r")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return trimmed;
}

async function assertCleanSource(runCommand, repositoryRoot) {
  const status = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot },
  );
  if (status.length !== 0) {
    throw new Error("Release candidate source tree is dirty.");
  }
}

async function sourceIdentity(packageRoot, repositoryRoot) {
  const storyManifest = await buildDirectoryManifest(
    join(packageRoot, "src", "stories"),
    { include: (path) => path.endsWith(".json") },
  );
  const schemas = await buildDirectoryManifest(join(packageRoot, "schemas"), {
    include: (path) => path.endsWith(".json"),
  });
  const pasteHarness = await buildDirectoryManifest(
    join(repositoryRoot, "tools", "paste-harness", "dist"),
  );
  return {
    packageLockSha256: await sha256File(join(packageRoot, "package-lock.json")),
    storyManifest,
    pasteHarness,
    schemas,
    branchMatrixSha256: await sha256File(
      join(packageRoot, "reports", "branch-matrix.json"),
    ),
    storyE2eSha256: await sha256File(
      join(packageRoot, "reports", "story-e2e.json"),
    ),
  };
}

export async function freezeReleaseCandidate({
  repositoryRoot = REPOSITORY_ROOT,
  packageRoot = PACKAGE_ROOT,
  outputDirectory,
  runCommand = defaultRunCommand,
  nodeVersion = process.version,
  nodeExecutablePath = process.execPath,
  platform = process.platform,
  browserExecutablePath,
  browserTargetUrl,
  controlledEvidencePath,
  architecture = process.arch,
}) {
  repositoryRoot = resolve(repositoryRoot);
  packageRoot = resolve(packageRoot);
  if (packageRoot !== join(repositoryRoot, "tools", "jetkvm-mcp")) {
    throw new Error(
      "Release package root does not match the repository layout.",
    );
  }
  if (
    typeof outputDirectory !== "string" ||
    !isAbsolute(outputDirectory) ||
    !isOutside(repositoryRoot, resolve(outputDirectory))
  ) {
    throw new Error(
      "Release output must be an absolute path outside the repository.",
    );
  }
  outputDirectory = resolve(outputDirectory);
  if (await pathExists(outputDirectory)) {
    throw new Error("Release output already exists.");
  }
  if (nodeVersion !== "v22.23.1") {
    throw new Error("Release freeze requires exact Node v22.23.1.");
  }
  if (
    typeof browserExecutablePath !== "string" ||
    !isAbsolute(browserExecutablePath) ||
    typeof browserTargetUrl !== "string" ||
    browserTargetUrl.length === 0
  ) {
    throw new Error(
      "Release freeze requires exact browser executable and target URL.",
    );
  }
  if (
    typeof controlledEvidencePath !== "string" ||
    !isAbsolute(controlledEvidencePath)
  ) {
    throw new Error(
      "Release freeze requires an absolute controlled evidence path.",
    );
  }
  controlledEvidencePath = resolve(controlledEvidencePath);
  const controlledEvidenceFacts = await stat(controlledEvidencePath);
  if (!controlledEvidenceFacts.isFile() || controlledEvidenceFacts.size < 1) {
    throw new Error(
      "Controlled release evidence must be a non-empty regular file.",
    );
  }

  const browserFacts = await stat(browserExecutablePath);
  if (!browserFacts.isFile()) {
    throw new Error("Release browser executable is not a regular file.");
  }

  await assertCleanSource(runCommand, repositoryRoot);
  const commitSha = trimmedIdentifier(
    await runCommand("git", ["rev-parse", "HEAD^{commit}"], {
      cwd: repositoryRoot,
    }),
    "Release commit",
  );
  const treeSha = trimmedIdentifier(
    await runCommand("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repositoryRoot,
    }),
    "Release tree",
  );

  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  const stagingDirectory = await mkdtemp(
    join(dirname(outputDirectory), ".jetkvm-candidate-"),
  );
  let installationDirectory;
  let sourceWorktreeParent;
  let sourceRepositoryRoot;
  let buildPackageRoot;
  try {
    sourceWorktreeParent = await mkdtemp(
      join(tmpdir(), "jetkvm-release-source-"),
    );
    sourceRepositoryRoot = join(sourceWorktreeParent, "checkout");
    await runCommand(
      "git",
      ["worktree", "add", "--detach", sourceRepositoryRoot, commitSha],
      { cwd: repositoryRoot },
    );
    buildPackageRoot = join(sourceRepositoryRoot, "tools", "jetkvm-mcp");
    const packageMetadata = JSON.parse(
      await readFile(join(buildPackageRoot, "package.json"), "utf8"),
    );
    for (const dependencyRoot of [
      join(sourceRepositoryRoot, "tools", "paste-harness"),
      buildPackageRoot,
    ]) {
      await runCommand(
        "npm",
        ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: dependencyRoot },
      );
    }
    await rm(join(sourceRepositoryRoot, "tools", "paste-harness", "dist"), {
      recursive: true,
      force: true,
    });
    await runCommand("npm", ["run", "build"], {
      cwd: join(sourceRepositoryRoot, "tools", "paste-harness"),
    });
    await runCommand("npm", ["run", "build"], { cwd: buildPackageRoot });
    const packOutput = await runCommand(
      "npm",
      ["pack", "--json", "--pack-destination", stagingDirectory],
      { cwd: buildPackageRoot },
    );
    const artifactFilename = parsePackFilename(packOutput);
    const stagedArtifactPath = join(stagingDirectory, artifactFilename);
    const [artifactFacts, artifactBytes] = await Promise.all([
      stat(stagedArtifactPath),
      readFile(stagedArtifactPath),
    ]);
    if (!artifactFacts.isFile() || artifactBytes.byteLength < 1) {
      throw new Error("Release artifact is not a non-empty regular file.");
    }
    const artifactSha256 = sha256Bytes(artifactBytes);
    await assertCleanSource(runCommand, sourceRepositoryRoot);
    await assertCleanSource(runCommand, repositoryRoot);
    const [finalCommitSha, finalTreeSha] = await Promise.all([
      runCommand("git", ["rev-parse", "HEAD^{commit}"], {
        cwd: repositoryRoot,
      }).then((value) => trimmedIdentifier(value, "Release commit")),
      runCommand("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: repositoryRoot,
      }).then((value) => trimmedIdentifier(value, "Release tree")),
    ]);
    if (finalCommitSha !== commitSha || finalTreeSha !== treeSha) {
      throw new Error(
        "Release source identity changed during candidate build.",
      );
    }

    installationDirectory = await mkdtemp(
      join(tmpdir(), "jetkvm-candidate-install-"),
    );
    await writeFile(
      join(installationDirectory, artifactFilename),
      artifactBytes,
      { flag: "wx", mode: 0o600 },
    );
    const consumerPackageFilename = "consumer-package.json";
    const consumerPackageLockFilename = "consumer-package-lock.json";
    const installPackageJsonPath = join(installationDirectory, "package.json");
    const installPackageLockPath = join(
      installationDirectory,
      "package-lock.json",
    );
    const consumerPackage = {
      name: "jetkvm-mcp-release-consumer",
      version: "1.0.0",
      private: true,
      dependencies: {
        [packageMetadata.name]: `file:./${artifactFilename}`,
      },
    };
    await writeFile(
      installPackageJsonPath,
      `${JSON.stringify(consumerPackage, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await runCommand(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: installationDirectory },
    );
    const [sourcePackageLock, generatedConsumerPackageLock] = await Promise.all(
      [
        readFile(join(buildPackageRoot, "package-lock.json"), "utf8").then(
          JSON.parse,
        ),
        readFile(installPackageLockPath, "utf8").then(JSON.parse),
      ],
    );
    const consumerPackageLock = buildLockedConsumerPackageLock({
      sourceLock: sourcePackageLock,
      generatedLock: generatedConsumerPackageLock,
      packageName: packageMetadata.name,
    });
    await writeFile(
      installPackageLockPath,
      `${JSON.stringify(consumerPackageLock, null, 2)}\n`,
      { mode: 0o600 },
    );
    const sourceResolution = buildProductionResolution(sourcePackageLock);
    const consumerResolution = buildProductionResolution(consumerPackageLock, [
      packageMetadata.name,
    ]);
    if (canonicalJson(sourceResolution) !== canonicalJson(consumerResolution)) {
      throw new Error(
        "Consumer production dependency resolution drifted from the reviewed source lock.",
      );
    }
    await runCommand(
      "npm",
      ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
      { cwd: installationDirectory },
    );
    const installedPackage = join(
      installationDirectory,
      "node_modules",
      "@wyrmkeep",
      "jetkvm-mcp",
    );
    const installedMetadata = JSON.parse(
      await readFile(join(installedPackage, "package.json"), "utf8"),
    );
    if (
      installedMetadata.name !== packageMetadata.name ||
      installedMetadata.version !== packageMetadata.version
    ) {
      throw new Error(
        "Packed package identity does not match source metadata.",
      );
    }
    const packageTree = await buildDirectoryManifest(installedPackage);
    const installationTree = await buildDirectoryManifest(
      join(installationDirectory, "node_modules"),
      { excludeSymlink: isGeneratedInstalledBinLink },
    );
    await Promise.all([
      copyFile(
        installPackageJsonPath,
        join(stagingDirectory, consumerPackageFilename),
      ),
      copyFile(
        installPackageLockPath,
        join(stagingDirectory, consumerPackageLockFilename),
      ),
      cp(
        join(sourceRepositoryRoot, "tools", "paste-harness", "dist"),
        join(stagingDirectory, "paste-harness"),
        { recursive: true, force: false, errorOnExist: true },
      ),
    ]);
    const consumerPackageJsonSha256 = await sha256File(installPackageJsonPath);
    const consumerPackageLockSha256 = await sha256File(installPackageLockPath);
    const productionResolutionSha256 = sha256Canonical(sourceResolution);
    const controlledEvidenceFilename = "controlled-evidence.json";
    const controlledEvidenceSha256 = await sha256File(controlledEvidencePath);
    await copyFile(
      controlledEvidencePath,
      join(stagingDirectory, controlledEvidenceFilename),
      0,
    );
    const source = await sourceIdentity(buildPackageRoot, sourceRepositoryRoot);
    const frozenPasteHarness = await buildDirectoryManifest(
      join(stagingDirectory, "paste-harness"),
    );
    if (frozenPasteHarness.sha256 !== source.pasteHarness.sha256) {
      throw new Error("Frozen paste-harness runtime drifted from its source.");
    }
    const candidate = buildReleaseCandidateManifest({
      packageName: packageMetadata.name,
      packageVersion: packageMetadata.version,
      commitSha,
      treeSha,
      packageLockSha256: source.packageLockSha256,
      storyManifestSha256: source.storyManifest.sha256,
      storyCount: source.storyManifest.files.length,
      schemasSha256: source.schemas.sha256,
      schemaCount: source.schemas.files.length,
      pasteHarnessSha256: source.pasteHarness.sha256,
      branchMatrixSha256: source.branchMatrixSha256,
      storyE2eSha256: source.storyE2eSha256,
      controlledEvidenceSha256,
      nodeVersion,
      nodeExecutableName: basename(nodeExecutablePath),
      nodeExecutableSha256: await sha256File(nodeExecutablePath),
      platform,
      architecture,
      browserExecutableName: basename(browserExecutablePath),
      browserExecutableSha256: await sha256File(browserExecutablePath),
      browserHeadless: false,
      browserChromiumSandbox: true,
      browserLaunchArgs: [],
      browserTargetUrlSha256: createHash("sha256")
        .update(browserTargetUrl)
        .digest("hex"),
      browserCredentialSource: "environment",
      browserManagedProfile: "ephemeral",
      artifactFilename,
      artifactSizeBytes: artifactBytes.byteLength,
      artifactSha256,
      packageFiles: packageTree.files,
      consumerPackageJsonSha256,
      consumerPackageLockSha256,
      productionResolutionSha256,
      installationFiles: installationTree.files,
    });
    await runCommand(
      "git",
      ["worktree", "remove", "--force", sourceRepositoryRoot],
      { cwd: repositoryRoot },
    );
    await rm(sourceWorktreeParent, { recursive: true, force: true });
    sourceRepositoryRoot = undefined;
    sourceWorktreeParent = undefined;
    await rm(stagedArtifactPath);
    await writeFile(stagedArtifactPath, artifactBytes, {
      flag: "wx",
      mode: 0o600,
    });
    if ((await sha256File(stagedArtifactPath)) !== artifactSha256) {
      throw new Error("Final release artifact bytes drifted during staging.");
    }
    const stagedCandidatePath = join(stagingDirectory, "candidate.json");
    await writeFile(
      stagedCandidatePath,
      `${JSON.stringify(candidate, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    const candidateSha256 = await sha256File(stagedCandidatePath);
    await writeFile(
      join(stagingDirectory, "candidate.sha256"),
      `${candidateSha256}  candidate.json\n`,
      { flag: "wx", mode: 0o600 },
    );
    const frozenOutput = await buildDirectoryManifest(stagingDirectory);
    for (const file of frozenOutput.files) {
      await chmod(join(stagingDirectory, file.path), 0o400);
    }
    await chmod(stagingDirectory, 0o500);
    await rename(stagingDirectory, outputDirectory);
    return Object.freeze({
      candidate,
      candidatePath: join(outputDirectory, "candidate.json"),
      checksumPath: join(outputDirectory, "candidate.sha256"),
      tarballPath: join(outputDirectory, artifactFilename),
      consumerPackagePath: join(outputDirectory, consumerPackageFilename),
      consumerPackageLockPath: join(
        outputDirectory,
        consumerPackageLockFilename,
      ),
      controlledEvidencePath: join(outputDirectory, controlledEvidenceFilename),
      pasteHarnessPath: join(outputDirectory, "paste-harness"),
    });
  } catch (error) {
    await chmod(stagingDirectory, 0o700).catch(() => undefined);
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    if (sourceRepositoryRoot !== undefined) {
      await runCommand(
        "git",
        ["worktree", "remove", "--force", sourceRepositoryRoot],
        { cwd: repositoryRoot },
      ).catch(() => undefined);
    }
    if (sourceWorktreeParent !== undefined) {
      await rm(sourceWorktreeParent, { recursive: true, force: true });
    }
    if (installationDirectory !== undefined) {
      await rm(installationDirectory, { recursive: true, force: true });
    }
  }
}

function parseOutputArgument(args) {
  if (
    args.length !== 2 ||
    args[0] !== "--output" ||
    !isAbsolute(args[1] ?? "")
  ) {
    throw new Error(
      "Usage: node scripts/freeze-release-candidate.mjs --output <absolute-directory>",
    );
  }
  return args[1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await freezeReleaseCandidate({
      outputDirectory: parseOutputArgument(process.argv.slice(2)),
      browserExecutablePath: process.env.JETKVM_RELEASE_BROWSER_EXECUTABLE_PATH,
      browserTargetUrl: process.env.JETKVM_RELEASE_TARGET_URL,
      controlledEvidencePath: process.env.JETKVM_RELEASE_CONTROLLED_EVIDENCE,
    });
    process.stdout.write(
      `Release candidate frozen: ${basename(result.tarballPath)} ${result.candidate.source.commit_sha}\n`,
    );
  } catch {
    process.stderr.write("Release candidate freeze failed.\n");
    process.exitCode = 1;
  }
}
