import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLeaseChildEnvironment } from "./deviceLeaseRunner.js";
import {
  acquireDeviceLease,
  loadDeviceLeaseProofReference,
  removeStaleDeviceLease,
} from "./deviceLease.js";

const wrapperPath = fileURLToPath(
  new URL("../scripts/with-device-lease.mjs", import.meta.url),
);

type ProcessResult = { code: number | null; stdout: string; stderr: string };

function scrubDeviceLeaseEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("JETKVM_DEVICE_LEASE_")) delete environment[name];
  }
  return environment;
}

async function runWrapper(
  args: string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  const ownedTmp =
    extraEnvironment.TMPDIR === undefined
      ? await mkdtemp(join(tmpdir(), "jetkvm-runner-wrapper-"))
      : undefined;
  try {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      env: {
        ...scrubDeviceLeaseEnvironment(),
        ...extraEnvironment,
        ...(ownedTmp === undefined ? {} : { TMPDIR: ownedTmp }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const completion = Promise.withResolvers<number | null>();
    child.once("error", (error) => completion.reject(error));
    child.once("close", (code) => completion.resolve(code));
    return { code: await completion.promise, stdout, stderr };
  } finally {
    if (ownedTmp !== undefined) {
      await rm(ownedTmp, { recursive: true, force: true });
    }
  }
}

// These poll OS process/file transitions in subprocess integration tests; fake timers cannot drive them.
async function waitForJsonFile(
  path: string,
): Promise<{ proofPath: string; commandPid: number }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await delay(10);
    }
  }
  throw new Error("Timed out waiting for supervised command marker.");
}

async function waitForSupervisorBootFile(
  path: string,
): Promise<{ supervisorPid: number; commandPgid: number }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await delay(10);
    }
  }
  throw new Error("Timed out waiting for supervisor boot marker.");
}

async function waitForProcessGroupExit(
  pgid: number,
  attempts = 300,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for supervised process group exit.");
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for supervisor process exit.");
}

