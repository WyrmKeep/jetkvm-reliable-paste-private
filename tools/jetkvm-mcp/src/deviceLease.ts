import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname as systemHostname, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type DeviceLeaseErrorCode =
  | "DEVICE_LEASE_BUSY"
  | "DEVICE_LEASE_PROOF_INVALID"
  | "DEVICE_LEASE_STALE_UNPROVEN"
  | "DEVICE_LEASE_INTERRUPTED";

export class DeviceLeaseError extends Error {
  readonly code: DeviceLeaseErrorCode;
  readonly signal?: NodeJS.Signals;

  constructor(code: DeviceLeaseErrorCode, message: string, signal?: NodeJS.Signals) {
    super(message);
    this.name = "DeviceLeaseError";
    this.code = code;
    if (signal !== undefined) this.signal = signal;
  }
}

export interface DeviceLeaseRecord {
  version: 1;
  owner_id: string;
  run_id: string;
  hostname: string;
  pid: number;
  acquired_at: string;
  token: string;
}

export interface DeviceLeaseProof {
  path: string;
  ownerId: string;
  token: string;
}

export interface AcquireDeviceLeaseOptions {
  directory?: string;
  deviceKey: string;
  ownerId: string;
  runId: string;
  hostname?: string;
  pid?: number;
  now?: () => Date;
  randomToken?: () => string;
  inheritedProof?: DeviceLeaseProof;
}

export interface DeviceLease {
  path: string;
  proof: DeviceLeaseProof;
  inherited: boolean;
  release(): Promise<void>;
}

type SignalSource = Pick<EventEmitter, "on" | "off">;

export interface WithDeviceLeaseOptions {
  signalSource?: SignalSource;
}

export interface RemoveStaleDeviceLeaseOptions {
  proof: DeviceLeaseProof;
  confirmOwnerDead?: (record: Readonly<DeviceLeaseRecord>) => boolean | Promise<boolean>;
}

const DEFAULT_LEASE_DIRECTORY = join(tmpdir(), "jetkvm-device-leases");
const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function validateRecord(value: unknown): DeviceLeaseRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeviceLeaseError("DEVICE_LEASE_PROOF_INVALID", "The inherited device lease proof is invalid.");
  }
  const record = value as Partial<DeviceLeaseRecord>;
  if (
    record.version !== 1 ||
    typeof record.owner_id !== "string" ||
    record.owner_id.length === 0 ||
    typeof record.run_id !== "string" ||
    record.run_id.length === 0 ||
    typeof record.hostname !== "string" ||
    record.hostname.length === 0 ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid ?? 0) <= 0 ||
    typeof record.acquired_at !== "string" ||
    !Number.isFinite(Date.parse(record.acquired_at)) ||
    typeof record.token !== "string" ||
    record.token.length === 0
  ) {
    throw new DeviceLeaseError("DEVICE_LEASE_PROOF_INVALID", "The inherited device lease proof is invalid.");
  }
  return record as DeviceLeaseRecord;
}

async function readRecord(path: string): Promise<DeviceLeaseRecord> {
  try {
    return validateRecord(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof DeviceLeaseError) throw error;
    throw new DeviceLeaseError("DEVICE_LEASE_PROOF_INVALID", "The inherited device lease proof is invalid.");
  }
}

function assertProof(record: DeviceLeaseRecord, proof: DeviceLeaseProof): void {
  if (record.owner_id !== proof.ownerId || !tokenMatches(record.token, proof.token)) {
    throw new DeviceLeaseError("DEVICE_LEASE_PROOF_INVALID", "The inherited device lease proof is invalid.");
  }
}

function leasePath(directory: string, deviceKey: string): string {
  const digest = createHash("sha256").update(deviceKey, "utf8").digest("hex");
  return join(resolve(directory), `device-${digest}.lease.json`);
}

export async function acquireDeviceLease(options: AcquireDeviceLeaseOptions): Promise<DeviceLease> {
  if (options.deviceKey.length === 0 || options.ownerId.length === 0 || options.runId.length === 0) {
    throw new DeviceLeaseError("DEVICE_LEASE_PROOF_INVALID", "The device lease identity is invalid.");
  }
  const directory = options.directory ?? DEFAULT_LEASE_DIRECTORY;
  const path = leasePath(directory, options.deviceKey);

  if (options.inheritedProof !== undefined) {
    if (!isAbsolute(options.inheritedProof.path) || resolve(options.inheritedProof.path) !== path) {
      throw new DeviceLeaseError("DEVICE_LEASE_PROOF_INVALID", "The inherited device lease proof is invalid.");
    }
    const record = await readRecord(path);
    assertProof(record, options.inheritedProof);
    if (record.owner_id !== options.ownerId) {
      throw new DeviceLeaseError("DEVICE_LEASE_PROOF_INVALID", "The inherited device lease proof is invalid.");
    }
    return {
      path,
      proof: options.inheritedProof,
      inherited: true,
      async release() {},
    };
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record: DeviceLeaseRecord = {
    version: 1,
    owner_id: options.ownerId,
    run_id: options.runId,
    hostname: options.hostname ?? systemHostname(),
    pid: options.pid ?? process.pid,
    acquired_at: (options.now ?? (() => new Date()))().toISOString(),
    token: (options.randomToken ?? (() => randomBytes(32).toString("hex")))(),
  };

  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DeviceLeaseError("DEVICE_LEASE_BUSY", "The device lease is already held.");
    }
    throw error;
  }

  try {
    await handle.writeFile(JSON.stringify(record), { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();

  const proof: DeviceLeaseProof = { path, ownerId: record.owner_id, token: record.token };
  let released = false;
  return {
    path,
    proof,
    inherited: false,
    async release() {
      if (released) return;
      const current = await readRecord(path);
      assertProof(current, proof);
      await unlink(path);
      released = true;
    },
  };
}

export async function withDeviceLease<T>(
  options: AcquireDeviceLeaseOptions,
  operation: (lease: DeviceLease, signal: AbortSignal) => Promise<T>,
  lifecycle: WithDeviceLeaseOptions = {},
): Promise<T> {
  const lease = await acquireDeviceLease(options);
  const source = lifecycle.signalSource ?? process;
  const abortController = new AbortController();
  let interruption: DeviceLeaseError | undefined;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of SIGNALS) {
    const handler = () => {
      interruption ??= new DeviceLeaseError(
        "DEVICE_LEASE_INTERRUPTED",
        `The device lease holder received ${signal}.`,
        signal,
      );
      abortController.abort(interruption);
    };
    handlers.set(signal, handler);
    source.on(signal, handler);
  }

  try {
    const result = await operation(lease, abortController.signal);
    if (interruption !== undefined) throw interruption;
    return result;
  } catch (error) {
    if (interruption !== undefined) throw interruption;
    throw error;
  } finally {
    for (const [signal, handler] of handlers) source.off(signal, handler);
    await lease.release();
  }
}

export async function removeStaleDeviceLease(options: RemoveStaleDeviceLeaseOptions): Promise<void> {
  if (options.confirmOwnerDead === undefined) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease ownership could not be proven dead.",
    );
  }
  const before = await readRecord(options.proof.path);
  assertProof(before, options.proof);

  let confirmedDead = false;
  try {
    confirmedDead = await options.confirmOwnerDead(before);
  } catch {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease ownership could not be proven dead.",
    );
  }
  if (!confirmedDead) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease ownership could not be proven dead.",
    );
  }

  const after = await readRecord(options.proof.path);
  assertProof(after, options.proof);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease ownership changed during verification.",
    );
  }
  await access(options.proof.path, constants.W_OK);
  await unlink(options.proof.path);
}
