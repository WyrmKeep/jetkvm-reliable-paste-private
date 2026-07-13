import { spawn } from "node:child_process";
import { readFile, rmdir, unlink, writeFile } from "node:fs/promises";
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

type GroupMessage = {
  type: "ready" | "result";
  pgid?: number;
  code?: number;
  signal?: NodeJS.Signals | null;
};

let bound: BindMessage | undefined;
let groupPgid: number | undefined;
let groupReady = false;
let readyScheduled = false;
let terminal = false;

function send(message: object): void {
  if (!process.connected) return;
  try {
    process.send?.(message, () => undefined);
  } catch {
    // IPC disconnect handling performs fail-closed group cleanup.
  }
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

function groupAlive(): boolean {
  if (groupPgid === undefined) return false;
  try {
    process.kill(-groupPgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForGroupExit(attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!groupAlive()) return true;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return !groupAlive();
}

async function terminateGroup(signal: NodeJS.Signals): Promise<void> {
  if (groupPgid === undefined || !groupAlive()) return;
  try {
    process.kill(-groupPgid, signal);
  } catch {
    // Group liveness is checked below.
  }
  if (await waitForGroupExit(50)) return;
  try {
    process.kill(-groupPgid, "SIGKILL");
  } catch {
    // Group liveness is checked below.
  }
  while (groupAlive()) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

async function removeLiveness(): Promise<void> {
  if (bound === undefined) return;
  await unlink(bound.livenessPath).catch(() => undefined);
  await rmdir(dirname(bound.livenessPath)).catch(() => undefined);
}

async function finish(
  code: number,
  signal: NodeJS.Signals | null,
  reportResult: boolean,
): Promise<void> {
  if (terminal) return;
  terminal = true;
  await terminateGroup(signal ?? "SIGTERM");
  await removeLiveness();
  if (reportResult) send({ type: "result", code, signal });
  process.exitCode = code;
  process.disconnect?.();
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
  const bootMarkerPath = process.env.JETKVM_TEST_SUPERVISOR_BOOT_MARKER_PATH;
  if (bootMarkerPath !== undefined) {
    try {
      await writeFile(
        bootMarkerPath,
        JSON.stringify({ supervisorPid: process.pid, commandPgid: groupPgid }),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    } catch {
      await finish(1, null, false);
      return;
    }
  }
  const readyDelay = Number(
    process.env.JETKVM_TEST_SUPERVISOR_READY_DELAY_MS ?? "0",
  );
  setTimeout(
    () => send({ type: "ready", pid: process.pid, pgid: groupPgid }),
    readyDelay,
  ).unref();
}

const group = spawn(process.execPath, [groupModulePath()], {
  detached: true,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
groupPgid = group.pid;
if (groupPgid !== undefined) {
  send({ type: "booted", pid: process.pid, pgid: groupPgid });
}

group.once("error", () => {
  void finish(1, null, false);
});
group.once("close", (code, signal) => {
  if (!terminal) void finish(code ?? 1, signal, false);
});
group.on("message", async (message: GroupMessage) => {
  if (message.type === "ready") {
    if (!Number.isSafeInteger(message.pgid) || message.pgid !== groupPgid) {
      await finish(1, null, false);
      return;
    }
    groupReady = true;
    await reportReady();
    return;
  }
  if (message.type === "result") {
    await finish(message.code ?? 1, message.signal ?? null, true);
  }
});

process.on("disconnect", () => {
  void finish(1, "SIGTERM", false);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    void finish(1, signal, false);
  });
}

process.on("message", async (message: SupervisorMessage) => {
  if (message.type === "bind") {
    let livenessMatches = false;
    try {
      livenessMatches =
        (await readFile(message.livenessPath, "utf8")) === message.livenessId;
    } catch {
      livenessMatches = false;
    }
    if (bound !== undefined || !livenessMatches) {
      await finish(1, null, false);
      return;
    }
    bound = message;
    send({ type: "bound" });
    await reportReady();
    return;
  }
  if (message.type === "stop") {
    await finish(1, message.signal ?? "SIGTERM", true);
    return;
  }
  if (message.type !== "start" || bound === undefined) {
    await finish(1, null, false);
    return;
  }
  try {
    group.send?.(message, (error) => {
      if (error !== null) void finish(1, null, false);
    });
  } catch {
    await finish(1, null, false);
  }
});
