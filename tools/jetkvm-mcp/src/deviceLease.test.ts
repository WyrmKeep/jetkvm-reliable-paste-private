import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeviceLeaseError,
  acquireDeviceLease,
  removeStaleDeviceLease,
  withDeviceLease,
} from "./deviceLease.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jetkvm-lease-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("device lease", () => {
  it("atomically creates a restrictive device-keyed lease with complete ownership proof", async () => {
    const directory = await temporaryDirectory();
    const lease = await acquireDeviceLease({
      directory,
      deviceKey: "https://secret-device.invalid/",
      ownerId: "owner-a",
      runId: "run-a",
      hostname: "host-a",
      pid: 123,
      now: () => new Date("2026-07-12T12:00:00.000Z"),
      randomToken: () => "proof-a",
    });

    const record = JSON.parse(await readFile(lease.path, "utf8"));
    expect(record).toEqual({
      version: 1,
      owner_id: "owner-a",
      run_id: "run-a",
      hostname: "host-a",
      pid: 123,
      acquired_at: "2026-07-12T12:00:00.000Z",
      token: "proof-a",
    });
    expect(lease.path).not.toContain("secret-device");
    expect((await stat(lease.path)).mode & 0o777).toBe(0o600);
    await lease.release();
  });

  it("rejects a second contender without reading or exposing the proof", async () => {
    const directory = await temporaryDirectory();
    const first = await acquireDeviceLease({ directory, deviceKey: "device-a", ownerId: "owner-a", runId: "run-a" });

    await expect(
      acquireDeviceLease({ directory, deviceKey: "device-a", ownerId: "owner-b", runId: "run-b" }),
    ).rejects.toMatchObject({ code: "DEVICE_LEASE_BUSY", message: "The device lease is already held." });
    await first.release();
  });

  it("validates a matching inherited path, owner, and token without reacquiring or releasing the parent lease", async () => {
    const directory = await temporaryDirectory();
    const parent = await acquireDeviceLease({ directory, deviceKey: "device-a", ownerId: "owner-a", runId: "run-a" });
    const inherited = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "child-run",
      inheritedProof: parent.proof,
    });

    expect(inherited.inherited).toBe(true);
    await inherited.release();
    expect(await readFile(parent.path, "utf8")).toContain('"owner_id":"owner-a"');

    await expect(
      acquireDeviceLease({
        directory,
        deviceKey: "device-a",
        ownerId: "owner-a",
        runId: "child-run",
        inheritedProof: { ...parent.proof, token: "wrong" },
      }),
    ).rejects.toMatchObject({ code: "DEVICE_LEASE_PROOF_INVALID" });
    await parent.release();
  });

  it("releases the lease in finally when the protected operation throws", async () => {
    const directory = await temporaryDirectory();
    const options = { directory, deviceKey: "device-a", ownerId: "owner-a", runId: "run-a" };

    await expect(
      withDeviceLease(options, async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");

    const next = await acquireDeviceLease({ ...options, ownerId: "owner-b", runId: "run-b" });
    await next.release();
  });

  it("releases in finally when interrupted by a signal", async () => {
    const directory = await temporaryDirectory();
    const signals = new EventEmitter();
    const started = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();
    const childExited = Promise.withResolvers<void>();
    const options = { directory, deviceKey: "device-a", ownerId: "owner-a", runId: "run-a" };
    const running = withDeviceLease(
      options,
      async (_lease, signal) => {
        signal.addEventListener("abort", () => interrupted.resolve(), { once: true });
        started.resolve();
        await childExited.promise;
      },
      { signalSource: signals },
    );
    await started.promise;

    signals.emit("SIGTERM");
    await interrupted.promise;
    await expect(
      acquireDeviceLease({ ...options, ownerId: "owner-b", runId: "run-b" }),
    ).rejects.toMatchObject({ code: "DEVICE_LEASE_BUSY" });
    childExited.resolve();
    await expect(running).rejects.toMatchObject({ code: "DEVICE_LEASE_INTERRUPTED", signal: "SIGTERM" });

    const next = await acquireDeviceLease({ ...options, ownerId: "owner-b", runId: "run-b" });
    await next.release();
  });

  it("fails closed when stale ownership cannot be proven and removes only an exact confirmed-dead proof", async () => {
    const directory = await temporaryDirectory();
    const lease = await acquireDeviceLease({ directory, deviceKey: "device-a", ownerId: "owner-a", runId: "run-a" });

    await expect(removeStaleDeviceLease({ proof: lease.proof })).rejects.toMatchObject({
      code: "DEVICE_LEASE_STALE_UNPROVEN",
    });
    await expect(
      removeStaleDeviceLease({ proof: { ...lease.proof, token: "wrong" }, confirmOwnerDead: async () => true }),
    ).rejects.toMatchObject({ code: "DEVICE_LEASE_PROOF_INVALID" });
    await expect(
      removeStaleDeviceLease({
        proof: lease.proof,
        confirmOwnerDead: async () => {
          throw new Error("cannot inspect PID");
        },
      }),
    ).rejects.toMatchObject({ code: "DEVICE_LEASE_STALE_UNPROVEN" });
    expect(await readFile(lease.path, "utf8")).toContain("owner-a");

    await expect(removeStaleDeviceLease({ proof: lease.proof, confirmOwnerDead: async () => true })).resolves.toBeUndefined();
    await expect(readFile(lease.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses stable non-secret lease errors", () => {
    const error = new DeviceLeaseError("DEVICE_LEASE_BUSY", "The device lease is already held.");
    expect(JSON.stringify(error)).not.toContain("token");
  });
});
