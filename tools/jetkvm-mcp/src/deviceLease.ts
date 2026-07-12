import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { EventEmitter } from "node:events";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname as systemHostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type DeviceLeaseErrorCode =
  | "DEVICE_LEASE_BUSY"
  | "DEVICE_LEASE_DIRECTORY_UNSAFE"
  | "DEVICE_LEASE_PROOF_INVALID"
  | "DEVICE_LEASE_STALE_UNPROVEN"
  | "DEVICE_LEASE_INTERRUPTED";

export class DeviceLeaseError extends Error {
  readonly code: DeviceLeaseErrorCode;
  readonly signal?: NodeJS.Signals;

  constructor(
    code: DeviceLeaseErrorCode,
    message: string,
    signal?: NodeJS.Signals,
  ) {
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

interface DeviceLeaseCapabilityRecord {
  version: 1;
  lease_path: string;
  owner_id: string;
  token: string;
}

export interface DeviceLeaseProof {
  path: string;
  referencePath: string;
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
  confirmOwnerDead?: (
    record: Readonly<DeviceLeaseRecord>,
  ) => boolean | Promise<boolean>;
}

const DEFAULT_LEASE_DIRECTORY = join(tmpdir(), "jetkvm-device-leases");
const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const ADMIN_LOCK_ATTEMPTS = 500;
const ADMIN_LOCK_RETRY_MS = 10;

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function validateRecord(value: unknown): DeviceLeaseRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease proof is invalid.",
    );
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
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease proof is invalid.",
    );
  }
  return record as DeviceLeaseRecord;
}

function validateCapabilityRecord(value: unknown): DeviceLeaseCapabilityRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease capability is invalid.",
    );
  }
  const record = value as Partial<DeviceLeaseCapabilityRecord>;
  if (
    record.version !== 1 ||
    typeof record.lease_path !== "string" ||
    !isAbsolute(record.lease_path) ||
    typeof record.owner_id !== "string" ||
    record.owner_id.length === 0 ||
    typeof record.token !== "string" ||
    record.token.length === 0
  ) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease capability is invalid.",
    );
  }
  return record as DeviceLeaseCapabilityRecord;
}

async function readCapabilityRecord(
  path: string,
): Promise<DeviceLeaseCapabilityRecord> {
  try {
    return validateCapabilityRecord(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof DeviceLeaseError) throw error;
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease capability is invalid.",
    );
  }
}

function assertCapabilityRecord(
  record: DeviceLeaseCapabilityRecord,
  proof: DeviceLeaseProof,
): void {
  if (
    resolve(record.lease_path) !== proof.path ||
    record.owner_id !== proof.ownerId ||
    !tokenMatches(record.token, proof.token)
  ) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease capability is invalid.",
    );
  }
}

async function readRecord(path: string): Promise<DeviceLeaseRecord> {
  try {
    return validateRecord(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof DeviceLeaseError) throw error;
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease proof is invalid.",
    );
  }
}

function assertProof(record: DeviceLeaseRecord, proof: DeviceLeaseProof): void {
  if (
    record.owner_id !== proof.ownerId ||
    !tokenMatches(record.token, proof.token)
  ) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease proof is invalid.",
    );
  }
}

function leasePath(directory: string, deviceKey: string): string {
  const digest = createHash("sha256").update(deviceKey, "utf8").digest("hex");
  return join(resolve(directory), `device-${digest}.lease.json`);
}

function capabilityPath(directory: string): string {
  return join(directory, `capability-${randomBytes(32).toString("hex")}.json`);
}

async function assertSecureDirectory(directory: string): Promise<void> {
  const information = await lstat(directory);
  const currentUserId = process.getuid?.();
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    (information.mode & 0o077) !== 0 ||
    (currentUserId !== undefined && information.uid !== currentUserId)
  ) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_DIRECTORY_UNSAFE",
      "The device lease directory is not private to the current user.",
    );
  }
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSecureDirectory(directory);
}

