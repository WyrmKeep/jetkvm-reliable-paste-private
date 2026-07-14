import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeviceLeaseError,
  loadDeviceLeaseProofReference,
  withDeviceLease,
  type DeviceLease,
  type DeviceLeaseSupervisor,
} from "./deviceLease.ts";
import { assertSupportedNodeVersion } from "./runtimePolicy.ts";

const PROOF_REFERENCE_ENV = "JETKVM_DEVICE_LEASE_PROOF_PATH";
const DEFAULT_SUPERVISOR_READY_TIMEOUT_MS = 5_000;
const SUPERVISOR_STOP_GRACE_MS = 1_000;
const DEVICE_LEASE_ENV_PREFIX = "JETKVM_DEVICE_LEASE_";
const FORBIDDEN_RAW_PROOF_ENV = [
  "JETKVM_DEVICE_LEASE_OWNER",
  "JETKVM_DEVICE_LEASE_TOKEN",
] as const;

type SupervisorMessage = {
  type: "booted" | "ready" | "bound" | "result";
  pid?: number;
  pgid?: number;
  code?: number;
  signal?: NodeJS.Signals | null;
};

export interface SupervisorHandle extends DeviceLeaseSupervisor {
  child: ChildProcess;
  livenessDirectory: string;
  bound: boolean;
  retired: boolean;
}

class SupervisorLostError extends Error {
  constructor(message = "Supervisor exited before command completion.") {
    super(message);
    this.name = "SupervisorLostError";
  }
}
class RetainedDeviceLeaseError extends DeviceLeaseError {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "The device lease is retained because manual recovery is required.",
    );
    this.name = "RetainedDeviceLeaseError";
    this.exitCode = exitCode;
  }
}

function retainedLeaseExitCode(error: unknown): number | undefined {
  if (error instanceof RetainedDeviceLeaseError) return error.exitCode;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const exitCode = retainedLeaseExitCode(nested);
      if (exitCode !== undefined) return exitCode;
    }
  }
  return undefined;
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

function preserveLeaseAfterSupervisorLoss(lease: DeviceLease): void {
  const failure = new DeviceLeaseError(
    "DEVICE_LEASE_STALE_UNPROVEN",
    "The device lease supervisor disappeared before proving command-group death.",
  );
  lease.release = async () => {
    throw failure;
  };
}

function preserveLeaseForManualRecovery(
  lease: DeviceLease,
  exitCode: number,
): void {
  const failure = new RetainedDeviceLeaseError(exitCode);
  lease.release = async () => {
    throw failure;
  };
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
  timeoutMs?: number,
): Promise<SupervisorMessage> {
  const completion = Promise.withResolvers<SupervisorMessage>();
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            completion.reject(
              new Error(`Supervisor did not reach ${expectedType}.`),
            ),
          timeoutMs,
        );
  const onMessage = (message: SupervisorMessage) => {
    if (message.type === expectedType) completion.resolve(message);
  };
  const onExit = () =>
    completion.reject(
      expectedType === "result"
        ? new SupervisorLostError()
        : new Error("Supervisor exited before readiness."),
    );
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
  if (supervisor.retired) return;
  if (
    supervisor.child.exitCode === null &&
    supervisor.child.signalCode === null
  ) {
    const stopDelivered = sendSupervisorMessage(supervisor.child, {
      type: "stop",
      signal: "SIGTERM",
    });
    if (
      stopDelivered &&
      (await waitForChildExit(supervisor.child, SUPERVISOR_STOP_GRACE_MS))
    ) {
      return;
    }
    if (!stopDelivered && supervisor.bound) return;
    supervisor.child.kill("SIGTERM");
    if (!(await waitForChildExit(supervisor.child, SUPERVISOR_STOP_GRACE_MS))) {
      supervisor.child.kill("SIGKILL");
      await waitForChildExit(supervisor.child);
    }
  }
  if (!supervisor.bound) {
    await rm(supervisor.livenessDirectory, { recursive: true, force: true });
  }
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
      stdio: ["inherit", "inherit", "inherit", "ipc"],
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
      bound: false,
      retired: false,
    };
    const bound = waitForSupervisorMessage(child, "bound", readyTimeoutMs).then(
      (message) => {
        (supervisor as SupervisorHandle).bound = true;
        return message;
      },
    );
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

