import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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
import { describe, expect, it, vi } from "vitest";
import {
  buildLeaseChildEnvironment,
  runDeviceLeaseCli,
  runSupervisedChild,
} from "./deviceLeaseRunner.js";
import {
  DeviceLeaseError,
  acquireDeviceLease,
  loadDeviceLeaseProofReference,
  removeStaleDeviceLease,
  type DeviceLease,
  type DeviceLeaseSupervisor,
} from "./deviceLease.js";
import { runDeviceLeaseGroup } from "./deviceLeaseGroup.js";
import { runDeviceLeaseSupervisor } from "./deviceLeaseSupervisor.js";

const wrapperPath = fileURLToPath(
  new URL("../scripts/with-device-lease.mjs", import.meta.url),
);
const recoveryPath = fileURLToPath(
  new URL("./deviceLeaseRecovery.ts", import.meta.url),
);

type ProcessResult = { code: number | null; stdout: string; stderr: string };

class FakeSupervisorChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly sent: object[] = [];

  send(message: object, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }
}

class FakeIpcProcess extends EventEmitter {
  readonly pid = 303;
  readonly env: NodeJS.ProcessEnv = {};
  connected = true;
  exitCode: number | undefined;
  killError: Error | null = null;
  readonly sent: object[] = [];
  readonly signals: Array<[number, NodeJS.Signals | number]> = [];
  readonly disconnected = Promise.withResolvers<void>();
  readonly disconnect = vi.fn(() => {
    this.connected = false;
    this.disconnected.resolve();
  });

  send(message: object, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }

  kill(pid: number, signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.killError !== null) throw this.killError;
    this.signals.push([pid, signal]);
    return true;
  }
}

class FakeGroupChild extends EventEmitter {
  readonly pid = 404;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  sendError: Error | null = null;
  readonly sent: object[] = [];
  readonly disconnect = vi.fn(() => {
    this.connected = false;
  });

  constructor() {
    super();
    this.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.connected = false;
      this.exitCode = code;
      this.signalCode = signal;
    });
  }

  send(message: object, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(this.sendError);
    return this.sendError === null;
  }
}

class FakeCommandChild extends EventEmitter {}

async function bindFakeSupervisor(group = new FakeGroupChild()) {
  const runtime = new FakeIpcProcess();
  const unlink = vi.fn(async () => undefined);
  const rmdir = vi.fn(async () => undefined);
  runDeviceLeaseSupervisor({
    runtime,
    group,
    killLiveGroup: () => {
      runtime.kill(-group.pid, "SIGKILL");
    },
    readFile: vi.fn(async () => "proof-id"),
    unlink,
    rmdir,
    writeFile: vi.fn(async () => undefined),
    cleanupTimeoutMs: 100,
  });
  runtime.emit("message", {
    type: "bind",
    livenessPath: "/proof/liveness",
    livenessId: "proof-id",
  });
  await Promise.resolve();
  await Promise.resolve();
  group.emit("message", { type: "ready", pid: group.pid, pgid: group.pid });
  return { runtime, group, unlink, rmdir };
}

function fakeLease(release = vi.fn(async () => undefined)): DeviceLease {
  return {
    path: "/lease.json",
    inherited: false,
    proof: {
      path: "/lease.json",
      referencePath: "/proof.json",
      ownerId: "owner",
      token: "token",
    },
    release,
  };
}