async function acquireAdminLock(path: string): Promise<() => Promise<void>> {
  await assertSecureDirectory(dirname(path));
  const adminPath = `${path}.admin.lock`;
  for (let attempt = 0; attempt < ADMIN_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(adminPath, "wx", 0o600);
      const identity = await handle.stat();
      await handle.close();
      return async () => {
        await assertSecureDirectory(dirname(path));
        const current = await lstat(adminPath);
        if (
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          !current.isFile()
        ) {
          throw new DeviceLeaseError(
            "DEVICE_LEASE_PROOF_INVALID",
            "The device lease admin lock changed.",
          );
        }
        await unlink(adminPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === ADMIN_LOCK_ATTEMPTS - 1) {
        throw new DeviceLeaseError(
          "DEVICE_LEASE_BUSY",
          "The device lease is being administered.",
        );
      }
      await delay(ADMIN_LOCK_RETRY_MS);
    }
  }
  throw new DeviceLeaseError(
    "DEVICE_LEASE_BUSY",
    "The device lease is being administered.",
  );
}

async function withAdminLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const releaseAdminLock = await acquireAdminLock(path);
  let operationResult: T | undefined;
  let operationError: unknown;
  try {
    operationResult = await operation();
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await releaseAdminLock();
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Device lease administration and cleanup both failed.",
      {
        cause: operationError,
      },
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return operationResult as T;
}

async function assertSecureProofFile(path: string): Promise<void> {
  let information;
  try {
    information = await lstat(path);
  } catch {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease proof reference is invalid.",
    );
  }
  const currentUserId = process.getuid?.();
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    (information.mode & 0o077) !== 0 ||
    (currentUserId !== undefined && information.uid !== currentUserId)
  ) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease proof reference is invalid.",
    );
  }
}

export async function loadDeviceLeaseProofReference(
  referencePath: string,
): Promise<DeviceLeaseProof> {
  if (!isAbsolute(referencePath)) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease proof reference is invalid.",
    );
  }
  try {
    const resolvedReferencePath = resolve(referencePath);
    await assertSecureDirectory(dirname(resolvedReferencePath));
    await assertSecureProofFile(resolvedReferencePath);
    const capability = await readCapabilityRecord(resolvedReferencePath);
    const resolvedLeasePath = resolve(capability.lease_path);
    if (dirname(resolvedLeasePath) !== dirname(resolvedReferencePath)) {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_PROOF_INVALID",
        "The device lease proof reference is invalid.",
      );
    }
    const proof: DeviceLeaseProof = {
      path: resolvedLeasePath,
      referencePath: resolvedReferencePath,
      ownerId: capability.owner_id,
      token: capability.token,
    };
    await withAdminLock(resolvedLeasePath, async () => {
      await assertSecureProofFile(resolvedLeasePath);
      const record = await readRecord(resolvedLeasePath);
      assertProof(record, proof);
      assertCapabilityRecord(capability, proof);
    });
    return proof;
  } catch (error) {
    if (error instanceof DeviceLeaseError) throw error;
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease proof reference is invalid.",
    );
  }
}

