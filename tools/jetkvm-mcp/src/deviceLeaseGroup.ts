import { spawn, type ChildProcess } from "node:child_process";

interface StartMessage {
  type: "start";
  command: string[];
  environment: NodeJS.ProcessEnv;
}

let commandChild: ChildProcess | undefined;
let disconnecting = false;
let commandSettled = false;

function send(message: object): void {
  if (process.connected) process.send?.(message);
}

function reportResult(code: number, signal: NodeJS.Signals | null): void {
  if (commandSettled) return;
  commandSettled = true;
  if (!process.connected || process.send === undefined) {
    terminate("SIGTERM");
    return;
  }
  process.send({ type: "result", code, signal }, (error) => {
    if (error !== null) {
      terminate("SIGTERM");
      return;
    }
    disconnecting = true;
    process.disconnect?.();
  });
}

function terminate(signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-process.pid, signal);
  } catch {
    process.exitCode = 1;
    process.disconnect?.();
  }
}

process.on("disconnect", () => {
  if (!disconnecting) terminate("SIGTERM");
});
process.on(
  "message",
  (message: StartMessage | { type: "stop"; signal?: NodeJS.Signals }) => {
    if (message.type === "stop") {
      terminate(message.signal ?? "SIGTERM");
      return;
    }
    if (message.type !== "start" || commandChild !== undefined) {
      terminate("SIGTERM");
      return;
    }
    const executable = message.command[0];
    if (executable === undefined) {
      reportResult(2, null);
      return;
    }
    commandChild = spawn(executable, message.command.slice(1), {
      stdio: "inherit",
      shell: false,
      env: message.environment,
    });
    commandChild.once("error", () => {
      reportResult(1, null);
    });
    commandChild.once("close", (code, signal) => {
      reportResult(code ?? 1, signal);
    });
    send({ type: "started" });
  },
);

send({ type: "ready", pid: process.pid, pgid: process.pid });
