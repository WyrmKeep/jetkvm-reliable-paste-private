import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeviceLeaseError,
  acquireDeviceLease,
  removeStaleDeviceLease,
  removeStaleDeviceLeaseAdminLock,
  withDeviceLease,
  loadDeviceLeaseProofReference,
} from "./deviceLease.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jetkvm-lease-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function adminLockPath(directory: string, deviceKey: string): string {
  const digest = createHash("sha256").update(deviceKey, "utf8").digest("hex");
  return join(directory, `device-${digest}.lease.json.admin.lock`);
}

function adminRecord(ownerId = "admin-owner", token = "admin-token") {
  return {
    version: 1,
    owner_id: ownerId,
    run_id: "admin-run",
    hostname: "admin-host",
    pid: 123,
    acquired_at: "2026-07-12T12:00:00.000Z",
    token,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
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
    expect(lease.proof.referencePath).not.toBe(lease.path);
    expect((await stat(lease.proof.referencePath)).mode & 0o777).toBe(0o600);
    await lease.release();
  });

  it("rejects a preexisting permissive lease directory", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "unsafe");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o777);

    await expect(
      acquireDeviceLease({
        directory,
        deviceKey: "device-a",
        ownerId: "owner-a",
        runId: "run-a",
      }),
    ).rejects.toMatchObject({ code: "DEVICE_LEASE_DIRECTORY_UNSAFE" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("revalidates directory ownership and permissions before admin-lock release", async () => {
    const directory = await temporaryDirectory();
    const lease = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "run-a",
    });
    await chmod(directory, 0o777);

    await expect(lease.release()).rejects.toMatchObject({
      code: "DEVICE_LEASE_DIRECTORY_UNSAFE",
    });
    expect(await readFile(lease.path, "utf8")).toContain("owner-a");

    await chmod(directory, 0o700);
    await lease.release();
  });

  it("fails closed then removes a proven stale admin lock before any lease exists", async () => {
    const directory = await temporaryDirectory();
    const deviceKey = "device-a";
    const path = adminLockPath(directory, deviceKey);
    await writeFile(path, JSON.stringify(adminRecord()), {
      flag: "wx",
      mode: 0o600,
    });

    await expect(
      removeStaleDeviceLeaseAdminLock({ directory, deviceKey }),
    ).rejects.toMatchObject({ code: "DEVICE_LEASE_STALE_UNPROVEN" });
    await removeStaleDeviceLeaseAdminLock({
      directory,
      deviceKey,
      confirmOwnerDead: async (record) => record.pid === 123,
    });

    const lease = await acquireDeviceLease({
      directory,
      deviceKey,
      ownerId: "owner-a",
      runId: "run-a",
    });
    await lease.release();
  });

  it("never deletes a replacement admin lock created during stale verification", async () => {
    const directory = await temporaryDirectory();
    const deviceKey = "device-a";
    const path = adminLockPath(directory, deviceKey);
    await writeFile(
      path,
      JSON.stringify(adminRecord("stale-owner", "stale-token")),
      {
        flag: "wx",
        mode: 0o600,
      },
    );

    await expect(
      removeStaleDeviceLeaseAdminLock({
        directory,
        deviceKey,
        confirmOwnerDead: async () => {
          await unlink(path);
          await writeFile(
            path,
            JSON.stringify(
              adminRecord("replacement-owner", "replacement-token"),
            ),
            {
              flag: "wx",
              mode: 0o600,
            },
          );
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: "DEVICE_LEASE_STALE_UNPROVEN" });
    expect(await readFile(path, "utf8")).toContain("replacement-token");

    await removeStaleDeviceLeaseAdminLock({
      directory,
      deviceKey,
      confirmOwnerDead: async () => true,
    });
  });

  it("validates injected record fields before creating a lease file", async () => {
    const root = await temporaryDirectory();
    const invalidOptions = [
      { hostname: "" },
      { pid: 0 },
      { now: () => new Date(Number.NaN) },
      { randomToken: () => "" },
    ];

    for (const [index, override] of invalidOptions.entries()) {
      const directory = join(root, String(index));
      await expect(
        acquireDeviceLease({
          directory,
          deviceKey: "device-a",
          ownerId: "owner-a",
          runId: "run-a",
          ...override,
        }),
      ).rejects.toMatchObject({ code: "DEVICE_LEASE_PROOF_INVALID" });
      expect(await readdir(directory)).toEqual([]);
    }
  });

  it("rejects a second contender without reading or exposing the proof", async () => {
    const directory = await temporaryDirectory();
    const first = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "run-a",
    });

    await expect(
      acquireDeviceLease({
        directory,
        deviceKey: "device-a",
        ownerId: "owner-b",
        runId: "run-b",
      }),
    ).rejects.toMatchObject({
      code: "DEVICE_LEASE_BUSY",
      message: "The device lease is already held.",
    });
    await first.release();
  });

  it("validates a matching inherited path, owner, and token without reacquiring or releasing the parent lease", async () => {
    const directory = await temporaryDirectory();
    const parent = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "run-a",
    });
    const inherited = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "child-run",
      inheritedProof: parent.proof,
    });

    expect(inherited.inherited).toBe(true);
    await inherited.release();
    expect(await readFile(parent.path, "utf8")).toContain(
      '"owner_id":"owner-a"',
    );

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

  it("loads inherited proof from one protected reference without exporting a token", async () => {
    const directory = await temporaryDirectory();
    const parent = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "run-a",
    });

    await expect(
      loadDeviceLeaseProofReference(parent.proof.referencePath),
    ).resolves.toEqual(parent.proof);
    await expect(
      loadDeviceLeaseProofReference("relative-proof"),
    ).rejects.toMatchObject({
      code: "DEVICE_LEASE_PROOF_INVALID",
    });
    const missingParent = join(directory, "must-not-be-created");
    await expect(
      loadDeviceLeaseProofReference(join(missingParent, "proof.json")),
    ).rejects.toMatchObject({
      code: "DEVICE_LEASE_PROOF_INVALID",
    });
    await expect(stat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
    await parent.release();
  });

  it("invalidates an acquisition capability before a replacement lease can exist", async () => {
    const directory = await temporaryDirectory();
    const first = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "run-a",
    });
    const delayedReference = first.proof.referencePath;
    const delayedProof = first.proof;
    await first.release();

    const replacement = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-b",
      runId: "run-b",
    });
    expect(replacement.proof.referencePath).not.toBe(delayedReference);
    await expect(
      loadDeviceLeaseProofReference(delayedReference),
    ).rejects.toMatchObject({
      code: "DEVICE_LEASE_PROOF_INVALID",
    });
    await expect(
      acquireDeviceLease({
        directory,
        deviceKey: "device-a",
        ownerId: delayedProof.ownerId,
        runId: "delayed-child",
        inheritedProof: delayedProof,
      }),
    ).rejects.toMatchObject({ code: "DEVICE_LEASE_PROOF_INVALID" });
    expect(await readFile(replacement.path, "utf8")).toContain(
      '"owner_id":"owner-b"',
    );
    await replacement.release();
  });

  it("releases the lease in finally when the protected operation throws", async () => {
    const directory = await temporaryDirectory();
    const options = {
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "run-a",
    };

    await expect(
      withDeviceLease(options, async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");

    const next = await acquireDeviceLease({
      ...options,
      ownerId: "owner-b",
      runId: "run-b",
    });
    await next.release();
  });

  it("preserves an explicit rejection with undefined", async () => {
    const directory = await temporaryDirectory();
    let resolved = false;
    try {
      await withDeviceLease(
        {
          directory,
          deviceKey: "device-a",
          ownerId: "owner-a",
          runId: "run-a",
        },
        async () => Promise.reject(undefined),
      );
      resolved = true;
    } catch (error) {
      expect(error).toBeUndefined();
    }
    expect(resolved).toBe(false);
  });

  it("preserves the operation error when lease cleanup also fails", async () => {
    const directory = await temporaryDirectory();
    const original = new Error("operation failed first");

    await expect(
      withDeviceLease(
        {
          directory,
          deviceKey: "device-a",
          ownerId: "owner-a",
          runId: "run-a",
        },
        async (lease) => {
          const record = JSON.parse(await readFile(lease.path, "utf8"));
          await writeFile(
            lease.path,
            JSON.stringify({ ...record, token: "replacement" }),
            { mode: 0o600 },
          );
          throw original;
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors[0] === original &&
        error.errors[1] instanceof DeviceLeaseError,
    );
  });

  it("surfaces cleanup failure after a successful operation", async () => {
    const directory = await temporaryDirectory();

    await expect(
      withDeviceLease(
        {
          directory,
          deviceKey: "device-a",
          ownerId: "owner-a",
          runId: "run-a",
        },
        async (lease) => {
          const record = JSON.parse(await readFile(lease.path, "utf8"));
          await writeFile(
            lease.path,
            JSON.stringify({ ...record, token: "replacement" }),
            { mode: 0o600 },
          );
          return "completed";
        },
      ),
    ).rejects.toMatchObject({ code: "DEVICE_LEASE_PROOF_INVALID" });
  });

  it("removes the stable lease before surfacing capability cleanup failure", async () => {
    const directory = await temporaryDirectory();
    let stablePath = "";
    let capabilityPath = "";
    const lease = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "run-a",
      unlinkFile: async (path) => {
        if (path === capabilityPath)
          throw new Error("capability unlink failed");
        await unlink(path);
      },
    });
    stablePath = lease.path;
    capabilityPath = lease.proof.referencePath;

    await expect(lease.release()).rejects.toThrow("capability unlink failed");
    await expect(readFile(stablePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(capabilityPath, "utf8")).toContain("owner-a");
    await unlink(capabilityPath);
  });

  it("releases in finally when interrupted by a signal", async () => {
    const directory = await temporaryDirectory();
    const signals = new EventEmitter();
    const started = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();
    const childExited = Promise.withResolvers<void>();
    const options = {
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "run-a",
    };
    const running = withDeviceLease(
      options,
      async (_lease, signal) => {
        signal.addEventListener("abort", () => interrupted.resolve(), {
          once: true,
        });
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
    await expect(running).rejects.toMatchObject({
      code: "DEVICE_LEASE_INTERRUPTED",
      signal: "SIGTERM",
    });

    const next = await acquireDeviceLease({
      ...options,
      ownerId: "owner-b",
      runId: "run-b",
    });
    await next.release();
  });

  it("keeps signal handlers active until blocked release cleanup completes", async () => {
    const directory = await temporaryDirectory();
    const deviceKey = "device-a";
    const signals = new EventEmitter();
    const operationFinished = Promise.withResolvers<void>();
    let leasePath = "";
    let referencePath = "";
    const path = adminLockPath(directory, deviceKey);
    const running = withDeviceLease(
      { directory, deviceKey, ownerId: "owner-a", runId: "run-a" },
      async (lease) => {
        leasePath = lease.path;
        referencePath = lease.proof.referencePath;
        await writeFile(path, JSON.stringify(adminRecord()), {
          flag: "wx",
          mode: 0o600,
        });
        operationFinished.resolve();
      },
      { signalSource: signals },
    );
    await operationFinished.promise;
    await delay(25);

    signals.emit("SIGTERM");
    await unlink(path);
    await expect(running).rejects.toMatchObject({
      code: "DEVICE_LEASE_INTERRUPTED",
      signal: "SIGTERM",
    });
    await expect(readFile(leasePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when stale ownership cannot be proven and removes only an exact confirmed-dead proof", async () => {
    const directory = await temporaryDirectory();
    const lease = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "run-a",
    });

    await expect(
      removeStaleDeviceLease({ proof: lease.proof }),
    ).rejects.toMatchObject({
      code: "DEVICE_LEASE_STALE_UNPROVEN",
    });
    await expect(
      removeStaleDeviceLease({
        proof: { ...lease.proof, token: "wrong" },
        confirmOwnerDead: async () => true,
      }),
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

    await expect(
      removeStaleDeviceLease({
        proof: lease.proof,
        confirmOwnerDead: async () => true,
      }),
    ).resolves.toBeUndefined();
    await expect(readFile(lease.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers a proven stale admin lock during lease cleanup and unlinks stable lease first", async () => {
    const directory = await temporaryDirectory();
    const deviceKey = "device-a";
    const lease = await acquireDeviceLease({
      directory,
      deviceKey,
      ownerId: "owner-a",
      runId: "run-a",
    });
    const path = adminLockPath(directory, deviceKey);
    await writeFile(path, JSON.stringify(adminRecord()), {
      flag: "wx",
      mode: 0o600,
    });
    await removeStaleDeviceLeaseAdminLock({
      directory,
      deviceKey,
      confirmOwnerDead: async () => true,
    });

    await expect(
      removeStaleDeviceLease({
        proof: lease.proof,
        confirmOwnerDead: async () => true,
        unlinkFile: async (candidate) => {
          if (candidate === lease.proof.referencePath)
            throw new Error("capability unlink failed");
          await unlink(candidate);
        },
      }),
    ).rejects.toThrow("capability unlink failed");
    await expect(readFile(lease.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(lease.proof.referencePath, "utf8")).toContain(
      "owner-a",
    );

    const replacement = await acquireDeviceLease({
      directory,
      deviceKey,
      ownerId: "owner-b",
      runId: "run-b",
    });
    expect(await readFile(replacement.path, "utf8")).toContain("owner-b");
    await replacement.release();
    await unlink(lease.proof.referencePath);
  });

  it("serializes stale cleanup against a replacement acquire", async () => {
    const directory = await temporaryDirectory();
    const lease = await acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-a",
      runId: "run-a",
    });
    const cleanupEntered = Promise.withResolvers<void>();
    const allowCleanup = Promise.withResolvers<void>();
    const cleanup = removeStaleDeviceLease({
      proof: lease.proof,
      confirmOwnerDead: async () => {
        cleanupEntered.resolve();
        await allowCleanup.promise;
        return true;
      },
    });
    await cleanupEntered.promise;
    const activeAdminPath = adminLockPath(directory, "device-a");
    const activeAdminRecord = JSON.parse(
      await readFile(activeAdminPath, "utf8"),
    );
    expect(activeAdminRecord).toMatchObject({
      version: 1,
      owner_id: expect.any(String),
      run_id: expect.any(String),
      hostname: expect.any(String),
      pid: expect.any(Number),
      acquired_at: expect.any(String),
      token: expect.any(String),
    });
    expect(Number.isFinite(Date.parse(activeAdminRecord.acquired_at))).toBe(
      true,
    );
    expect((await stat(activeAdminPath)).mode & 0o777).toBe(0o600);

    let acquireSettled = false;
    const replacement = acquireDeviceLease({
      directory,
      deviceKey: "device-a",
      ownerId: "owner-b",
      runId: "run-b",
    }).finally(() => {
      acquireSettled = true;
    });
    await delay(25);
    expect(acquireSettled).toBe(false);

    allowCleanup.resolve();
    await cleanup;
    const acquiredReplacement = await replacement;
    expect(acquiredReplacement.proof.ownerId).toBe("owner-b");
    await acquiredReplacement.release();
  });

  it("uses stable non-secret lease errors", () => {
    const error = new DeviceLeaseError(
      "DEVICE_LEASE_BUSY",
      "The device lease is already held.",
    );
    expect(JSON.stringify(error)).not.toContain("token");
  });
});
