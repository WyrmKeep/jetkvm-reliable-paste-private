#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { DeviceLeaseError, withDeviceLease } from "../src/deviceLease.ts";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const deviceKeyIndex = args.indexOf("--device-key");
if (separator < 0 || deviceKeyIndex < 0 || deviceKeyIndex + 1 >= separator || separator === args.length - 1) {
  console.error("Usage: npm run device-lease:run -- --device-key <key> -- <command...>");
  process.exitCode = 2;
} else {
  const deviceKey = args[deviceKeyIndex + 1];
  const command = args.slice(separator + 1);
  const inheritedValues = [
    process.env.JETKVM_DEVICE_LEASE_PATH,
    process.env.JETKVM_DEVICE_LEASE_OWNER,
    process.env.JETKVM_DEVICE_LEASE_TOKEN,
  ];
  const inheritedCount = inheritedValues.filter((value) => value !== undefined).length;
  if (inheritedCount !== 0 && inheritedCount !== inheritedValues.length) {
    console.error("Incomplete inherited device lease proof.");
    process.exitCode = 2;
  } else {
    const ownerId = process.env.JETKVM_DEVICE_LEASE_OWNER ?? `${hostname()}:${process.pid}`;
    const inheritedProof =
      inheritedCount === inheritedValues.length
        ? { path: inheritedValues[0], ownerId: inheritedValues[1], token: inheritedValues[2] }
        : undefined;
    try {
      const exitCode = await withDeviceLease(
        {
          deviceKey,
          ownerId,
          runId: randomUUID(),
          ...(inheritedProof === undefined ? {} : { inheritedProof }),
        },
        async (lease, signal) => {
          const child = spawn(command[0], command.slice(1), {
            stdio: "inherit",
            shell: false,
            env: {
              ...process.env,
              JETKVM_DEVICE_LEASE_PATH: lease.proof.path,
              JETKVM_DEVICE_LEASE_OWNER: lease.proof.ownerId,
              JETKVM_DEVICE_LEASE_TOKEN: lease.proof.token,
            },
          });
          signal.addEventListener(
            "abort",
            () => {
              const reason = signal.reason;
              child.kill(reason instanceof DeviceLeaseError && reason.signal !== undefined ? reason.signal : "SIGTERM");
            },
            { once: true },
          );
          const completion = Promise.withResolvers();
          child.once("error", (error) => completion.reject(error));
          child.once("close", (code, childSignal) => {
            completion.resolve(code ?? (childSignal === null ? 1 : 128));
          });
          return completion.promise;
        },
      );
      process.exitCode = exitCode;
    } catch (error) {
      if (error instanceof DeviceLeaseError) {
        console.error(error.message);
        process.exitCode = error.signal === "SIGINT" ? 130 : error.signal === undefined ? 1 : 143;
      } else {
        console.error("The leased child process failed to start or exit cleanly.");
        process.exitCode = 1;
      }
    }
  }
}
