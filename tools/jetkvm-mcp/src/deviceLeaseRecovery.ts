import { hostname as systemHostname } from "node:os";

import {
  currentLeaseHostIdentity,
  DeviceLeaseError,
  leaseProcessStartIdentity,
  removeRetainedDeviceLease,
  type DeviceLeaseHostIdentity,
  type DeviceLeaseRecord,
} from "./deviceLease.ts";
import { assertSupportedNodeVersion } from "./runtimePolicy.ts";

export function confirmLocalLeaseOwnerDead(
  record: Readonly<DeviceLeaseRecord>,
  {
    hostname = systemHostname(),
    signal = process.kill,
    identity = currentLeaseHostIdentity,
    processStartIdentity = leaseProcessStartIdentity,
  }: {
    hostname?: string;
    signal?: (pid: number, signal: 0) => unknown;
    identity?: () => DeviceLeaseHostIdentity;
    processStartIdentity?: (pid: number) => string;
  } = {},
): boolean {
  if (
    record.hostname !== hostname ||
    !Number.isSafeInteger(record.pid) ||
    typeof record.host_identity !== "string" ||
    typeof record.boot_identity !== "string" ||
    typeof record.process_start_identity !== "string"
  ) {
    return false;
  }
  let localIdentity;
  try {
    localIdentity = identity();
  } catch {
    return false;
  }
  if (record.host_identity !== localIdentity.hostIdentity) return false;
  if (record.boot_identity !== localIdentity.bootIdentity) return true;
  try {
    signal(record.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  try {
    return processStartIdentity(record.pid) !== record.process_start_identity;
  } catch {
    return false;
  }
}

export async function runDeviceLeaseRecoveryCli(
  args: string[] = process.argv.slice(2),
  nodeVersion: string = process.versions.node,
  removeLease = removeRetainedDeviceLease,
): Promise<number> {
  try {
    assertSupportedNodeVersion(nodeVersion);
  } catch {
    console.error("Unsupported Node.js runtime; expected >=22.23.1 <23.");
    return 1;
  }
  if (
    args.length !== 3 ||
    args[0] !== "--device-key" ||
    typeof args[1] !== "string" ||
    args[1].length === 0 ||
    args[2] !== "--confirm-recovered"
  ) {
    console.error(
      "Usage: node dist/deviceLeaseRecovery.js --device-key <key> --confirm-recovered",
    );
    return 2;
  }
  try {
    await removeLease({
      deviceKey: args[1],
      confirmOwnerDead: async (record) => confirmLocalLeaseOwnerDead(record),
    });
    process.stdout.write("Retained device lease cleared.\n");
    return 0;
  } catch (error) {
    console.error(
      error instanceof DeviceLeaseError
        ? `${error.code}: ${error.message}`
        : "Retained device lease could not be proven safe to clear.",
    );
    return 1;
  }
}

if ((import.meta as ImportMeta & { readonly main?: boolean }).main === true) {
  process.exitCode = await runDeviceLeaseRecoveryCli();
}
