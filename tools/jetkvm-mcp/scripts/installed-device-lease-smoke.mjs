import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function scrubDeviceLeaseEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("JETKVM_DEVICE_LEASE_")) delete environment[name];
  }
  return environment;
}

async function run(command, args, options = {}) {
  const { expectedCode = 0, ...spawnOptions } = options;
  const child = spawn(command, args, {
    env: scrubDeviceLeaseEnvironment(),
    ...spawnOptions,
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
  if (code !== expectedCode)
    throw new Error(
      `Installed lease smoke command failed (${code}): ${stderr}`,
    );
  return { stdout, stderr };
}

async function waitForJson(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  throw new Error("Installed supervised command did not start.");
}

async function waitForProcessGroupExit(pgid) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("Installed supervised command group did not exit.");
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
  const smokeId = randomUUID();
  const runtimeTmp = join(temporaryDirectory, "runtime");
  await mkdir(runtimeTmp);
  const executed = await run(
    process.execPath,
    [
      npmCli,
      "run",
      "device-lease:run",
      "--",
      "--device-key",
      `installed-normal-${smokeId}`,
      "--",
      process.execPath,
      "--version",
    ],
    {
      cwd: installedPackage,
      env: { ...scrubDeviceLeaseEnvironment(), TMPDIR: runtimeTmp },
    },
  );
  if (!executed.stdout.includes(process.version))
    throw new Error("Installed lease runner did not execute its child.");
  const concurrentTmp = join(temporaryDirectory, `concurrent-${smokeId}`);
  await mkdir(concurrentTmp);
  const concurrentKey = `installed-concurrent-${smokeId}`;
  const concurrentMarkerPath = join(concurrentTmp, "holder.json");
  const holderScript =
    'const fs=require("node:fs");fs.writeFileSync(process.argv[1],"{}");process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);';
  const holder = spawn(
    process.execPath,
    [
      join(installedPackage, "dist", "deviceLeaseRunner.js"),
      "--device-key",
      concurrentKey,
      "--",
      process.execPath,
      "-e",
      holderScript,
      concurrentMarkerPath,
    ],
    {
      cwd: installedPackage,
      env: { ...scrubDeviceLeaseEnvironment(), TMPDIR: concurrentTmp },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const holderExit = Promise.withResolvers();
  holder.once("error", (error) => holderExit.reject(error));
  holder.once("exit", (code, signal) => holderExit.resolve({ code, signal }));
  try {
    await Promise.race([
      waitForJson(concurrentMarkerPath),
      holderExit.promise.then(({ code, signal }) => {
        throw new Error(
          `Installed concurrent holder exited before readiness (${code ?? signal}).`,
        );
      }),
    ]);
    const contender = await run(
      process.execPath,
      [
        join(installedPackage, "dist", "deviceLeaseRunner.js"),
        "--device-key",
        concurrentKey,
        "--",
        process.execPath,
        "--version",
      ],
      {
        cwd: installedPackage,
        env: { ...scrubDeviceLeaseEnvironment(), TMPDIR: concurrentTmp },
        expectedCode: 1,
      },
    );
    if (!contender.stderr.includes("already held"))
      throw new Error("Installed concurrent lease did not fail closed.");
    holder.kill("SIGTERM");
    const holderResult = await holderExit.promise;
    if (holderResult.code !== 143)
      throw new Error(
        `Installed concurrent holder exited unexpectedly (${holderResult.code ?? holderResult.signal}).`,
      );
    await run(
      process.execPath,
      [
        join(installedPackage, "dist", "deviceLeaseRunner.js"),
        "--device-key",
        concurrentKey,
        "--",
        process.execPath,
        "--version",
      ],
      {
        cwd: installedPackage,
        env: { ...scrubDeviceLeaseEnvironment(), TMPDIR: concurrentTmp },
      },
    );
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill("SIGKILL");
      await holderExit.promise;
    }
  }
  const groupMarkerPath = join(runtimeTmp, "group.json");
  const groupScript =
    'const{spawn}=require("node:child_process"),fs=require("node:fs");const child=spawn(process.execPath,["-e","process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(process.argv[1],JSON.stringify({groupPid:process.ppid}));child.unref();';
  await run(
    process.execPath,
    [
      join(installedPackage, "dist", "deviceLeaseRunner.js"),
      "--device-key",
      `installed-group-${smokeId}`,
      "--",
      process.execPath,
      "-e",
      groupScript,
      groupMarkerPath,
    ],
    {
      cwd: installedPackage,
      env: { ...scrubDeviceLeaseEnvironment(), TMPDIR: runtimeTmp },
    },
  );
  const groupMarker = await waitForJson(groupMarkerPath);
  await waitForProcessGroupExit(groupMarker.groupPid);
  const installedLease = await import(
    pathToFileURL(join(installedPackage, "dist", "deviceLease.js"))
  );
  const crashTmp = join(temporaryDirectory, "crash-runtime");
  await mkdir(crashTmp);
  const markerPath = join(crashTmp, "command.json");
  const crashScript =
    'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({proofPath:process.env.JETKVM_DEVICE_LEASE_PROOF_PATH}));process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),400));setInterval(()=>{},1000);';
  const crashingWrapper = spawn(
    process.execPath,
    [
      join(installedPackage, "dist", "deviceLeaseRunner.js"),
      "--device-key",
      `installed-crash-${smokeId}`,
      "--",
      process.execPath,
      "-e",
      crashScript,
      markerPath,
    ],
    {
      cwd: installedPackage,
      env: { ...scrubDeviceLeaseEnvironment(), TMPDIR: crashTmp },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const crashed = Promise.withResolvers();
  crashingWrapper.once("exit", (code, signal) =>
    crashed.resolve({ code, signal }),
  );
  const marker = await Promise.race([
    waitForJson(markerPath),
    crashed.promise.then(({ code, signal }) => {
      throw new Error(
        `Installed wrapper exited before command start (${code ?? signal}).`,
      );
    }),
  ]);
  const proof = await installedLease.loadDeviceLeaseProofReference(
    marker.proofPath,
  );
  const record = JSON.parse(await readFile(proof.path, "utf8"));
  process.kill(crashingWrapper.pid, "SIGKILL");
  await crashed.promise;
  await installedLease
    .removeStaleDeviceLease({ proof, confirmOwnerDead: async () => true })
    .then(
      () => {
        throw new Error(
          "Installed stale cleanup ignored a live process group.",
        );
      },
      (error) => {
        if (error.code !== "DEVICE_LEASE_STALE_UNPROVEN") throw error;
      },
    );
  await waitForProcessGroupExit(record.supervisor_pgid);
  await installedLease.removeStaleDeviceLease({
    proof,
    confirmOwnerDead: async () => true,
  });
  console.log(`Installed device lease runner passed on ${process.version}.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
