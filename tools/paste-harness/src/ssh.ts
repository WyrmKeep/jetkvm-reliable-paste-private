import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SSH_BASE_ARGS = [
  "-F",
  "/dev/null",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "BatchMode=yes",
] as const;

const DEFAULTS = {
  KVM_PRIMARY: "192.168.1.110",
  KVM_SECONDARY: "192.168.1.36",
  WIN_TARGET: "192.168.1.155",
  WIN_RECV: "C:\\Users\\Robert\\Documents\\recv.txt",
} as const;

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SOURCE_DIR, "../../..");
export const DEFAULT_RIG_ENV_PATH = resolve(REPO_ROOT, ".env.paste-rig");

export interface RigEnv {
  JETKVM_PASSWORD?: string;
  KVM_PRIMARY: string;
  KVM_SECONDARY: string;
  WIN_TARGET: string;
  WIN_RECV: string;
  [key: string]: string | undefined;
}

export interface SshResult {
  command: "ssh" | "scp";
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface RunSshOptions {
  input?: string | Buffer;
  inputFile?: string;
  timeoutMs?: number;
}

export function buildSshArgs(target: string, remoteCommand?: string): string[] {
  return remoteCommand === undefined
    ? [...SSH_BASE_ARGS, target]
    : [...SSH_BASE_ARGS, target, remoteCommand];
}

export function buildScpArgs(source: string, destination: string): string[] {
  return [...SSH_BASE_ARGS, source, destination];
}

export function kvmTarget(host: string): string {
  return `root@${host}`;
}

export function windowsTarget(env: Pick<RigEnv, "WIN_TARGET">): string {
  return `root@${env.WIN_TARGET}`;
}

export async function loadRigEnv(
  envPath = DEFAULT_RIG_ENV_PATH,
): Promise<RigEnv> {
  return parseRigEnvText(await readFile(envPath, "utf8"));
}

export function parseRigEnvText(text: string): RigEnv {
  const env: Record<string, string> = { ...DEFAULTS };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = unquoteEnvValue(line.slice(equalsIndex + 1).trim());
    if (key.length > 0) {
      env[key] = value;
    }
  }

  return {
    ...DEFAULTS,
    ...env,
  };
}

export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function stripPowerShellNoise(output: string): string {
  const cleanLines: string[] = [];
  let inCliXml = false;

  for (const line of output
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (
      /warning: permanently added|post-quantum|store now|upgraded/i.test(
        trimmed,
      )
    ) {
      continue;
    }
    if (trimmed === "#< CLIXML") {
      inCliXml = true;
      continue;
    }
    if (inCliXml) {
      const errorText = extractCliXmlErrorText(trimmed);
      if (errorText.length > 0) {
        cleanLines.push(errorText);
        continue;
      }
    }
    if (inCliXml && looksLikeCliXmlLine(trimmed)) {
      continue;
    }
    inCliXml = false;
    cleanLines.push(line);
  }

  return cleanLines.join("\n").trim();
}

export function redactRigSecrets(text: string, env: Partial<RigEnv>): string {
  let redacted = text;
  for (const value of Object.values(env)) {
    if (typeof value !== "string" || value.length < 4) {
      continue;
    }
    if (
      value === env.KVM_PRIMARY ||
      value === env.KVM_SECONDARY ||
      value === env.WIN_TARGET ||
      value === env.WIN_RECV
    ) {
      continue;
    }
    redacted = redacted.split(value).join("<redacted>");
  }
  return redacted;
}

export async function runSshCommand(
  target: string,
  remoteCommand: string,
  options: RunSshOptions = {},
): Promise<SshResult> {
  return runChild("ssh", buildSshArgs(target, remoteCommand), options);
}

export async function runScp(
  source: string,
  destination: string,
  options: RunSshOptions = {},
): Promise<SshResult> {
  return runChild("scp", buildScpArgs(source, destination), options);
}

export async function runPowerShell(
  target: string,
  script: string,
  options: RunSshOptions = {},
): Promise<SshResult> {
  const encoded = encodePowerShellCommand(script);
  const result = await runSshCommand(
    target,
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    options,
  );
  return {
    ...result,
    stdout: stripPowerShellNoise(result.stdout),
    stderr: stripPowerShellNoise(result.stderr),
  };
}