export async function runSupervisedChild(
  command: readonly string[],
  environment: NodeJS.ProcessEnv,
  lease: DeviceLease,
  supervisor: SupervisorHandle,
  signal: AbortSignal,
): Promise<{ readonly code: number; readonly signal: NodeJS.Signals | null }> {
  // Listener installation is synchronous: a fast supervisor result cannot race
  // command delivery, and healthy command execution has no duration timeout.
  const result = waitForSupervisorMessage(supervisor.child, "result");
  const deliveryFailure = Promise.withResolvers<never>();
  const onAbort = () => {
    const reason = signal.reason;
    const childSignal =
      reason instanceof DeviceLeaseError && reason.signal !== undefined
        ? reason.signal
        : "SIGTERM";
    if (
      !sendSupervisorMessage(supervisor.child, {
        type: "stop",
        signal: childSignal,
      })
    ) {
      deliveryFailure.reject(new SupervisorLostError());
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) {
      onAbort();
    } else if (
      !sendSupervisorMessage(supervisor.child, {
        type: "start",
        command,
        environment: buildLeaseChildEnvironment(
          environment,
          lease.proof.referencePath,
        ),
      })
    ) {
      void result.catch(() => undefined);
      throw new SupervisorLostError("Supervisor exited before command start.");
    }
    const completed = await Promise.race([result, deliveryFailure.promise]);
    supervisor.retired = true;
    return Object.freeze({
      code: completed.code ?? signalExitCode(completed.signal ?? null),
      signal: completed.signal ?? null,
    });
  } catch (error) {
    if (error instanceof SupervisorLostError) {
      const reason = signal.reason;
      if (
        signal.aborted &&
        reason instanceof DeviceLeaseError &&
        reason.signal !== undefined
      ) {
        preserveLeaseForManualRecovery(lease, signalExitCode(reason.signal));
      } else {
        preserveLeaseAfterSupervisorLoss(lease);
      }
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function runDeviceLeaseCli(
  args?: string[],
  environment?: NodeJS.ProcessEnv,
  nodeVersion?: string,
): Promise<number> {
  try {
    assertSupportedNodeVersion(nodeVersion);
  } catch {
    console.error("Unsupported Node.js runtime; expected >=22.23.1 <23.");
    return 1;
  }
  args ??= process.argv.slice(2);
  environment ??= process.env;
  const retainOption = args[2] === "--retain-on-exit-code";
  const expectedSeparator = retainOption ? 4 : 2;
  const retainOnExitCode = retainOption ? Number(args[3]) : undefined;
  const separator = args.indexOf("--");
  if (
    args[0] !== "--device-key" ||
    typeof args[1] !== "string" ||
    args[1].length === 0 ||
    separator !== expectedSeparator ||
    separator === args.length - 1 ||
    (retainOption &&
      (!Number.isSafeInteger(retainOnExitCode) ||
        (retainOnExitCode ?? 0) < 1 ||
        (retainOnExitCode ?? 0) > 255))
  ) {
    console.error(
      "Usage: npm run device-lease:run -- --device-key <key> [--retain-on-exit-code <1-255>] -- <command...>",
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
        ...(inheritedProof === undefined
          ? {}
          : {
              inheritedProof,
              directory: dirname(inheritedProof.path),
            }),
      },
      async (lease, signal) => {
        const completed = await runSupervisedChild(
          args.slice(separator + 1),
          environment,
          lease,
          supervisor as SupervisorHandle,
          signal,
        );
        if (
          retainOnExitCode !== undefined &&
          (completed.code === retainOnExitCode ||
            completed.signal !== null ||
            signal.aborted)
        ) {
          const reason = signal.reason;
          const exitCode =
            signal.aborted &&
            reason instanceof DeviceLeaseError &&
            reason.signal !== undefined
              ? signalExitCode(reason.signal)
              : completed.code;
          preserveLeaseForManualRecovery(lease, exitCode);
        }
        return completed.code;
      },
    );
  } catch (error) {
    const retainedExitCode = retainedLeaseExitCode(error);
    if (retainedExitCode !== undefined) {
      console.error(
        "The device lease is retained because manual recovery is required.",
      );
      return retainedExitCode;
    }
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

if ((import.meta as ImportMeta & { readonly main?: boolean }).main === true) {
  process.exitCode = await runDeviceLeaseCli();
}
