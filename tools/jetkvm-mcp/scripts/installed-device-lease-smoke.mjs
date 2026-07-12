import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = Promise.withResolvers();
  child.once("error", (error) => completion.reject(error));
  child.once("close", (code) => completion.resolve(code));
  const code = await completion.promise;
  if (code !== 0)
    throw new Error(
      `Installed lease smoke command failed (${code}): ${stderr}`,
    );
  return { stdout, stderr };
}

const packageRoot = new URL("../", import.meta.url);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "jetkvm-mcp-installed-lease-"),
);
try {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined)
    throw new Error("npm_execpath is required for the installed lease smoke.");
  const packed = await run(
    process.execPath,
    [npmCli, "pack", "--json", "--pack-destination", temporaryDirectory],
    { cwd: packageRoot },
  );
  const [{ filename }] = JSON.parse(packed.stdout);
  const unpackDirectory = join(temporaryDirectory, "unpacked");
  await mkdir(unpackDirectory);
  await run("tar", [
    "-xzf",
    join(temporaryDirectory, filename),
    "-C",
    unpackDirectory,
  ]);
  const installedPackage = join(unpackDirectory, "package");
  await run(
    process.execPath,
    [npmCli, "install", "--ignore-scripts", "--omit=dev"],
    { cwd: installedPackage },
  );
  const executed = await run(
    process.execPath,
    [
      npmCli,
      "run",
      "device-lease:run",
      "--",
      "--device-key",
      "installed-smoke-device",
      "--",
      process.execPath,
      "--version",
    ],
    { cwd: installedPackage },
  );
  if (!executed.stdout.includes(process.version))
    throw new Error("Installed lease runner did not execute its child.");
  console.log(`Installed device lease runner passed on ${process.version}.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
