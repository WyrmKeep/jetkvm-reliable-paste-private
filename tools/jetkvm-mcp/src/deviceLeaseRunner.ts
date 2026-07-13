import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeviceLeaseError,
  loadDeviceLeaseProofReference,
  withDeviceLease,
  type DeviceLease,
  type DeviceLeaseSupervisor,
} from "./deviceLease.ts";

const PROOF_REFERENCE_ENV = "JETKVM_DEVICE_LEASE_PROOF_PATH";
const DEFAULT_SUPERVISOR_READY_TIMEOUT_MS = 5_000;
const SUPERVISOR_STOP_GRACE_MS = 1_000;
const DEVICE_LEASE_ENV_PREFIX = "JETKVM_DEVICE_LEASE_";
const FORBIDDEN_RAW_PROOF_ENV = [
  "JETKVM_DEVICE_LEASE_OWNER",
  "JETKVM_DEVICE_LEASE_TOKEN",
] as const;

type SupervisorMessage = {
  type: "booted" | "ready" | "bound" | "started" | "result";
  pid?: number;
  pgid?: number;
  code?: number;
  signal?: NodeJS.Signals | null;
};

interface SupervisorHandle extends DeviceLeaseSupervisor {
  child: ChildProcess;
  livenessDirectory: string;
}

export function buildLeaseChildEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  proofReferencePath: string,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(
      ([name]) => !name.startsWith(DEVICE_LEASE_ENV_PREFIX),
    ),
  );
  environment[PROOF_REFERENCE_ENV] = proofReferencePath;
  return environment;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function sendSupervisorMessage(child: ChildProcess, message: object): boolean {
  if (!child.connected) return false;
  try {
    child.send(message, () => undefined);
    return true;
  } catch {
    return false;
  }
}

function supervisorModuleUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts")
      ? "./deviceLeaseSupervisor.ts"
      : "./deviceLeaseSupervisor.js",
    import.meta.url,
  );
}

async function waitForSupervisorMessage(
  child: ChildProcess,
  expectedType: SupervisorMessage["type"],
  timeoutMs = DEFAULT_SUPERVISOR_READY_TIMEOUT_MS,
): Promise<SupervisorMessage> {
  const completion = Promise.withResolvers<SupervisorMessage>();
  const timeout = setTimeout(
    () =>
      completion.reject(new Error(`Supervisor did not reach ${expectedType}.`)),
    timeoutMs,
  );
  const onMessage = (message: SupervisorMessage) => {
    if (message.type === expectedType) completion.resolve(message);
  };
  const onExit = () =>
    completion.reject(new Error("Supervisor exited before readiness."));
  child.on("message", onMessage);
  child.once("exit", onExit);
  try {
    return await completion.promise;
  } finally {
    clearTimeout(timeout);
    child.off("message", onMessage);
    child.off("exit", onExit);
  }
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function drainProcessGroup(
  supervisor: SupervisorHandle,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (!processGroupAlive(supervisor.pgid)) return;
  try {
    process.kill(-supervisor.pgid, signal);
  } catch {
    // Group liveness is checked below.
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processGroupAlive(supervisor.pgid)) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  try {
    process.kill(-supervisor.pgid, "SIGKILL");
  } catch {
    // Group liveness is checked below.
  }
  while (processGroupAlive(supervisor.pgid)) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs?: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const completion = Promise.withResolvers<boolean>();
  const onExit = () => completion.resolve(true);
  child.once("exit", onExit);
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => completion.resolve(false), timeoutMs);
  try {
    return await completion.promise;
  } finally {
    clearTimeout(timeout);
    child.off("exit", onExit);
  }
}

async function stopSupervisor(supervisor: SupervisorHandle): Promise<void> {
  if (
    supervisor.child.exitCode === null &&
    supervisor.child.signalCode === null
  ) {
    supervisor.child.kill("SIGTERM");
    if (!(await waitForChildExit(supervisor.child, SUPERVISOR_STOP_GRACE_MS))) {
      supervisor.child.kill("SIGKILL");
      await waitForChildExit(supervisor.child);
    }
  }
  await drainProcessGroup(supervisor);
  await rm(supervisor.livenessDirectory, { recursive: true, force: true });
}

