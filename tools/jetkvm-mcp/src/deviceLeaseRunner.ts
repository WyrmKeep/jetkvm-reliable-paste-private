import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DeviceLeaseError,
  loadDeviceLeaseProofReference,
  withDeviceLease,
  type DeviceLease,
} from "./deviceLease.ts";

const PROOF_REFERENCE_ENV = "JETKVM_DEVICE_LEASE_PROOF_PATH";
const FORBIDDEN_RAW_PROOF_ENV = [
  "JETKVM_DEVICE_LEASE_OWNER",
  "JETKVM_DEVICE_LEASE_TOKEN",
] as const;

export function buildLeaseChildEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  proofReferencePath: string,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of FORBIDDEN_RAW_PROOF_ENV) delete environment[name];
  environment[PROOF_REFERENCE_ENV] = proofReferencePath;
  return environment;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

async function runChild(
  command: readonly string[],
  environment: NodeJS.ProcessEnv,
  lease: DeviceLease,
  signal: AbortSignal,
): Promise<number> {
  const executable = command[0];
  if (executable === undefined) return 2;
  const child = spawn(executable, command.slice(1), {
    stdio: "inherit",
    shell: false,
    env: buildLeaseChildEnvironment(environment, lease.proof.referencePath),
  });
  signal.addEventListener(
    "abort",
    () => {
      const reason = signal.reason;
      child.kill(
        reason instanceof DeviceLeaseError && reason.signal !== undefined
          ? reason.signal
          : "SIGTERM",
      );
    },
    { once: true },
  );
  const completion = Promise.withResolvers<number>();
  child.once("error", (error) => completion.reject(error));
  child.once("close", (code, childSignal) =>
    completion.resolve(code ?? signalExitCode(childSignal)),
  );
  return completion.promise;
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

  const ownerId = inheritedProof?.ownerId ?? `${hostname()}:${process.pid}`;
  try {
    return await withDeviceLease(
      {
        deviceKey,
        ownerId,
        runId: randomUUID(),
        ...(inheritedProof === undefined ? {} : { inheritedProof }),
      },
      (lease, signal) =>
        runChild(args.slice(separator + 1), environment, lease, signal),
    );
  } catch (error) {
    if (error instanceof DeviceLeaseError) {
      console.error(error.message);
      return error.signal === undefined ? 1 : signalExitCode(error.signal);
    }
    console.error("The leased child process failed to start or exit cleanly.");
    return 1;
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  pathToFileURL(resolve(entryPoint)).href === import.meta.url
) {
  process.exitCode = await runDeviceLeaseCli();
}