export async function uploadWindowsTextFile(
  target: string,
  windowsPath: string,
  content: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadlineMs = performance.now() + timeoutMs;
  const remoteTemporaryPath = `${windowsPath}.jetkvm-upload-${randomUUID()}.tmp`;
  const prepareScript = `
$ErrorActionPreference = 'Stop'
$path = ${toPowerShellString(windowsPath)}
$parent = Split-Path -Parent $path
if ($parent) {
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $temporaryPrefix = (Split-Path -Leaf $path) + '.jetkvm-upload-'
  $staleBefore = [System.DateTime]::UtcNow.AddMinutes(-10)
  Get-ChildItem -LiteralPath $parent -File -Force -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name.StartsWith($temporaryPrefix, [System.StringComparison]::Ordinal) -and
      $_.Name.EndsWith('.tmp', [System.StringComparison]::Ordinal) -and
      $_.LastWriteTimeUtc -lt $staleBefore
    } |
    ForEach-Object {
      try { [System.IO.File]::Delete($_.FullName) } catch {}
    }
}
`;
  const preparation = await runPowerShell(target, prepareScript, {
    timeoutMs: remainingUploadTimeout(deadlineMs, "prepare", windowsPath),
  });
  if (preparation.exitCode !== 0) {
    throw new Error(
      `failed to prepare ${windowsPath}: ${
        preparation.stderr ||
        preparation.stdout ||
        (preparation.timedOut ? "timed out" : "unknown failure")
      }`,
    );
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "jetkvm-paste-rig-upload-"),
  );
  const localPath = join(temporaryDirectory, "payload");
  let remoteTemporaryMayExist = false;
  try {
    await writeFile(localPath, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const destination = `${target}:${remoteTemporaryPath.replaceAll("\\", "/")}`;
    remoteTemporaryMayExist = true;
    const result = await runScp(localPath, destination, {
      timeoutMs: remainingUploadTimeout(deadlineMs, "upload", windowsPath),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `failed to upload ${windowsPath}: ${
          result.stderr ||
          result.stdout ||
          (result.timedOut ? "timed out" : "unknown failure")
        }`,
      );
    }

    const installScript = `
$ErrorActionPreference = 'Stop'
$path = ${toPowerShellString(windowsPath)}
$temporaryPath = ${toPowerShellString(remoteTemporaryPath)}
try {
  if ([System.IO.File]::Exists($path)) {
    [System.IO.File]::Replace($temporaryPath, $path, $null, $true)
  } else {
    [System.IO.File]::Move($temporaryPath, $path)
  }
} finally {
  if ([System.IO.File]::Exists($temporaryPath)) {
    [System.IO.File]::Delete($temporaryPath)
  }
}
`;
    const installation = await runPowerShell(target, installScript, {
      timeoutMs: remainingUploadTimeout(deadlineMs, "install", windowsPath),
    });
    if (installation.exitCode !== 0) {
      throw new Error(
        `failed to install ${windowsPath}: ${
          installation.stderr ||
          installation.stdout ||
          (installation.timedOut ? "timed out" : "unknown failure")
        }`,
      );
    }
    remoteTemporaryMayExist = false;
  } finally {
    if (remoteTemporaryMayExist) {
      const cleanupTimeoutMs = Math.ceil(deadlineMs - performance.now());
      if (cleanupTimeoutMs > 0) {
        const cleanupScript = `
$ErrorActionPreference = 'SilentlyContinue'
$temporaryPath = ${toPowerShellString(remoteTemporaryPath)}
if ([System.IO.File]::Exists($temporaryPath)) {
  [System.IO.File]::Delete($temporaryPath)
}
`;
        try {
          await runPowerShell(target, cleanupScript, {
            timeoutMs: cleanupTimeoutMs,
          });
        } catch {
          // Preserve the primary upload/install failure.
        }
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function remainingUploadTimeout(
  deadlineMs: number,
  action: "prepare" | "upload" | "install",
  windowsPath: string,
): number {
  const remainingMs = Math.ceil(deadlineMs - performance.now());
  if (remainingMs <= 0) {
    throw new Error(`failed to ${action} ${windowsPath}: timed out`);
  }
  return remainingMs;
}

export function toPowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function looksLikeCliXmlLine(line: string): boolean {
  return /^<\/?[A-Za-z][^>]*(?:>|\/>)/.test(line);
}

function extractCliXmlErrorText(line: string): string {
  const matches = [...line.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)];
  return matches
    .map((match) => decodeCliXmlText(match[1] ?? ""))
    .join("")
    .trim();
}

function decodeCliXmlText(text: string): string {
  return text
    .replace(/_x000D__x000A_/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function runChild(
  command: "ssh" | "scp",
  args: string[],
  options: RunSshOptions,
): Promise<SshResult> {
  if (options.input !== undefined && options.inputFile !== undefined) {
    throw new Error("SSH input and inputFile are mutually exclusive.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
          }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      reject(error);
    });
    const inputCompletion =
      options.inputFile !== undefined
        ? pipeline(createReadStream(options.inputFile), child.stdin).then(
            () => null,
            (error: unknown) => error,
          )
        : options.input !== undefined
          ? pipeline(Readable.from([options.input]), child.stdin).then(
              () => null,
              (error: unknown) => error,
            )
          : (child.stdin.end(), Promise.resolve(null));

    child.on("close", async (exitCode, signal) => {
      const inputError = await inputCompletion;
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      const inputErrorCode =
        inputError instanceof Error
          ? (inputError as Error & { code?: unknown }).code
          : undefined;
      if (
        inputError !== null &&
        !(
          inputErrorCode === "EPIPE" &&
          (exitCode !== 0 || signal !== null || timedOut)
        )
      ) {
        reject(inputError);
        return;
      }
      resolve({
        command,
        args,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: exitCode ?? (signal ? 128 : 1),
        signal,
        timedOut,
      });
    });
  });
}
