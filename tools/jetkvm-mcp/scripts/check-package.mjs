import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ALLOWED_TOP_LEVEL_FILES = new Set([
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package.json",
]);
const REQUIRED_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package.json",
  "dist/deviceLeaseRunner.js",
  "examples/claude-desktop.json",
  "examples/operator-config.json",
  "examples/create-credential-file.sh",
  "examples/run-stdio.sh",
]);
const FORBIDDEN_SEGMENTS = new Set([
  "__tests__",
  "test",
  "tests",
  "test-support",
  "fixture",
  "fixtures",
  "debug",
  "trace",
  "traces",
]);
const FORBIDDEN_BASENAME_PART =
  /(?:^|[._-])(?:test|spec|fixture|debug|trace|secret|lease[-_.]?proof)(?:[._-]|$)/iu;

function isAllowedPath(filePath) {
  return (
    ALLOWED_TOP_LEVEL_FILES.has(filePath) ||
    filePath.startsWith("dist/") ||
    filePath.startsWith("schemas/") ||
    filePath.startsWith("examples/")
  );
}

function isForbiddenPath(filePath) {
  const segments = filePath.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  return (
    segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)) ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    FORBIDDEN_BASENAME_PART.test(basename)
  );
}

export function validatePackReport(report) {
  if (
    !Array.isArray(report) ||
    report.length !== 1 ||
    !Array.isArray(report[0]?.files) ||
    report[0].files.some(
      (file) =>
        file === null ||
        typeof file !== "object" ||
        typeof file.path !== "string" ||
        file.path.length === 0,
    )
  ) {
    throw new Error("invalid npm pack report");
  }

  const paths = report[0].files.map((file) => file.path);
  const unexpected = paths.filter((filePath) => !isAllowedPath(filePath));
  if (unexpected.length !== 0) {
    throw new Error(
      `package contains files outside the production allowlist: ${unexpected.join(", ")}`,
    );
  }

  const forbidden = paths.filter(isForbiddenPath);
  if (forbidden.length !== 0) {
    throw new Error(
      `forbidden production package path: ${forbidden.join(", ")}`,
    );
  }

  const missing = REQUIRED_FILES.filter(
    (required) => !paths.includes(required),
  );
  if (missing.length !== 0) {
    throw new Error(`package is missing required files: ${missing.join(", ")}`);
  }

  return Object.freeze([...paths]);
}

async function readPackReport() {
  const npmCli = process.env.npm_execpath;
  const command = npmCli === undefined ? "npm" : process.execPath;
  const args = [
    ...(npmCli === undefined ? [] : [npmCli]),
    "pack",
    "--dry-run",
    "--json",
  ];
  const { stdout } = await execFileAsync(command, args, {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

export async function checkPackage() {
  return validatePackReport(await readPackReport());
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const paths = await checkPackage();
    process.stdout.write(
      `Production package verified (${paths.length} files).\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
