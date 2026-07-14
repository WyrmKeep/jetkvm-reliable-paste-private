import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { EventEmitter } from "node:events";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
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
  lease_path?: string;
  capability_path?: string;
  lease_token?: string;
  supervisor_pid?: number;
  supervisor_pgid?: number;
  supervisor_liveness_id?: string;
  supervisor_liveness_path?: string;
}

export type DeviceLeaseAdminRecord = DeviceLeaseRecord;
type DeviceLeaseCapabilityRecord = DeviceLeaseRecord;

export interface DeviceLeaseProof {
  path: string;
  referencePath: string;
  ownerId: string;
  token: string;
}

export interface DeviceLeaseSupervisor {
  pid: number;
  pgid: number;
  livenessId: string;
  livenessPath: string;
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
  supervisor?: DeviceLeaseSupervisor;
  unlinkFile?: (path: string) => Promise<void>;
  afterRecordPrepared?: (finalPath: string) => void | Promise<void>;
  beforeStableLink?: () => void | Promise<void>;
  afterAdminLockBlocked?: () => void | Promise<void>;
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
  unlinkFile?: (path: string) => Promise<void>;
}
export interface RemoveRetainedDeviceLeaseOptions {
  directory?: string;
  deviceKey: string;
  confirmOwnerDead?: (
    record: Readonly<DeviceLeaseRecord>,
  ) => boolean | Promise<boolean>;
}

export interface RemoveStaleDeviceLeaseAdminLockOptions {
  directory?: string;
  deviceKey: string;
  confirmOwnerDead?: (
    record: Readonly<DeviceLeaseAdminRecord>,
  ) => boolean | Promise<boolean>;
  afterFinalCheck?: (adminPath: string) => void | Promise<void>;
  afterCleanupClaimAcquired?: (claimPath: string) => void | Promise<void>;
  afterAdminQuarantined?: (quarantinePath: string) => void | Promise<void>;
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

async function assertSupervisorStopped(
  record: DeviceLeaseRecord,
): Promise<void> {
  if (record.supervisor_pgid === undefined) return;
  if (
    record.supervisor_liveness_path === undefined ||
    record.supervisor_liveness_id === undefined ||
    process.platform === "win32"
  ) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Supervisor process-group liveness cannot be proven on this host.",
    );
  }
  try {
    const livenessIdentity = await lstat(record.supervisor_liveness_path);
    const currentUserId = process.getuid?.();
    if (
      !livenessIdentity.isFile() ||
      (livenessIdentity.mode & 0o777) !== 0o600 ||
      (currentUserId !== undefined && livenessIdentity.uid !== currentUserId)
    ) {
      throw new Error("Unsafe supervisor liveness file.");
    }
    await assertSecureDirectory(dirname(record.supervisor_liveness_path));
    const livenessId = await readFile(record.supervisor_liveness_path, "utf8");
    if (!tokenMatches(livenessId, record.supervisor_liveness_id)) {
      throw new Error("Supervisor liveness identity changed.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_STALE_UNPROVEN",
        "Supervisor liveness identity could not be verified.",
      );
    }
  }
  let groupAlive = false;
  try {
    process.kill(-record.supervisor_pgid, 0);
    groupAlive = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") groupAlive = true;
  }
  if (groupAlive) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "The supervised command process group is still alive.",
    );
  }
}

function validateRecord(value: unknown): DeviceLeaseRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease proof is invalid.",
    );
  }
  const record = value as Partial<DeviceLeaseRecord>;
  const hasSupervisor =
    record.supervisor_pid !== undefined ||
    record.supervisor_pgid !== undefined ||
    record.supervisor_liveness_id !== undefined ||
    record.supervisor_liveness_path !== undefined;
  const invalidSupervisor =
    hasSupervisor &&
    (!Number.isSafeInteger(record.supervisor_pid) ||
      (record.supervisor_pid ?? 0) <= 0 ||
      !Number.isSafeInteger(record.supervisor_pgid) ||
      (record.supervisor_pgid ?? 0) <= 0 ||
      typeof record.supervisor_liveness_id !== "string" ||
      record.supervisor_liveness_id.length === 0 ||
      typeof record.supervisor_liveness_path !== "string" ||
      !isAbsolute(record.supervisor_liveness_path));
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
    invalidSupervisor ||
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
  const record = validateRecord(value);
  if (typeof record.lease_path !== "string" || !isAbsolute(record.lease_path)) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The device lease capability is invalid.",
    );
  }
  return record;
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
    record.lease_path === undefined ||
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