export async function acquireDeviceLease(
  options: AcquireDeviceLeaseOptions,
): Promise<DeviceLease> {
  if (
    options.deviceKey.length === 0 ||
    options.ownerId.length === 0 ||
    options.runId.length === 0
  ) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease identity is invalid.",
    );
  }
  const directory = resolve(options.directory ?? DEFAULT_LEASE_DIRECTORY);
  await ensureSecureDirectory(directory);
  const path = leasePath(directory, options.deviceKey);

  if (options.inheritedProof !== undefined) {
    const inheritedProof = options.inheritedProof;
    if (
      !isAbsolute(inheritedProof.path) ||
      resolve(inheritedProof.path) !== path ||
      !isAbsolute(inheritedProof.referencePath) ||
      dirname(resolve(inheritedProof.referencePath)) !== directory
    ) {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_PROOF_INVALID",
        "The inherited device lease proof is invalid.",
      );
    }
    await withAdminLock(path, async () => {
      await assertSecureProofFile(path);
      await assertSecureProofFile(inheritedProof.referencePath);
      const record = await readRecord(path);
      const capability = await readCapabilityRecord(
        inheritedProof.referencePath,
      );
      assertProof(record, inheritedProof);
      assertCapabilityRecord(capability, inheritedProof);
      if (record.owner_id !== options.ownerId) {
        throw new DeviceLeaseError(
          "DEVICE_LEASE_PROOF_INVALID",
          "The inherited device lease proof is invalid.",
        );
      }
    });
    return {
      path,
      proof: inheritedProof,
      inherited: true,
      async release() {},
    };
  }

  const acquiredDate = (options.now ?? (() => new Date()))();
  const acquiredAt = Number.isFinite(acquiredDate.getTime())
    ? acquiredDate.toISOString()
    : "";
  const record = validateRecord({
    version: 1,
    owner_id: options.ownerId,
    run_id: options.runId,
    hostname: options.hostname ?? systemHostname(),
    pid: options.pid ?? process.pid,
    acquired_at: acquiredAt,
    token: (options.randomToken ?? (() => randomBytes(32).toString("hex")))(),
  });
  const referencePath = capabilityPath(directory);
  const proof: DeviceLeaseProof = {
    path,
    referencePath,
    ownerId: record.owner_id,
    token: record.token,
  };
  const capability = validateCapabilityRecord({
    version: 1,
    lease_path: path,
    owner_id: record.owner_id,
    token: record.token,
  });

  await withAdminLock(path, async () => {
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DeviceLeaseError(
          "DEVICE_LEASE_BUSY",
          "The device lease is already held.",
        );
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
    let capabilityHandle;
    let capabilityCreated = false;
    try {
      capabilityHandle = await open(referencePath, "wx", 0o600);
      capabilityCreated = true;
      await capabilityHandle.writeFile(JSON.stringify(capability), {
        encoding: "utf8",
      });
      await capabilityHandle.sync();
      await capabilityHandle.close();
    } catch (error) {
      await capabilityHandle?.close().catch(() => undefined);
      if (capabilityCreated) await unlink(referencePath).catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
  });

  let released = false;
  return {
    path,
    proof,
    inherited: false,
    async release() {
      if (released) return;
      await withAdminLock(path, async () => {
        const current = await readRecord(path);
        const currentCapability = await readCapabilityRecord(referencePath);
        assertProof(current, proof);
        assertCapabilityRecord(currentCapability, proof);
        await unlink(referencePath);
        await unlink(path);
      });
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

  let operationResult: T | undefined;
  let operationError: unknown;
  try {
    operationResult = await operation(lease, abortController.signal);
    if (interruption !== undefined) operationError = interruption;
  } catch (error) {
    operationError = interruption ?? error;
  } finally {
    for (const [signal, handler] of handlers) source.off(signal, handler);
  }

  let cleanupError: unknown;
  try {
    await lease.release();
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      "The operation and device lease cleanup both failed.",
      {
        cause: operationError,
      },
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return operationResult as T;
}

export async function removeStaleDeviceLease(
  options: RemoveStaleDeviceLeaseOptions,
): Promise<void> {
  if (options.confirmOwnerDead === undefined) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease ownership could not be proven dead.",
    );
  }
  const confirmOwnerDead = options.confirmOwnerDead;
  if (
    !isAbsolute(options.proof.path) ||
    !isAbsolute(options.proof.referencePath) ||
    dirname(resolve(options.proof.referencePath)) !==
      dirname(resolve(options.proof.path))
  ) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease proof is invalid.",
    );
  }
  await assertSecureDirectory(dirname(options.proof.path));
  await withAdminLock(options.proof.path, async () => {
    await assertSecureProofFile(options.proof.path);
    await assertSecureProofFile(options.proof.referencePath);
    const capability = await readCapabilityRecord(options.proof.referencePath);
    assertCapabilityRecord(capability, options.proof);
    const before = await readRecord(options.proof.path);
    assertProof(before, options.proof);

    let confirmedDead = false;
    try {
      confirmedDead = await confirmOwnerDead(before);
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
    await unlink(options.proof.referencePath);
    await unlink(options.proof.path);
  });
}