function fakeSupervisor(child: FakeSupervisorChild): DeviceLeaseSupervisor & {
  child: ChildProcess;
  livenessDirectory: string;
  bound: boolean;
  retired: boolean;
} {
  return {
    child: child as unknown as ChildProcess,
    pid: 101,
    pgid: 202,
    livenessId: "liveness",
    livenessPath: "/liveness",
    livenessDirectory: "/",
    bound: true,
    retired: false,
  };
}

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
  it("keeps the group leader live until acknowledged cleanup closes it", async () => {
    const { runtime, group, unlink, rmdir } = await bindFakeSupervisor();
    runtime.emit("message", {
      type: "start",
      command: ["/command"],
      environment: {},
    });
    group.emit("message", { type: "result", code: 0, signal: null });
    await Promise.resolve();

    expect(group.sent).toEqual([
      { type: "start", command: ["/command"], environment: {} },
      { type: "stop", signal: "SIGTERM" },
    ]);
    expect(runtime.sent).not.toContainEqual({
      type: "result",
      code: 0,
      signal: null,
    });
    expect(unlink).not.toHaveBeenCalled();

    group.emit("message", { type: "stopping" });
    await Promise.resolve();
    expect(unlink).not.toHaveBeenCalled();
    expect(runtime.signals).toEqual([]);
    group.emit("message", { type: "kill_ready" });
    expect(runtime.signals).toEqual([[-group.pid, "SIGKILL"]]);
    group.emit("close", null, "SIGKILL");
    await runtime.disconnected.promise;

    expect(unlink).toHaveBeenCalledWith("/proof/liveness");
    expect(rmdir).toHaveBeenCalledWith("/proof");
    expect(runtime.sent).toContainEqual({
      type: "result",
      code: 0,
      signal: null,
    });
    expect(runtime.signals).toEqual([[-group.pid, "SIGKILL"]]);
    expect(runtime.disconnect).toHaveBeenCalledOnce();
  });

  it("fails closed when an acknowledged leader is killed before kill-ready", async () => {
    const { runtime, group, unlink } = await bindFakeSupervisor();
    runtime.emit("message", {
      type: "start",
      command: ["/command"],
      environment: {},
    });
    group.emit("message", { type: "result", code: 0, signal: null });
    group.emit("message", { type: "stopping" });
    group.emit("close", null, "SIGKILL");
    await runtime.disconnected.promise;

    // The recorded PGID may now identify an unrelated replacement group.
    expect(runtime.signals).toEqual([]);
    expect(unlink).not.toHaveBeenCalled();
    expect(runtime.sent).not.toContainEqual({
      type: "result",
      code: 0,
      signal: null,
    });
    expect(runtime.disconnect).toHaveBeenCalledOnce();
  });

  it("preserves liveness when the live-group SIGKILL fails", async () => {
    const { runtime, group, unlink } = await bindFakeSupervisor();
    runtime.killError = new Error("denied");
    runtime.emit("message", {
      type: "start",
      command: ["/command"],
      environment: {},
    });
    group.emit("message", { type: "result", code: 0, signal: null });
    group.emit("message", { type: "stopping" });
    group.emit("message", { type: "kill_ready" });
    await runtime.disconnected.promise;

    expect(runtime.signals).toEqual([]);
    expect(unlink).not.toHaveBeenCalled();
    expect(runtime.sent).not.toContainEqual({
      type: "result",
      code: 0,
      signal: null,
    });
    expect(group.disconnect).toHaveBeenCalledOnce();
  });

  it("preserves liveness when stop IPC delivery fails", async () => {
    const group = new FakeGroupChild();
    group.sendError = new Error("closed");
    const { runtime, unlink } = await bindFakeSupervisor(group);
    runtime.emit("message", { type: "stop", signal: "SIGINT" });
    await runtime.disconnected.promise;

    expect(group.sent).toContainEqual({ type: "stop", signal: "SIGINT" });
    expect(runtime.signals).toEqual([]);
    expect(unlink).not.toHaveBeenCalled();
    expect(runtime.sent).not.toContainEqual({
      type: "result",
      code: 1,
      signal: "SIGINT",
    });
    expect(runtime.disconnect).toHaveBeenCalledOnce();
    expect(group.disconnect).toHaveBeenCalledOnce();
  });

  it("preserves liveness while a disconnected group kills a TERM-ignoring descendant", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, group, unlink } = await bindFakeSupervisor();
      const groupRuntime = new FakeIpcProcess();
      let descendantKilled = false;
      runDeviceLeaseGroup({
        runtime: groupRuntime,
        signalGroup: (signal) => {
          groupRuntime.kill(-groupRuntime.pid, signal);
          if (signal === "SIGKILL") descendantKilled = true;
        },
        spawnCommand: vi.fn(() => new FakeCommandChild()),
        cleanupGraceMs: 100,
        killFallbackMs: 50,
      });
      runtime.connected = false;
      groupRuntime.connected = false;
      runtime.emit("disconnect");
      groupRuntime.emit("disconnect");
      await vi.advanceTimersByTimeAsync(100);
      await runtime.disconnected.promise;

      expect(runtime.signals).toEqual([]);
      expect(groupRuntime.signals).toEqual([
        [-groupRuntime.pid, "SIGTERM"],
        [-groupRuntime.pid, "SIGKILL"],
      ]);
      expect(descendantKilled).toBe(true);
      expect(unlink).not.toHaveBeenCalled();
      expect(runtime.sent).not.toContainEqual({
        type: "result",
        code: 1,
        signal: "SIGTERM",
      });
      expect(runtime.disconnect).toHaveBeenCalledOnce();
      expect(group.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports kill readiness then self-kills if the supervisor hangs", async () => {
    vi.useFakeTimers();
    const runtime = new FakeIpcProcess();
    const command = new FakeCommandChild();
    try {
      runDeviceLeaseGroup({
        runtime,
        signalGroup: (signal) => {
          runtime.kill(-runtime.pid, signal);
        },
        spawnCommand: vi.fn(() => command),
        cleanupGraceMs: 100,
        killFallbackMs: 100,
      });
      runtime.emit("message", {
        type: "start",
        command: ["/command"],
        environment: {},
      });
      command.emit("close", 0, null);
      await Promise.resolve();

      expect(runtime.sent).toContainEqual({
        type: "result",
        code: 0,
        signal: null,
      });
      expect(runtime.disconnect).not.toHaveBeenCalled();

      runtime.emit("message", { type: "stop", signal: "SIGTERM" });
      runtime.emit("SIGTERM");
      expect(runtime.sent).toContainEqual({ type: "stopping" });
      expect(runtime.signals).toEqual([[-runtime.pid, "SIGTERM"]]);
      await vi.advanceTimersByTimeAsync(100);
      expect(runtime.signals).toEqual([[-runtime.pid, "SIGTERM"]]);
      expect(runtime.sent).toContainEqual({ type: "kill_ready" });
      expect(runtime.disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(runtime.signals).toEqual([
        [-runtime.pid, "SIGTERM"],
        [-runtime.pid, "SIGKILL"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an unsupported runtime before reading arguments or environment", async () => {
    let observableEffects = 0;
    const args = new Proxy([] as string[], {
      get() {
        observableEffects += 1;
        throw new Error("arguments must not be read");
      },
    });
    const environment = new Proxy({} as NodeJS.ProcessEnv, {
      get() {
        observableEffects += 1;
        throw new Error("environment must not be read");
      },
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(
        runDeviceLeaseCli(args, environment, "21.99.0"),
      ).resolves.toBe(1);
      expect(observableEffects).toBe(0);
      expect(error).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(
        "Unsupported Node.js runtime; expected >=22.23.1 <23.",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("retires a reported PGID without probing or signaling a reused group", async () => {
    const child = new FakeSupervisorChild();
    const supervisor = fakeSupervisor(child);
    const lease = fakeLease();
    const replacementSignals: Array<[number, string | number]> = [];
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal = "SIGTERM") => {
        replacementSignals.push([pid, signal]);
        return true;
      });
    try {
      const completion = runSupervisedChild(
        ["/command"],
        {},
        lease,
        supervisor,
        new AbortController().signal,
      );
      await Promise.resolve();
      child.emit("message", { type: "result", code: 0, signal: null });
      await expect(completion).resolves.toBe(0);
      expect(supervisor.retired).toBe(true);
      expect(replacementSignals).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  it("routes graceful abort through the connected supervisor", async () => {
    const child = new FakeSupervisorChild();
    const supervisor = fakeSupervisor(child);
    const controller = new AbortController();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const completion = runSupervisedChild(
        ["/command"],
        {},
        fakeLease(),
        supervisor,
        controller.signal,
      );
      controller.abort(
        new DeviceLeaseError(
          "DEVICE_LEASE_INTERRUPTED",
          "interrupted",
          "SIGINT",
        ),
      );
      expect(child.sent).toEqual([
        {
          type: "start",
          command: ["/command"],
          environment: { JETKVM_DEVICE_LEASE_PROOF_PATH: "/proof.json" },
        },
        { type: "stop", signal: "SIGINT" },
      ]);
      expect(kill).not.toHaveBeenCalled();
      child.emit("message", { type: "result", code: 1, signal: "SIGINT" });
      await expect(completion).resolves.toBe(1);
    } finally {
      kill.mockRestore();
    }
  });

  it("waits for a healthy result without a maximum-duration timer", async () => {
    vi.useFakeTimers();
    const child = new FakeSupervisorChild();
    const supervisor = fakeSupervisor(child);
    const release = vi.fn(async () => undefined);
    const lease = fakeLease(release);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    let settled = false;
    try {
      const completion = runSupervisedChild(
        ["/command"],
        {},
        lease,
        supervisor,
        new AbortController().signal,
      ).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0x80000000);
      expect(settled).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();

      child.emit("message", { type: "result", code: 0, signal: null });
      await expect(completion).resolves.toBe(0);
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("preserves lease proof when its bound supervisor disappears", async () => {
    const child = new FakeSupervisorChild();
    const supervisor = fakeSupervisor(child);
    const release = vi.fn(async () => undefined);
    const lease = fakeLease(release);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const completion = runSupervisedChild(
        ["/command"],
        {},
        lease,
        supervisor,
        new AbortController().signal,
      );
      await Promise.resolve();
      child.emit("exit", 1, null);
      await expect(completion).rejects.toThrow(
        "Supervisor exited before command completion.",
      );
      await expect(lease.release()).rejects.toMatchObject({
        code: "DEVICE_LEASE_STALE_UNPROVEN",
      });
      expect(release).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("does not acknowledge start when the command executable is missing", async () => {
    const groupPath = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./deviceLeaseGroup.ts"
          : "./deviceLeaseGroup.js",
        import.meta.url,
      ),
    );
    const group = spawn(process.execPath, [groupPath], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const messages: Array<{ type?: string; code?: number }> = [];
    const result = Promise.withResolvers<{ type?: string; code?: number }>();
    group.on("message", (message: { type?: string; code?: number }) => {
      messages.push(message);
      if (message.type === "ready") {
        group.send({
          type: "start",
          command: [join(tmpdir(), `missing-${randomUUID()}`)],
          environment: {},
        });
      } else if (message.type === "result") {
        result.resolve(message);
      }
    });
    try {
      await expect(result.promise).resolves.toMatchObject({
        type: "result",
        code: 1,
      });
      expect(messages.map(({ type }) => type)).toEqual(["ready", "result"]);
    } finally {
      if (group.exitCode === null && group.signalCode === null) {
        group.kill("SIGKILL");
      }
    }
  });
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

  it("retains the lease when the configured manual-recovery exit code occurs", async () => {
    const isolatedTmp = await mkdtemp(
      join(tmpdir(), "jetkvm-runner-retained-"),
    );
    const deviceKey = `retained-${randomUUID()}`;
    try {
      const retained = await runWrapper(
        [
          "--device-key",
          deviceKey,
          "--retain-on-exit-code",
          "75",
          "--",
          process.execPath,
          "-e",
          "process.exit(75)",
        ],
        { TMPDIR: isolatedTmp },
      );
      expect(retained.code).toBe(1);
      expect(retained.stderr).toContain("manual recovery is required");
      const leaseFiles = await readdir(
        join(isolatedTmp, "jetkvm-device-leases"),
      );
      expect(leaseFiles.some((name) => name.endsWith(".lease.json"))).toBe(
        true,
      );

      const blocked = await runWrapper(
        ["--device-key", deviceKey, "--", process.execPath, "--version"],
        { TMPDIR: isolatedTmp },
      );
      expect(blocked.code).not.toBe(0);
      const recovered = spawnSync(
        process.execPath,
        [recoveryPath, "--device-key", deviceKey, "--confirm-recovered"],
        {
          encoding: "utf8",
          env: { ...scrubDeviceLeaseEnvironment(), TMPDIR: isolatedTmp },
        },
      );
      expect(
        recovered.status,
        JSON.stringify({ stderr: recovered.stderr, leaseFiles }),
      ).toBe(0);
      expect(recovered.stdout).toContain("Retained device lease cleared");

      const unblocked = await runWrapper(
        ["--device-key", deviceKey, "--", process.execPath, "--version"],
        { TMPDIR: isolatedTmp },
      );
      expect(unblocked.code).toBe(0);
    } finally {
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  });

  it("preserves interactive stdin through the detached lease supervisor", async () => {
    const isolatedTmp = await mkdtemp(join(tmpdir(), "jetkvm-runner-stdin-"));
    const child = spawn(
      process.execPath,
      [
        wrapperPath,
        "--device-key",
        `stdin-${randomUUID()}`,
        "--",
        process.execPath,
        "-e",
        "process.stdin.pipe(process.stdout)",
      ],
      {
        env: { ...scrubDeviceLeaseEnvironment(), TMPDIR: isolatedTmp },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const completion = Promise.withResolvers<number | null>();
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
    child.once("error", completion.reject);
    child.once("close", completion.resolve);
    try {
      child.stdin.end("leased-stdio-round-trip");
      expect(await completion.promise).toBe(0);
      expect(stdout).toBe("leased-stdio-round-trip");
      expect(stderr).toBe("");
    } finally {
      child.kill("SIGKILL");
      await rm(isolatedTmp, { recursive: true, force: true });
    }
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

  it("leaves a killed supervisor lease fail-closed without signalling its live group", async () => {
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
      expect(() => process.kill(-supervisorPgid!, 0)).not.toThrow();
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
        await waitForProcessGroupExit(supervisorPgid);
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
