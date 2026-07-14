import { hostname as systemHostname } from "node:os";

import {
  DeviceLeaseError,
  removeRetainedDeviceLease,
  type DeviceLeaseRecord,
} from "./deviceLease.ts";
import { assertSupportedNodeVersion } from "./runtimePolicy.ts";

export function confirmLocalLeaseOwnerDead(
  record: Readonly<DeviceLeaseRecord>,
  {
    hostname = systemHostname(),
    signal = process.kill,
  }: {
    hostname?: string;
    signal?: (pid: number, signal: 0) => unknown;
  } = {},
): boolean {
  if (record.hostname !== hostname || !Number.isSafeInteger(record.pid)) {
    return false;
  }
  try {
    signal(record.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
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
