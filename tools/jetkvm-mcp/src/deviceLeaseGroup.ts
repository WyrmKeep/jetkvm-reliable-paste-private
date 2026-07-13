import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

interface StartMessage {
  type: "start";
  command: string[];
  environment: NodeJS.ProcessEnv;
}

interface LeaseGroupRuntime {
  readonly pid: number;
  connected: boolean;
  exitCode: number | undefined;
  send?: (message: object, callback?: (error: Error | null) => void) => boolean;
  on: EventEmitter["on"];
}

interface LeaseCommandChild {
  once: EventEmitter["once"];
}

interface DeviceLeaseGroupDependencies {
  runtime: LeaseGroupRuntime;
  signalGroup(signal: NodeJS.Signals): void;
  spawnCommand(
    executable: string,
    args: string[],
    options: {
      stdio: "inherit";
      shell: false;
      env: NodeJS.ProcessEnv;
    },
  ): LeaseCommandChild;
  cleanupGraceMs?: number;
  killFallbackMs?: number;
}

const DEFAULT_CLEANUP_GRACE_MS = 1_000;
const DEFAULT_KILL_FALLBACK_MS = 250;
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export function runDeviceLeaseGroup({
  runtime,
  signalGroup,
  spawnCommand,
  cleanupGraceMs = DEFAULT_CLEANUP_GRACE_MS,
  killFallbackMs = DEFAULT_KILL_FALLBACK_MS,
}: DeviceLeaseGroupDependencies): void {
  let commandChild: LeaseCommandChild | undefined;
  let commandSettled = false;
  let cleanupStarted = false;
  let killReadySent = false;
  let fallbackKillIssued = false;

  function send(
    message: object,
    callback: (error: Error | null) => void = () => undefined,
  ): boolean {
    if (!runtime.connected || runtime.send === undefined) return false;
    try {
      runtime.send(message, callback);
      return true;
    } catch {
      return false;
    }
  }

  function fallbackKillOwnGroup(): void {
    if (fallbackKillIssued) return;
    fallbackKillIssued = true;
    try {
      signalGroup("SIGKILL");
    } catch {
      runtime.exitCode = 1;
    }
  }

  function reportKillReady(): void {
    if (killReadySent) return;
    killReadySent = true;
    let deliveryFailed = false;
    if (
      !send({ type: "kill_ready" }, (error) => {
        if (error !== null) {
          deliveryFailed = true;
          fallbackKillOwnGroup();
        }
      })
    ) {
      fallbackKillOwnGroup();
      return;
    }
    if (!deliveryFailed) {
      setTimeout(fallbackKillOwnGroup, killFallbackMs);
    }
  }

  function beginCleanup(
    requestedSignal: NodeJS.Signals,
    acknowledge: boolean,
  ): void {
    if (cleanupStarted) return;
    cleanupStarted = true;
    if (acknowledge) send({ type: "stopping" });
    try {
      signalGroup(requestedSignal);
    } catch {
      runtime.exitCode = 1;
    }
    setTimeout(reportKillReady, cleanupGraceMs);
  }

  function reportResult(code: number, signal: NodeJS.Signals | null): void {
    if (commandSettled) return;
    commandSettled = true;
    if (
      !send({ type: "result", code, signal }, (error) => {
        if (error !== null) beginCleanup("SIGTERM", false);
      })
    ) {
      beginCleanup("SIGTERM", false);
    }
  }

  runtime.on("disconnect", () => {
    beginCleanup("SIGTERM", false);
  });
  for (const signal of CLEANUP_SIGNALS) {
    runtime.on(signal, () => {
      beginCleanup(signal, false);
    });
  }
  runtime.on(
    "message",
    (message: StartMessage | { type: "stop"; signal?: NodeJS.Signals }) => {
      if (message.type === "stop") {
        const signal =
          message.signal === "SIGINT" ||
          message.signal === "SIGTERM" ||
          message.signal === "SIGHUP"
            ? message.signal
            : "SIGTERM";
        beginCleanup(signal, true);
        return;
      }
      if (
        message.type !== "start" ||
        commandChild !== undefined ||
        cleanupStarted
      ) {
        beginCleanup("SIGTERM", false);
        return;
      }
      const executable = message.command[0];
      if (executable === undefined) {
        reportResult(2, null);
        return;
      }
      commandChild = spawnCommand(executable, message.command.slice(1), {
        stdio: "inherit",
        shell: false,
        env: message.environment,
      });
      commandChild.once("error", () => {
        reportResult(1, null);
      });
      commandChild.once(
        "close",
        (code: number | null, signal: NodeJS.Signals | null) => {
          reportResult(code ?? 1, signal);
        },
      );
    },
  );

  send({ type: "ready", pid: runtime.pid, pgid: runtime.pid });
}

function runDefaultGroup(): void {
  runDeviceLeaseGroup({
    runtime: process as unknown as LeaseGroupRuntime,
    signalGroup: (signal) => process.kill(-process.pid, signal),
    spawnCommand: (executable, args, options) =>
      spawn(executable, args, options) as unknown as LeaseCommandChild,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDefaultGroup();
}