describe("device lease runner", () => {
  it("passes only a protected proof reference and scrubs all lease variables", () => {
    const environment = buildLeaseChildEnvironment(
      {
        SAFE_VALUE: "kept",
        JETKVM_DEVICE_LEASE_TOKEN: "must-not-survive",
        JETKVM_DEVICE_LEASE_OWNER: "must-not-survive",
        JETKVM_DEVICE_LEASE_UNRELATED: "must-not-survive",
      },
      "/private/proof.json",
    );

    expect(environment).toEqual({
      SAFE_VALUE: "kept",
      JETKVM_DEVICE_LEASE_PROOF_PATH: "/private/proof.json",
    });
    expect(JSON.stringify(environment)).not.toContain("must-not-survive");
  });

  it("keeps raw proof material out of child env and wrapper output", async () => {
    const childScript =
      'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.includes("DEVICE_LEASE")))))';
    const result = await runWrapper([
      "--device-key",
      `env-scan-${randomUUID()}`,
      "--",
      process.execPath,
      "-e",
      childScript,
    ]);

    expect(result.code).toBe(0);
    expect(Object.keys(JSON.parse(result.stdout.trim()))).toEqual([
      "JETKVM_DEVICE_LEASE_PROOF_PATH",
    ]);
    expect(result.stderr).not.toMatch(/[a-f0-9]{64}/i);
  });

  it("supports nested inheritance through the protected proof reference", async () => {
    const deviceKey = `nested-${randomUUID()}`;
    const result = await runWrapper([
      "--device-key",
      deviceKey,
      "--",
      process.execPath,
      wrapperPath,
      "--device-key",
      deviceKey,
      "--",
      process.execPath,
      "--version",
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.trim()).toBe(process.version);
  });

  it("fails closed for invalid or partial inherited proof references without echoing them", async () => {
    const invalidReference = "/definitely/not/a/device-lease-proof";
    const invalid = await runWrapper(
      [
        "--device-key",
        `invalid-${randomUUID()}`,
        "--",
        process.execPath,
        "--version",
      ],
      { JETKVM_DEVICE_LEASE_PROOF_PATH: invalidReference },
    );
    expect(invalid.code).not.toBe(0);
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(
      invalidReference,
    );

    const empty = await runWrapper(
      [
        "--device-key",
        `empty-${randomUUID()}`,
        "--",
        process.execPath,
        "--version",
      ],
      { JETKVM_DEVICE_LEASE_PROOF_PATH: "" },
    );
    expect(empty.code).not.toBe(0);

    const partial = await runWrapper(
      [
        "--device-key",
        `partial-${randomUUID()}`,
        "--",
        process.execPath,
        "--version",
      ],
      { JETKVM_DEVICE_LEASE_TOKEN: "raw-token-without-reference" },
    );
    expect(partial.code).not.toBe(0);
    expect(`${partial.stdout}${partial.stderr}`).not.toContain(
      "raw-token-without-reference",
    );
  });

  it("drains background descendants before a normal lease release", async () => {
    const isolatedTmp = await mkdtemp(
      join(tmpdir(), "jetkvm-supervisor-descendant-"),
    );
    const markerPath = join(isolatedTmp, "descendant.json");
    const commandScript =
      'const{spawn}=require("node:child_process"),fs=require("node:fs");const child=spawn(process.execPath,["-e","process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(process.argv[1],JSON.stringify({commandPid:child.pid,groupPid:process.ppid}));child.unref();';
    let descendantPid: number | undefined;
    let groupPid: number | undefined;
    try {
      const result = await runWrapper(
        [
          "--device-key",
          `descendant-${randomUUID()}`,
          "--",
          process.execPath,
          "-e",
          commandScript,
          markerPath,
        ],
        { TMPDIR: isolatedTmp },
      );
      expect(result.code).toBe(0);
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      descendantPid = marker.commandPid;
      groupPid = marker.groupPid;
      if (typeof groupPid !== "number") {
        throw new Error("Descendant process group was not recorded.");
      }
      await waitForProcessGroupExit(groupPid, 100);
    } finally {
      if (groupPid !== undefined) {
        try {
          process.kill(-groupPid, "SIGKILL");
        } catch {
          // The supervised descendant group was drained.
        }
      } else if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The descendant exited.
        }
      }
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  });

  it("drains the command group before release when the supervisor is killed", async () => {
    const isolatedTmp = await mkdtemp(
      join(tmpdir(), "jetkvm-supervisor-killed-"),
    );
    const markerPath = join(isolatedTmp, "command.json");
    const deviceKey = `supervisor-killed-${randomUUID()}`;
    const commandScript =
      'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({proofPath:process.env.JETKVM_DEVICE_LEASE_PROOF_PATH,commandPid:process.pid}));process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';
    const wrapper = spawn(
      process.execPath,
      [
        wrapperPath,
        "--device-key",
        deviceKey,
        "--",
        process.execPath,
        "-e",
        commandScript,
        markerPath,
      ],
      {
        env: { ...scrubDeviceLeaseEnvironment(), TMPDIR: isolatedTmp },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const wrapperExit = Promise.withResolvers<void>();
    wrapper.once("exit", () => wrapperExit.resolve());
    let supervisorPgid: number | undefined;
    try {
      const marker = await waitForJsonFile(markerPath);
      const proof = await loadDeviceLeaseProofReference(marker.proofPath);
      const record = JSON.parse(await readFile(proof.path, "utf8"));
      supervisorPgid = record.supervisor_pgid;
      if (typeof supervisorPgid !== "number") {
        throw new Error("Command process group was not recorded.");
      }
      process.kill(record.supervisor_pid, "SIGKILL");
      await wrapperExit.promise;
      await waitForProcessGroupExit(supervisorPgid, 100);
      const replacement = await acquireDeviceLease({
        directory: join(isolatedTmp, "jetkvm-device-leases"),
        deviceKey,
        ownerId: "owner-b",
        runId: "run-b",
      });
      await replacement.release();
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill("SIGKILL");
      }
      if (supervisorPgid !== undefined) {
        try {
          process.kill(-supervisorPgid, "SIGKILL");
        } catch {
          // The killed supervisor's command group was drained.
        }
      }
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  });

  it("keeps a crashed wrapper lease closed until its supervised process group exits", async () => {
    const isolatedTmp = await mkdtemp(
      join(tmpdir(), "jetkvm-supervisor-crash-"),
    );
    const markerPath = join(isolatedTmp, "command.json");
    const deviceKey = `crash-${randomUUID()}`;
    const commandScript =
      'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({proofPath:process.env.JETKVM_DEVICE_LEASE_PROOF_PATH,commandPid:process.pid}));process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),400));setInterval(()=>{},1000);';
    const wrapper = spawn(
      process.execPath,
      [
        wrapperPath,
        "--device-key",
        deviceKey,
        "--",
        process.execPath,
        "-e",
        commandScript,
        markerPath,
      ],
      {
        env: { ...scrubDeviceLeaseEnvironment(), TMPDIR: isolatedTmp },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const wrapperExit = Promise.withResolvers<void>();
    wrapper.once("exit", () => wrapperExit.resolve());
    let commandPid: number | undefined;
    let supervisorPgid: number | undefined;
    try {
      const marker = await waitForJsonFile(markerPath);
      commandPid = marker.commandPid;
      const proof = await loadDeviceLeaseProofReference(marker.proofPath);
      const record = JSON.parse(await readFile(proof.path, "utf8"));
      supervisorPgid = record.supervisor_pgid;
      expect(record).toMatchObject({
        supervisor_pid: expect.any(Number),
        supervisor_pgid: expect.any(Number),
        supervisor_liveness_id: expect.any(String),
        supervisor_liveness_path: expect.any(String),
      });
      expect(record.supervisor_pid).not.toBe(record.supervisor_pgid);
      if (typeof supervisorPgid !== "number") {
        throw new Error("Command process group was not recorded.");
      }

      process.kill(wrapper.pid as number, "SIGKILL");
      await wrapperExit.promise;
      await expect(
        removeStaleDeviceLease({ proof, confirmOwnerDead: async () => true }),
      ).rejects.toMatchObject({ code: "DEVICE_LEASE_STALE_UNPROVEN" });
      await expect(
        acquireDeviceLease({
          directory: join(isolatedTmp, "jetkvm-device-leases"),
          deviceKey,
          ownerId: "owner-b",
          runId: "run-b",
        }),
      ).rejects.toMatchObject({ code: "DEVICE_LEASE_BUSY" });

      await waitForProcessGroupExit(supervisorPgid);
      await waitForProcessExit(record.supervisor_pid);
      await mkdir(dirname(record.supervisor_liveness_path), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(record.supervisor_liveness_path, "replacement-liveness", {
        mode: 0o600,
      });
      await expect(
        removeStaleDeviceLease({ proof, confirmOwnerDead: async () => true }),
      ).rejects.toMatchObject({ code: "DEVICE_LEASE_STALE_UNPROVEN" });
      await rm(dirname(record.supervisor_liveness_path), {
        recursive: true,
        force: true,
      });
      await removeStaleDeviceLease({
        proof,
        confirmOwnerDead: async () => true,
      });
      const replacement = await acquireDeviceLease({
        directory: join(isolatedTmp, "jetkvm-device-leases"),
        deviceKey,
        ownerId: "owner-b",
        runId: "run-b",
      });
      await replacement.release();
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null)
        wrapper.kill("SIGKILL");
      if (supervisorPgid !== undefined) {
        try {
          process.kill(-supervisorPgid, "SIGKILL");
        } catch {
          // The command group exited normally.
        }
      } else if (commandPid !== undefined) {
        try {
          process.kill(commandPid, "SIGKILL");
        } catch {
          // The command exited normally.
        }
      }
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  });

  it("kills a pre-acquire supervisor when the wrapper is abruptly terminated", async () => {
    const isolatedTmp = await mkdtemp(
      join(tmpdir(), "jetkvm-supervisor-parent-crash-"),
    );
    const bootMarker = join(isolatedTmp, "supervisor.json");
    const wrapper = spawn(
      process.execPath,
      [
        wrapperPath,
        "--device-key",
        `pre-acquire-crash-${randomUUID()}`,
        "--",
        process.execPath,
        "--version",
      ],
      {
        env: {
          ...scrubDeviceLeaseEnvironment(),
          TMPDIR: isolatedTmp,
          JETKVM_TEST_SUPERVISOR_BOOT_MARKER_PATH: bootMarker,
          JETKVM_TEST_SUPERVISOR_READY_DELAY_MS: "5000",
        },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const wrapperExit = Promise.withResolvers<void>();
    wrapper.once("exit", () => wrapperExit.resolve());
    let supervisorPid: number | undefined;
    let commandPgid: number | undefined;
    try {
      const identities = await waitForSupervisorBootFile(bootMarker);
      supervisorPid = identities.supervisorPid;
      commandPgid = identities.commandPgid;
      expect(Number.isSafeInteger(supervisorPid) && supervisorPid > 0).toBe(
        true,
      );
      expect(Number.isSafeInteger(commandPgid) && commandPgid > 0).toBe(true);
      expect(supervisorPid).not.toBe(commandPgid);
      process.kill(wrapper.pid as number, "SIGKILL");
      await wrapperExit.promise;
      await waitForProcessGroupExit(commandPgid);
      await waitForProcessExit(supervisorPid);
      const remaining = await readdir(isolatedTmp, { recursive: true });
      expect(
        remaining.filter((path) =>
          /\.(?:lease\.json|admin\.lock|cleanup\.claim)$|capability-|liveness/.test(
            path,
          ),
        ),
      ).toEqual([]);
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null)
        wrapper.kill("SIGKILL");
      if (commandPgid !== undefined) {
        try {
          process.kill(-commandPgid, "SIGKILL");
        } catch {
          // The pre-acquire command group exited after its IPC owner died.
        }
      }
      if (supervisorPid !== undefined) {
        try {
          process.kill(supervisorPid, "SIGKILL");
        } catch {
          // The external supervisor exited after draining the command group.
        }
      }
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  });

  it("times out and cleans a supervisor that never becomes ready before lease acquisition", async () => {
    const isolatedTmp = await mkdtemp(
      join(tmpdir(), "jetkvm-supervisor-timeout-"),
    );
    try {
      const result = await runWrapper(
        [
          "--device-key",
          `timeout-${randomUUID()}`,
          "--",
          process.execPath,
          "--version",
        ],
        {
          TMPDIR: isolatedTmp,
          JETKVM_TEST_SUPERVISOR_READY_DELAY_MS: "200",
          JETKVM_TEST_SUPERVISOR_READY_TIMEOUT_MS: "50",
        },
      );
      expect(result.code).not.toBe(0);
      const remaining = await readdir(isolatedTmp, { recursive: true });
      expect(
        remaining.filter((path) =>
          /\.(?:lease\.json|admin\.lock|cleanup\.claim)$|capability-|liveness/.test(
            path,
          ),
        ),
      ).toEqual([]);
    } finally {
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  });
});