async function publishPrivateRecord(
  finalPath: string,
  record: DeviceLeaseRecord,
  afterRecordPrepared?: (finalPath: string) => void | Promise<void>,
): Promise<void> {
  const temporaryPath = join(
    dirname(finalPath),
    `.publish-${randomBytes(32).toString("hex")}.tmp`,
  );
  let handle;
  let temporaryCreated = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(JSON.stringify(record), { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await afterRecordPrepared?.(finalPath);
    await link(temporaryPath, finalPath);
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
  }
}

interface AdminLockContext {
  capabilityPath?: string;
  leaseToken?: string;
  afterRecordPrepared?: (finalPath: string) => void | Promise<void>;
  waitForCleanupClaim?: boolean;
  supervisor?: DeviceLeaseSupervisor;
  afterBlocked?: () => void | Promise<void>;
}

function createAdminRecord(
  path: string,
  context: AdminLockContext,
): DeviceLeaseAdminRecord {
  const acquiredAt = new Date().toISOString();
  const hostname = systemHostname();
  return validateRecord({
    version: 1,
    owner_id: `${hostname}:${process.pid}`,
    run_id: randomBytes(16).toString("hex"),
    hostname,
    pid: process.pid,
    acquired_at: acquiredAt,
    token: randomBytes(32).toString("hex"),
    lease_path: path,
    ...(context.capabilityPath === undefined
      ? {}
      : {
          capability_path: context.capabilityPath,
          lease_token: context.leaseToken,
        }),
    ...(context.supervisor === undefined
      ? {}
      : {
          supervisor_pid: context.supervisor.pid,
          supervisor_pgid: context.supervisor.pgid,
          supervisor_liveness_id: context.supervisor.livenessId,
          supervisor_liveness_path: context.supervisor.livenessPath,
        }),
  });
}

function cleanupClaimPath(path: string): string {
  return `${path}.admin.lock.cleanup.claim`;
}

async function markerExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function acquireCleanupClaim(
  path: string,
): Promise<{ path: string; release: () => Promise<void> }> {
  await assertSecureDirectory(dirname(path));
  const claimPath = cleanupClaimPath(path);
  const record = createAdminRecord(path, {});
  try {
    await publishPrivateRecord(claimPath, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_BUSY",
        "Device lease cleanup is already in progress.",
      );
    }
    throw error;
  }
  const identity = await lstat(claimPath);
  return {
    path: claimPath,
    async release() {
      await assertSecureDirectory(dirname(path));
      const currentIdentity = await lstat(claimPath);
      const currentRecord = await readRecord(claimPath);
      if (
        currentIdentity.dev !== identity.dev ||
        currentIdentity.ino !== identity.ino ||
        JSON.stringify(currentRecord) !== JSON.stringify(record)
      ) {
        throw new DeviceLeaseError(
          "DEVICE_LEASE_PROOF_INVALID",
          "The device lease cleanup claim changed.",
        );
      }
      await unlink(claimPath);
    },
  };
}

