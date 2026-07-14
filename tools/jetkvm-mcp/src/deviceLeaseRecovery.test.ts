import { hostname } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeviceLeaseAdminRecord } from "./deviceLease.js";
import {
  confirmLocalLeaseOwnerDead,
  runDeviceLeaseRecoveryCli,
} from "./deviceLeaseRecovery.js";

function record(overrides: Partial<DeviceLeaseAdminRecord> = {}) {
  return {
    version: 1 as const,
    owner_id: "owner",
    run_id: "run",
    hostname: hostname(),
    pid: 4242,
    acquired_at: "2026-07-14T00:00:00.000Z",
    token: "token",
    host_identity: "a".repeat(64),
    boot_identity: "b".repeat(64),
    process_start_identity: "c".repeat(64),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retained device lease recovery", () => {
  it("confirms death only for the same durable host and process lifetime", () => {
    const identity = () => ({
      hostIdentity: "a".repeat(64),
      bootIdentity: "b".repeat(64),
    });
    expect(
      confirmLocalLeaseOwnerDead(record(), {
        identity,
        signal: () => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        },
      }),
    ).toBe(true);
    expect(
      confirmLocalLeaseOwnerDead(record(), {
        identity,
        signal: () => undefined,
        processStartIdentity: () => "c".repeat(64),
      }),
    ).toBe(false);
    expect(
      confirmLocalLeaseOwnerDead(record(), {
        identity,
        signal: () => undefined,
        processStartIdentity: () => "d".repeat(64),
      }),
    ).toBe(true);
    expect(
      confirmLocalLeaseOwnerDead(record({ host_identity: "d".repeat(64) }), {
        identity,
        signal: () => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        },
      }),
    ).toBe(false);
    expect(
      confirmLocalLeaseOwnerDead(record({ boot_identity: "d".repeat(64) }), {
        identity,
        signal: () => undefined,
        processStartIdentity: () => "c".repeat(64),
      }),
    ).toBe(true);
    const legacyRecord: DeviceLeaseAdminRecord = record();
    delete legacyRecord.host_identity;
    delete legacyRecord.boot_identity;
    delete legacyRecord.process_start_identity;
    expect(
      confirmLocalLeaseOwnerDead(legacyRecord, {
        identity,
        signal: () => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        },
      }),
    ).toBe(false);
    expect(
      confirmLocalLeaseOwnerDead(record(), {
        identity,
        signal: () => {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        },
      }),
    ).toBe(false);
  });

  it("requires explicit recovery confirmation before admin cleanup", async () => {
    const remove = vi.fn(async () => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runDeviceLeaseRecoveryCli(["--device-key", "device"], "22.23.1", remove),
    ).resolves.toBe(2);
    expect(remove).not.toHaveBeenCalled();
  });

  it("clears only through the stale-admin safety API", async () => {
    const remove = vi.fn(async (options) => {
      expect(options.deviceKey).toBe("device");
      expect(typeof options.confirmOwnerDead).toBe("function");
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(
      runDeviceLeaseRecoveryCli(
        ["--device-key", "device", "--confirm-recovered"],
        "22.23.1",
        remove,
      ),
    ).resolves.toBe(0);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("fails closed when stale ownership cannot be cleared", async () => {
    const remove = vi.fn(async () => {
      throw new Error("still live");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runDeviceLeaseRecoveryCli(
        ["--device-key", "device", "--confirm-recovered"],
        "22.23.1",
        remove,
      ),
    ).resolves.toBe(1);
  });
});
