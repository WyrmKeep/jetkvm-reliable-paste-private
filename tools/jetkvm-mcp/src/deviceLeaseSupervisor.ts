import { spawn } from "node:child_process";
import { readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import type { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface BindMessage {
  type: "bind";
  livenessPath: string;
  livenessId: string;
}

interface StartMessage {
  type: "start";
  command: string[];
  environment: NodeJS.ProcessEnv;
}

type SupervisorMessage =
  | BindMessage
  | StartMessage
  | { type: "stop"; signal?: NodeJS.Signals };

type GroupMessage =
  | {
      type: "ready";
      pgid?: number;
    }
  | {
      type: "result";
      code?: number;
      signal?: NodeJS.Signals | null;
    }
  | { type: "stopping" };

interface LeaseSupervisorRuntime {
  readonly pid: number;
  readonly env: NodeJS.ProcessEnv;
  connected: boolean;
  exitCode: number | undefined;
  send?: (message: object, callback?: (error: Error | null) => void) => boolean;
  disconnect?: () => void;
  on: EventEmitter["on"];
}

interface LeaseGroupChild {
  readonly pid?: number;
  connected: boolean;
  send?: (message: object, callback?: (error: Error | null) => void) => boolean;
  disconnect?: () => void;
  on: EventEmitter["on"];
  once: EventEmitter["once"];
}

interface DeviceLeaseSupervisorDependencies {
  runtime: LeaseSupervisorRuntime;
  group: LeaseGroupChild;
  readFile(path: string): Promise<string>;
  unlink(path: string): Promise<unknown>;
  rmdir(path: string): Promise<unknown>;
  writeFile(
    path: string,
    data: string,
    options: { flag: "wx"; mode: number },
  ): Promise<unknown>;
  cleanupTimeoutMs?: number;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;

function cleanupSignal(
  signal: NodeJS.Signals | null | undefined,
): NodeJS.Signals {
  return signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP"
    ? signal
    : "SIGTERM";
}

export function runDeviceLeaseSupervisor({
  runtime,
  group,
  readFile: readLiveness,
  unlink: unlinkLiveness,
  rmdir: removeLivenessDirectory,
  writeFile: writeBootMarker,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
}: DeviceLeaseSupervisorDependencies): void {
  let bound: BindMessage | undefined;
  const groupPgid = group.pid;
  let groupReady = false;
  let groupStarted = false;
  let readyScheduled = false;
  let terminal = false;
  let stopRequested = false;
  let stopAcknowledged = false;
  let reportResult = false;
  let pendingResult:
    | { code: number; signal: NodeJS.Signals | null }
    | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;

  function send(message: object): void {
    if (!runtime.connected || runtime.send === undefined) return;
    try {
      runtime.send(message, () => undefined);
    } catch {
      // The parent disconnect path still asks the live group leader to clean up.
    }
  }

  function clearCleanupTimer(): void {
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    cleanupTimer = undefined;
  }

  function failClosed(code = 1): void {
    if (terminal) return;
    terminal = true;
    clearCleanupTimer();
    runtime.exitCode = code;
    runtime.disconnect?.();
    if (group.connected) {
      try {
        group.disconnect?.();
      } catch {
        // The live group leader will also observe supervisor process exit.
      }
    }
  }

  async function removeLiveness(): Promise<void> {
    if (bound === undefined) return;
    await unlinkLiveness(bound.livenessPath).catch(() => undefined);
    await removeLivenessDirectory(dirname(bound.livenessPath)).catch(
      () => undefined,
    );
  }

  async function completeExpectedClose(): Promise<void> {
    if (
      terminal ||
      !stopRequested ||
      !stopAcknowledged ||
      pendingResult === undefined
    ) {
      failClosed();
      return;
    }
    terminal = true;
    clearCleanupTimer();
    await removeLiveness();
    if (reportResult) {
      send({
        type: "result",
        code: pendingResult.code,
        signal: pendingResult.signal,
      });
    }
    runtime.exitCode = pendingResult.code;
    runtime.disconnect?.();
  }

  function requestGroupStop(
    signal: NodeJS.Signals,
    result: { code: number; signal: NodeJS.Signals | null },
    shouldReportResult: boolean,
  ): void {
    if (terminal || stopRequested) return;
    stopRequested = true;
    pendingResult = result;
    reportResult = shouldReportResult;
    cleanupTimer = setTimeout(failClosed, cleanupTimeoutMs);
    cleanupTimer.unref?.();
    if (!group.connected || group.send === undefined) {
      failClosed();
      return;
    }
    try {
      group.send({ type: "stop", signal }, (error) => {
        if (error !== null) failClosed();
      });
    } catch {
      failClosed();
    }
  }

  async function reportReady(): Promise<void> {
    if (
      terminal ||
      bound === undefined ||
      !groupReady ||
      readyScheduled ||
      groupPgid === undefined
    ) {
      return;
    }
    readyScheduled = true;
    const bootMarkerPath = runtime.env.JETKVM_TEST_SUPERVISOR_BOOT_MARKER_PATH;
    if (bootMarkerPath !== undefined) {
      try {
        await writeBootMarker(
          bootMarkerPath,
          JSON.stringify({
            supervisorPid: runtime.pid,
            commandPgid: groupPgid,
          }),
          { flag: "wx", mode: 0o600 },
        );
      } catch {
        failClosed();
        return;
      }
    }
    const readyDelay = Number(
      runtime.env.JETKVM_TEST_SUPERVISOR_READY_DELAY_MS ?? "0",
    );
    setTimeout(() => {
      if (!terminal) send({ type: "ready", pid: runtime.pid, pgid: groupPgid });
    }, readyDelay).unref();
  }

  if (groupPgid !== undefined) {
    send({ type: "booted", pid: runtime.pid, pgid: groupPgid });
  }

  group.once("error", () => {
    failClosed();
  });
  group.once("close", (_code: number | null, signal: NodeJS.Signals | null) => {
    if (terminal) return;
    if (stopRequested && stopAcknowledged && signal === "SIGKILL") {
      void completeExpectedClose();
    } else {
      failClosed();
    }
  });
  group.on("message", (rawMessage: GroupMessage) => {
    if (terminal) return;
    if (rawMessage.type === "ready") {
      if (
        groupReady ||
        !Number.isSafeInteger(rawMessage.pgid) ||
        rawMessage.pgid !== groupPgid
      ) {
        failClosed();
        return;
      }
      groupReady = true;
      void reportReady();
      return;
    }
    if (rawMessage.type === "result") {
      if (
        !groupReady ||
        !groupStarted ||
        bound === undefined ||
        stopRequested
      ) {
        if (!stopRequested) failClosed();
        return;
      }
      const result = {
        code: rawMessage.code ?? 1,
        signal: rawMessage.signal ?? null,
      };
      requestGroupStop(cleanupSignal(result.signal), result, true);
      return;
    }
    if (rawMessage.type === "stopping") {
      if (!stopRequested || stopAcknowledged) {
        failClosed();
        return;
      }
      stopAcknowledged = true;
      return;
    }
    failClosed();
  });

  runtime.on("disconnect", () => {
    requestGroupStop("SIGTERM", { code: 1, signal: "SIGTERM" }, false);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    runtime.on(signal, () => {
      requestGroupStop(signal, { code: 1, signal }, false);
    });
  }

  runtime.on("message", (rawMessage: SupervisorMessage) => {
    void (async () => {
      if (terminal) return;
      if (rawMessage.type === "bind") {
        let livenessMatches = false;
        try {
          livenessMatches =
            (await readLiveness(rawMessage.livenessPath)) ===
            rawMessage.livenessId;
        } catch {
          livenessMatches = false;
        }
        if (terminal) return;
        if (bound !== undefined || !livenessMatches) {
          failClosed();
          return;
        }
        bound = rawMessage;
        send({ type: "bound" });
        await reportReady();
        return;
      }
      if (rawMessage.type === "stop") {
        const signal = cleanupSignal(rawMessage.signal);
        requestGroupStop(signal, { code: 1, signal }, true);
        return;
      }
      if (
        rawMessage.type !== "start" ||
        bound === undefined ||
        !groupReady ||
        groupStarted ||
        !group.connected ||
        group.send === undefined
      ) {
        failClosed();
        return;
      }
      groupStarted = true;
      try {
        group.send(rawMessage, (error) => {
          if (error !== null) failClosed();
        });
      } catch {
        failClosed();
      }
    })();
  });
}

function groupModulePath(): string {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./deviceLeaseGroup.ts"
        : "./deviceLeaseGroup.js",
      import.meta.url,
    ),
  );
}

function runDefaultSupervisor(): void {
  const group = spawn(process.execPath, [groupModulePath()], {
    detached: true,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  runDeviceLeaseSupervisor({
    runtime: process as unknown as LeaseSupervisorRuntime,
    group: group as unknown as LeaseGroupChild,
    readFile: (path) => readFile(path, "utf8"),
    unlink,
    rmdir,
    writeFile,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDefaultSupervisor();
}