async function acquireAdminLock(
  path: string,
  context: AdminLockContext = {},
): Promise<() => Promise<void>> {
  await assertSecureDirectory(dirname(path));
  const adminPath = `${path}.admin.lock`;
  const record = createAdminRecord(path, context);
  let blockedReported = false;
  const reportBlocked = async () => {
    if (blockedReported) return;
    blockedReported = true;
    await context.afterBlocked?.();
  };
  for (let attempt = 0; attempt < ADMIN_LOCK_ATTEMPTS; attempt += 1) {
    if (await markerExists(cleanupClaimPath(path))) {
      await reportBlocked();
      if (!context.waitForCleanupClaim || attempt === ADMIN_LOCK_ATTEMPTS - 1) {
        throw new DeviceLeaseError(
          "DEVICE_LEASE_BUSY",
          "Device lease cleanup is in progress.",
        );
      }
      await delay(ADMIN_LOCK_RETRY_MS);
      continue;
    }
    try {
      await publishPrivateRecord(
        adminPath,
        record,
        context.afterRecordPrepared,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reportBlocked();
      if (attempt === ADMIN_LOCK_ATTEMPTS - 1) {
        throw new DeviceLeaseError(
          "DEVICE_LEASE_BUSY",
          "The device lease is being administered.",
        );
      }
      await delay(ADMIN_LOCK_RETRY_MS);
      continue;
    }

    const identity = await lstat(adminPath);
    const publishedRecord = await readRecord(adminPath);
    if (JSON.stringify(publishedRecord) !== JSON.stringify(record)) {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_PROOF_INVALID",
        "The device lease admin lock changed before admission.",
      );
    }
    const releaseAdminLock = async () => {
      await assertSecureDirectory(dirname(path));
      await assertSecureProofFile(adminPath);
      const currentIdentity = await lstat(adminPath);
      const currentRecord = await readRecord(adminPath);
      if (
        currentIdentity.dev !== identity.dev ||
        currentIdentity.ino !== identity.ino ||
        JSON.stringify(currentRecord) !== JSON.stringify(record)
      ) {
        throw new DeviceLeaseError(
          "DEVICE_LEASE_PROOF_INVALID",
          "The device lease admin lock changed.",
        );
      }
      await unlink(adminPath);
    };
    if (await markerExists(cleanupClaimPath(path))) {
      await releaseAdminLock();
      throw new DeviceLeaseError(
        "DEVICE_LEASE_BUSY",
        "Device lease cleanup began before admission.",
      );
    }
    return releaseAdminLock;
  }
  throw new DeviceLeaseError(
    "DEVICE_LEASE_BUSY",
    "The device lease is being administered.",
  );
}

async function withAdminLock<T>(
  path: string,
  operation: () => Promise<T>,
  context: AdminLockContext = {},
): Promise<T> {
  const releaseAdminLock = await acquireAdminLock(path, context);
  let operationResult: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    operationResult = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await releaseAdminLock();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (operationFailed && cleanupFailed) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Device lease administration and cleanup both failed.",
      {
        cause: operationError,
      },
    );
  }
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
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

async function assertBoundLease(
  proof: DeviceLeaseProof,
): Promise<DeviceLeaseRecord> {
  await assertSecureProofFile(proof.path);
  await assertSecureProofFile(proof.referencePath);
  const stableIdentity = await lstat(proof.path);
  const capabilityIdentity = await lstat(proof.referencePath);
  const stableRecord = await readRecord(proof.path);
  const capabilityRecord = await readCapabilityRecord(proof.referencePath);
  assertProof(stableRecord, proof);
  assertCapabilityRecord(capabilityRecord, proof);
  if (
    stableIdentity.dev !== capabilityIdentity.dev ||
    stableIdentity.ino !== capabilityIdentity.ino ||
    JSON.stringify(stableRecord) !== JSON.stringify(capabilityRecord)
  ) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The stable lease and capability are not the same record.",
    );
  }
  return stableRecord;
}