async function startSupervisor(
  environment: NodeJS.ProcessEnv,
): Promise<SupervisorHandle> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(supervisorModuleUrl())],
    {
      detached: true,
      env: environment,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  child.on("error", () => undefined);
  let supervisor: SupervisorHandle | undefined;
  try {
    const readyTimeoutMs = Number(
      environment.JETKVM_TEST_SUPERVISOR_READY_TIMEOUT_MS ??
        DEFAULT_SUPERVISOR_READY_TIMEOUT_MS,
    );
    const booted = await waitForSupervisorMessage(
      child,
      "booted",
      readyTimeoutMs,
    );
    if (
      !Number.isSafeInteger(booted.pid) ||
      !Number.isSafeInteger(booted.pgid)
    ) {
      throw new Error("Supervisor returned an invalid process identity.");
    }
    const livenessDirectory = await mkdtemp(
      join(tmpdir(), "jetkvm-lease-supervisor-"),
    );
    const livenessPath = join(livenessDirectory, "liveness");
    const livenessId = randomUUID();
    await writeFile(livenessPath, livenessId, { flag: "wx", mode: 0o600 });
    supervisor = {
      child,
      pid: booted.pid as number,
      pgid: booted.pgid as number,
      livenessId,
      livenessPath,
      livenessDirectory,
    };
    const bound = waitForSupervisorMessage(child, "bound", readyTimeoutMs);
    const ready = waitForSupervisorMessage(child, "ready", readyTimeoutMs);
    if (
      !sendSupervisorMessage(child, {
        type: "bind",
        livenessPath,
        livenessId,
      })
    ) {
      throw new Error("Supervisor exited before liveness binding.");
    }
    const [, readyMessage] = await Promise.all([bound, ready]);
    if (
      readyMessage.pid !== supervisor.pid ||
      readyMessage.pgid !== supervisor.pgid
    ) {
      throw new Error("Supervisor changed its process identity.");
    }
    return supervisor;
  } catch (error) {
    if (supervisor !== undefined) {
      await stopSupervisor(supervisor);
    } else if (child.pid !== undefined) {
      child.kill("SIGTERM");
      if (!(await waitForChildExit(child, SUPERVISOR_STOP_GRACE_MS))) {
        child.kill("SIGKILL");
        await waitForChildExit(child);
      }
    }
    throw error;
  }
}

async function runSupervisedChild(
  command: readonly string[],
  environment: NodeJS.ProcessEnv,
  lease: DeviceLease,
  supervisor: SupervisorHandle,
  signal: AbortSignal,
): Promise<number> {
  const result = waitForSupervisorMessage(
    supervisor.child,
    "result",
    0x7fffffff,
  );
  const onAbort = () => {
    const reason = signal.reason;
    const childSignal =
      reason instanceof DeviceLeaseError && reason.signal !== undefined
        ? reason.signal
        : "SIGTERM";
    try {
      process.kill(-supervisor.pgid, childSignal);
    } catch {
      // The supervised process group already exited.
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (
      !sendSupervisorMessage(supervisor.child, {
        type: "start",
        command,
        environment: buildLeaseChildEnvironment(
          environment,
          lease.proof.referencePath,
        ),
      })
    ) {
      throw new Error("Supervisor exited before command start.");
    }
    const completed = await result;
    return completed.code ?? signalExitCode(completed.signal ?? null);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await drainProcessGroup(supervisor);
  }
}

export async function runDeviceLeaseCli(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const separator = args.indexOf("--");
  if (
    args[0] !== "--device-key" ||
    typeof args[1] !== "string" ||
    args[1].length === 0 ||
    separator !== 2 ||
    separator === args.length - 1
  ) {
    console.error(
      "Usage: npm run device-lease:run -- --device-key <key> -- <command...>",
    );
    return 2;
  }
  if (process.platform === "win32") {
    console.error("Supervised device leases require a POSIX control host.");
    return 1;
  }
  if (FORBIDDEN_RAW_PROOF_ENV.some((name) => environment[name] !== undefined)) {
    console.error("Raw device lease proof environment is forbidden.");
    return 2;
  }

  const deviceKey = args[1];
  const proofReference = environment[PROOF_REFERENCE_ENV];
  let inheritedProof;
  try {
    inheritedProof =
      proofReference === undefined || proofReference.length === 0
        ? undefined
        : await loadDeviceLeaseProofReference(proofReference);
  } catch {
    console.error("The inherited device lease proof reference is invalid.");
    return 1;
  }
  if (proofReference !== undefined && proofReference.length === 0) {
    console.error("The inherited device lease proof reference is invalid.");
    return 1;
  }

  let supervisor: SupervisorHandle | undefined;
  try {
    supervisor = await startSupervisor(environment);
    const ownerId = inheritedProof?.ownerId ?? `${hostname()}:${process.pid}`;
    return await withDeviceLease(
      {
        deviceKey,
        ownerId,
        runId: randomUUID(),
        supervisor,
        ...(inheritedProof === undefined ? {} : { inheritedProof }),
      },
      (lease, signal) =>
        runSupervisedChild(
          args.slice(separator + 1),
          environment,
          lease,
          supervisor as SupervisorHandle,
          signal,
        ),
    );
  } catch (error) {
    if (error instanceof DeviceLeaseError) {
      console.error(error.message);
      return error.signal === undefined ? 1 : signalExitCode(error.signal);
    }
    console.error(
      "The supervised leased child failed to start or exit cleanly.",
    );
    return 1;
  } finally {
    if (supervisor !== undefined) await stopSupervisor(supervisor);
  }
}

const entryPoint = process.argv[1];
const invokedPath =
  entryPoint === undefined
    ? undefined
    : await realpath(resolve(entryPoint)).catch(() => undefined);
const modulePath = await realpath(fileURLToPath(import.meta.url)).catch(
  () => undefined,
);
if (invokedPath !== undefined && invokedPath === modulePath) {
  process.exitCode = await runDeviceLeaseCli();
}
