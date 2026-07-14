import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
  buildReleaseCandidateManifest,
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

async function sourceIdentity(packageRoot) {
  const storyManifest = await buildDirectoryManifest(
    join(packageRoot, "src", "stories"),
    { include: (path) => path.endsWith(".json") },
  );
  const schemas = await buildDirectoryManifest(join(packageRoot, "schemas"), {
    include: (path) => path.endsWith(".json"),
  });
  return {
    packageLockSha256: await sha256File(join(packageRoot, "package-lock.json")),
    storyManifest,
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
  const packageMetadata = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );

  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  const stagingDirectory = await mkdtemp(
    join(dirname(outputDirectory), ".jetkvm-candidate-"),
  );
  let installationDirectory;
  try {
    await runCommand("npm", ["run", "build"], { cwd: packageRoot });
    const packOutput = await runCommand(
      "npm",
      ["pack", "--json", "--pack-destination", stagingDirectory],
      { cwd: packageRoot },
    );
    const artifactFilename = parsePackFilename(packOutput);
    const stagedArtifactPath = join(stagingDirectory, artifactFilename);
    const artifactFacts = await stat(stagedArtifactPath);
    if (!artifactFacts.isFile() || artifactFacts.size < 1) {
      throw new Error("Release artifact is not a non-empty regular file.");
    }
    await assertCleanSource(runCommand, repositoryRoot);

    installationDirectory = await mkdtemp(
      join(tmpdir(), "jetkvm-candidate-install-"),
    );
    await runCommand(
      "npm",
      [
        "install",
        "--prefix",
        installationDirectory,
        stagedArtifactPath,
        "--ignore-scripts",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
      ],
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
    const source = await sourceIdentity(packageRoot);
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
      branchMatrixSha256: source.branchMatrixSha256,
      storyE2eSha256: source.storyE2eSha256,
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
      artifactSizeBytes: artifactFacts.size,
      artifactSha256: await sha256File(stagedArtifactPath),
      packageFiles: packageTree.files,
    });
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
    await rename(stagingDirectory, outputDirectory);
    return Object.freeze({
      candidate,
      candidatePath: join(outputDirectory, "candidate.json"),
      checksumPath: join(outputDirectory, "candidate.sha256"),
      tarballPath: join(outputDirectory, artifactFilename),
    });
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  } finally {
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
    });
    process.stdout.write(
      `Release candidate frozen: ${basename(result.tarballPath)} ${result.candidate.source.commit_sha}\n`,
    );
  } catch {
    process.stderr.write("Release candidate freeze failed.\n");
    process.exitCode = 1;
  }
}