export async function loadDeviceLeaseProofReference(
  referencePath: string,
  expectedDeviceKey?: string,
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
    if (capability.lease_path === undefined) {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_PROOF_INVALID",
        "The device lease proof reference is invalid.",
      );
    }
    const resolvedLeasePath = resolve(capability.lease_path);
    if (dirname(resolvedLeasePath) !== dirname(resolvedReferencePath)) {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_PROOF_INVALID",
        "The device lease proof reference is invalid.",
      );
    }
    if (
      expectedDeviceKey !== undefined &&
      resolvedLeasePath !==
        leasePath(dirname(resolvedReferencePath), expectedDeviceKey)
    ) {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_PROOF_INVALID",
        "The device lease proof does not match the configured device.",
      );
    }
    const proof: DeviceLeaseProof = {
      path: resolvedLeasePath,
      referencePath: resolvedReferencePath,
      ownerId: capability.owner_id,
      token: capability.token,
    };
    await withAdminLock(resolvedLeasePath, async () => {
      await assertBoundLease(proof);
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

export async function removeRetainedDeviceLease(
  options: RemoveRetainedDeviceLeaseOptions,
): Promise<void> {
  const directory = resolve(options.directory ?? DEFAULT_LEASE_DIRECTORY);
  await assertSecureDirectory(directory);
  const path = leasePath(directory, options.deviceKey);
  await assertSecureProofFile(path);
  const stableIdentity = await lstat(path);
  const capabilityPaths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/^capability-[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const candidatePath = join(directory, entry.name);
    try {
      await assertSecureProofFile(candidatePath);
      const candidateIdentity = await lstat(candidatePath);
      if (
        candidateIdentity.dev === stableIdentity.dev &&
        candidateIdentity.ino === stableIdentity.ino
      ) {
        capabilityPaths.push(candidatePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (capabilityPaths.length !== 1) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_PROOF_INVALID",
      "The retained device lease proof reference is invalid.",
    );
  }
  const proof = await loadDeviceLeaseProofReference(
    capabilityPaths[0] as string,
    options.deviceKey,
  );
  await removeStaleDeviceLease({
    proof,
    ...(options.confirmOwnerDead === undefined
      ? {}
      : { confirmOwnerDead: options.confirmOwnerDead }),
  });
}

export async function removeStaleDeviceLeaseAdminLock(
  options: RemoveStaleDeviceLeaseAdminLockOptions,
): Promise<void> {
  const directory = resolve(options.directory ?? DEFAULT_LEASE_DIRECTORY);
  await assertSecureDirectory(directory);
  const path = leasePath(directory, options.deviceKey);
  const claim = await acquireCleanupClaim(path);
  let operationFailed = false;
  let operationError: unknown;
  try {
    await options.afterCleanupClaimAcquired?.(claim.path);
    await removeStaleDeviceLeaseAdminLockUnderClaim(options);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await claim.release();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (operationFailed && cleanupFailed) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Stale admin cleanup and cleanup-claim release both failed.",
      { cause: operationError },
    );
  }
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
}

async function removeStaleDeviceLeaseAdminLockUnderClaim(
  options: RemoveStaleDeviceLeaseAdminLockOptions,
): Promise<void> {
  if (options.confirmOwnerDead === undefined) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease administration could not be proven dead.",
    );
  }
  const directory = resolve(options.directory ?? DEFAULT_LEASE_DIRECTORY);
  await assertSecureDirectory(directory);
  const adminPath = `${leasePath(directory, options.deviceKey)}.admin.lock`;
  await assertSecureProofFile(adminPath);
  const beforeIdentity = await lstat(adminPath);
  const beforeRecord = await readRecord(adminPath);

  let confirmedDead = false;
  try {
    confirmedDead = await options.confirmOwnerDead(beforeRecord);
  } catch {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease administration could not be proven dead.",
    );
  }
  if (!confirmedDead) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease administration could not be proven dead.",
    );
  }

  let afterIdentity;
  let afterRecord;
  try {
    await assertSecureDirectory(directory);
    await assertSecureProofFile(adminPath);
    afterIdentity = await lstat(adminPath);
    afterRecord = await readRecord(adminPath);
  } catch {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease administration changed during verification.",
    );
  }
  if (
    afterIdentity.dev !== beforeIdentity.dev ||
    afterIdentity.ino !== beforeIdentity.ino ||
    JSON.stringify(afterRecord) !== JSON.stringify(beforeRecord)
  ) {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease administration changed during verification.",
    );
  }
  await options.afterFinalCheck?.(adminPath);

  const quarantinePath = `${adminPath}.quarantine-${randomBytes(32).toString("hex")}`;
  try {
    await rename(adminPath, quarantinePath);
  } catch {
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease administration could not be claimed.",
    );
  }
  await options.afterAdminQuarantined?.(quarantinePath);
  const quarantinedIdentity = await lstat(quarantinePath);
  const quarantinedRecord = await readRecord(quarantinePath);
  if (
    quarantinedIdentity.dev !== beforeIdentity.dev ||
    quarantinedIdentity.ino !== beforeIdentity.ino ||
    JSON.stringify(quarantinedRecord) !== JSON.stringify(beforeRecord)
  ) {
    try {
      await link(quarantinePath, adminPath);
      await unlink(quarantinePath);
    } catch {
      // A newer owner already occupies the stable admin path; retain quarantine fail-closed.
    }
    throw new DeviceLeaseError(
      "DEVICE_LEASE_STALE_UNPROVEN",
      "Stale device lease administration changed while being claimed.",
    );
  }
  try {
    await assertSupervisorStopped(quarantinedRecord);
  } catch (error) {
    try {
      await link(quarantinePath, adminPath);
      await unlink(quarantinePath);
    } catch {
      // The cleanup claim remains held until this restoration attempt finishes.
    }
    throw error;
  }

  if (
    typeof quarantinedRecord.capability_path === "string" &&
    typeof quarantinedRecord.lease_path === "string" &&
    typeof quarantinedRecord.lease_token === "string"
  ) {
    const capabilityPath = resolve(quarantinedRecord.capability_path);
    const boundLeasePath = resolve(quarantinedRecord.lease_path);
    if (
      dirname(capabilityPath) === directory &&
      dirname(boundLeasePath) === directory
    ) {
      try {
        const capabilityIdentity = await lstat(capabilityPath);
        const capabilityRecord = await readCapabilityRecord(capabilityPath);
        const capabilityMatches =
          capabilityRecord.lease_path !== undefined &&
          resolve(capabilityRecord.lease_path) === boundLeasePath &&
          tokenMatches(capabilityRecord.token, quarantinedRecord.lease_token);
        let stableMatches = false;
        try {
          const stableIdentity = await lstat(boundLeasePath);
          const stableRecord = await readRecord(boundLeasePath);
          stableMatches =
            stableIdentity.dev === capabilityIdentity.dev &&
            stableIdentity.ino === capabilityIdentity.ino &&
            tokenMatches(stableRecord.token, quarantinedRecord.lease_token);
        } catch {
          stableMatches = false;
        }
        if (capabilityMatches && !stableMatches) await unlink(capabilityPath);
      } catch {
        // Missing or changed capability is left untouched.
      }
    }
  }
  await unlink(quarantinePath);
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
  const unlinkLeaseFile = options.unlinkFile ?? unlink;

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
      const record = await assertBoundLease(inheritedProof);
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

  if (options.supervisor !== undefined) {
    if (process.platform === "win32") {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_PROOF_INVALID",
        "Supervised device leases require a POSIX control host.",
      );
    }
    await assertSecureDirectory(dirname(options.supervisor.livenessPath));
    await assertSecureProofFile(options.supervisor.livenessPath);
    if (
      (await readFile(options.supervisor.livenessPath, "utf8")) !==
      options.supervisor.livenessId
    ) {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_PROOF_INVALID",
        "The device lease supervisor liveness identity is invalid.",
      );
    }
  }

  const acquiredDate = (options.now ?? (() => new Date()))();
  const acquiredAt = Number.isFinite(acquiredDate.getTime())
    ? acquiredDate.toISOString()
    : "";
  const record = validateCapabilityRecord({
    version: 1,
    owner_id: options.ownerId,
    run_id: options.runId,
    hostname: options.hostname ?? systemHostname(),
    pid: options.pid ?? process.pid,
    acquired_at: acquiredAt,
    token: (options.randomToken ?? (() => randomBytes(32).toString("hex")))(),
    lease_path: path,
    ...(options.supervisor === undefined
      ? {}
      : {
          supervisor_pid: options.supervisor.pid,
          supervisor_pgid: options.supervisor.pgid,
          supervisor_liveness_id: options.supervisor.livenessId,
          supervisor_liveness_path: options.supervisor.livenessPath,
        }),
  });
  const referencePath = capabilityPath(directory);
  const proof: DeviceLeaseProof = {
    path,
    referencePath,
    ownerId: record.owner_id,
    token: record.token,
  };

  await withAdminLock(
    path,
    async () => {
      let capabilityPublished = false;
      let stablePublished = false;
      try {
        await publishPrivateRecord(
          referencePath,
          record,
          options.afterRecordPrepared,
        );
        capabilityPublished = true;
        await options.beforeStableLink?.();
        await link(referencePath, path);
        stablePublished = true;
        await assertBoundLease(proof);
      } catch (error) {
        if (stablePublished) await unlink(path).catch(() => undefined);
        if (capabilityPublished)
          await unlink(referencePath).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new DeviceLeaseError(
            "DEVICE_LEASE_BUSY",
            "The device lease is already held.",
          );
        }
        throw error;
      }
    },
    {
      capabilityPath: referencePath,
      leaseToken: record.token,
      ...(options.afterRecordPrepared === undefined
        ? {}
        : { afterRecordPrepared: options.afterRecordPrepared }),
      ...(options.supervisor === undefined
        ? {}
        : { supervisor: options.supervisor }),
      ...(options.afterAdminLockBlocked === undefined
        ? {}
        : { afterBlocked: options.afterAdminLockBlocked }),
    },
  );

  let released = false;
  return {
    path,
    proof,
    inherited: false,
    async release() {
      if (released) return;
      await withAdminLock(
        path,
        async () => {
          await assertSecureProofFile(referencePath);
          const capabilityRecord = await readCapabilityRecord(referencePath);
          assertCapabilityRecord(capabilityRecord, proof);
          const capabilityIdentity = await lstat(referencePath);
          let stableIdentity;
          try {
            stableIdentity = await lstat(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (stableIdentity === undefined) {
            await unlinkLeaseFile(referencePath);
            return;
          }
          const stableRecord = await readRecord(path);
          if (
            stableIdentity.dev !== capabilityIdentity.dev ||
            stableIdentity.ino !== capabilityIdentity.ino ||
            stableRecord.owner_id !== proof.ownerId ||
            !tokenMatches(stableRecord.token, proof.token)
          ) {
            await unlinkLeaseFile(referencePath);
            return;
          }
          await unlinkLeaseFile(path);
          await unlinkLeaseFile(referencePath);
        },
        {
          waitForCleanupClaim: true,
          ...(options.afterAdminLockBlocked === undefined
            ? {}
            : { afterBlocked: options.afterAdminLockBlocked }),
        },
      );
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
  let operationFailed = false;
  try {
    operationResult = await operation(lease, abortController.signal);
    if (interruption !== undefined) {
      operationFailed = true;
      operationError = interruption;
    }
  } catch (error) {
    operationFailed = true;
    operationError = interruption ?? error;
  }

  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await lease.release();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  } finally {
    for (const [signal, handler] of handlers) source.off(signal, handler);
  }
  if (!operationFailed && interruption !== undefined) {
    operationFailed = true;
    operationError = interruption;
  }
  if (operationFailed && cleanupFailed) {
    throw new AggregateError(
      [operationError, cleanupError],
      "The operation and device lease cleanup both failed.",
      {
        cause: operationError,
      },
    );
  }
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
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
  const unlinkLeaseFile = options.unlinkFile ?? unlink;
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
    await assertSecureProofFile(options.proof.referencePath);
    const capabilityRecord = await readCapabilityRecord(
      options.proof.referencePath,
    );
    assertCapabilityRecord(capabilityRecord, options.proof);
    const capabilityIdentity = await lstat(options.proof.referencePath);

    let stableIdentity;
    let stableRecord;
    try {
      stableIdentity = await lstat(options.proof.path);
      stableRecord = await readRecord(options.proof.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const boundStable =
      stableIdentity !== undefined &&
      stableRecord !== undefined &&
      stableIdentity.dev === capabilityIdentity.dev &&
      stableIdentity.ino === capabilityIdentity.ino &&
      stableRecord.owner_id === options.proof.ownerId &&
      tokenMatches(stableRecord.token, options.proof.token);
    const recordToConfirm =
      boundStable && stableRecord !== undefined
        ? stableRecord
        : capabilityRecord;
    await assertSupervisorStopped(recordToConfirm);
    let confirmedDead = false;
    try {
      confirmedDead = await confirmOwnerDead(recordToConfirm);
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

    if (!boundStable) {
      await unlinkLeaseFile(options.proof.referencePath);
      return;
    }
    if (stableIdentity === undefined || stableRecord === undefined) {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_STALE_UNPROVEN",
        "Stale device lease ownership changed during verification.",
      );
    }
    const finalStableIdentity = await lstat(options.proof.path);
    const finalCapabilityIdentity = await lstat(options.proof.referencePath);
    const finalStableRecord = await readRecord(options.proof.path);
    const finalCapabilityRecord = await readCapabilityRecord(
      options.proof.referencePath,
    );
    if (
      finalStableIdentity.dev !== stableIdentity.dev ||
      finalStableIdentity.ino !== stableIdentity.ino ||
      finalCapabilityIdentity.dev !== capabilityIdentity.dev ||
      finalCapabilityIdentity.ino !== capabilityIdentity.ino ||
      JSON.stringify(finalStableRecord) !== JSON.stringify(stableRecord) ||
      JSON.stringify(finalCapabilityRecord) !== JSON.stringify(capabilityRecord)
    ) {
      throw new DeviceLeaseError(
        "DEVICE_LEASE_STALE_UNPROVEN",
        "Stale device lease ownership changed during verification.",
      );
    }
    await unlinkLeaseFile(options.proof.path);
    await unlinkLeaseFile(options.proof.referencePath);
  });
}
