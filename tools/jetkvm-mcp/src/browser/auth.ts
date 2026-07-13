import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { inspect } from "node:util";
import type { LegacySseSecurityPolicy } from "../config.js";

/**
 * Maximum UTF-8 byte length accepted for every activated credential source.
 * Keeping this fixed also bounds stored-secret hashing during authentication.
 */
export const CREDENTIAL_MAX_BYTES = 4_096;
const REDACTED = "[REDACTED]";
const CREDENTIAL_TOO_LARGE_MESSAGE = "Credential exceeds maximum size";
const PROTECTED_CREDENTIAL_FILE_MESSAGE =
  "Credential source must be a protected regular file";
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export interface CredentialSourceSelection {
  readonly environmentVariable: string;
  readonly filePath?: string;
}

export interface CredentialSourceOptions {
  readonly cliFilePath?: string;
  readonly environmentFilePath?: string;
  readonly environmentVariable?: string;
}

export interface CredentialFileMetadata {
  readonly uid: number;
  readonly mode: number;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface CredentialAccess {
  readEnvironment(name: string): string | undefined;
  deleteEnvironment(name: string): void;
  readProtectedFile?(path: string): Uint8Array;
}

export interface SecretByteAllocator {
  allocateUtf8(value: string): Uint8Array;
  copyBytes(value: Uint8Array): Uint8Array;
}

export interface LegacySseRequestHeaders {
  readonly method: "GET" | "POST";
  readonly host?: string;
  readonly origin?: string;
  readonly authorization?: string;
  readonly antiCsrf?: string;
}

export interface LegacySsePrincipal {
  readonly principalId: string;
}

export interface LegacySseBearerCredential {
  readonly principalId: string;
  readonly secret: DisposableSecret;
}

const INDEPENDENT_LEGACY_SSE_BEARER: unique symbol = Symbol(
  "IndependentLegacySseBearerCredential",
);
const ACTIVATED_LEGACY_SSE_BEARERS = new WeakSet<object>();

export interface IndependentLegacySseBearerCredential extends LegacySseBearerCredential {
  readonly [INDEPENDENT_LEGACY_SSE_BEARER]: true;
}

export type LegacySseBearerAuthenticator = (
  authorization: string | undefined,
) => LegacySsePrincipal;

export class CredentialConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialConfigurationError";
  }
}

export class HttpBoundaryError extends Error {
  readonly statusCode: 401 | 403;

  constructor(statusCode: 401 | 403) {
    super(statusCode === 401 ? "Unauthorized" : "Request forbidden");
    this.name = "HttpBoundaryError";
    this.statusCode = statusCode;
  }
}

export class DisposableSecret implements Disposable {
  #bytes: Uint8Array | undefined;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  static fromUtf8(
    value: string,
    allocator: SecretByteAllocator = defaultSecretByteAllocator,
  ): DisposableSecret {
    if (value.length === 0) {
      throw new CredentialConfigurationError("Credential is empty");
    }
    if (!isCredentialUtf8WithinLimit(value)) {
      throw new CredentialConfigurationError(CREDENTIAL_TOO_LARGE_MESSAGE);
    }
    return new DisposableSecret(allocator.allocateUtf8(value));
  }

  static fromBytes(
    value: Uint8Array,
    allocator: SecretByteAllocator = defaultSecretByteAllocator,
  ): DisposableSecret {
    if (value.byteLength === 0) {
      throw new CredentialConfigurationError("Credential is empty");
    }
    assertCredentialByteLength(value.byteLength);
    return new DisposableSecret(allocator.copyBytes(value));
  }

  get disposed(): boolean {
    return this.#bytes === undefined;
  }

  useBytes<T>(consumer: (bytes: Uint8Array) => T): T {
    const bytes = this.#bytes;
    if (bytes === undefined) {
      throw new CredentialConfigurationError("Secret has been disposed");
    }
    return consumer(bytes);
  }

  useUtf8<T>(consumer: (value: string) => T): T {
    return this.useBytes((bytes) => consumer(UTF8_DECODER.decode(bytes)));
  }

  dispose(): void {
    this.#bytes?.fill(0);
    this.#bytes = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

const defaultSecretByteAllocator: SecretByteAllocator = Object.freeze({
  allocateUtf8(value: string): Uint8Array {
    return UTF8_ENCODER.encode(value);
  },
  copyBytes(value: Uint8Array): Uint8Array {
    return Uint8Array.from(value);
  },
});

export function selectCredentialSource(
  options: CredentialSourceOptions,
): Readonly<CredentialSourceSelection> {
  const environmentVariable =
    options.environmentVariable ?? "JETKVM_CREDENTIAL";
  if (!ENVIRONMENT_NAME.test(environmentVariable)) {
    throw new CredentialConfigurationError(
      "Credential environment source is invalid",
    );
  }

  const cliFilePath = normalizeOptionalPath(options.cliFilePath);
  const environmentFilePath = normalizeOptionalPath(
    options.environmentFilePath,
  );
  const filePath = cliFilePath ?? environmentFilePath;
  return Object.freeze(
    filePath === undefined
      ? { environmentVariable }
      : { environmentVariable, filePath },
  );
}

export function loadCredentialSecret(
  source: CredentialSourceSelection,
  access: CredentialAccess = processCredentialAccess,
): DisposableSecret {
  const environmentValue = access.readEnvironment(source.environmentVariable);
  if (environmentValue !== undefined && source.filePath !== undefined) {
    throw new CredentialConfigurationError("Conflicting credential sources");
  }

  if (environmentValue !== undefined) {
    if (environmentValue.length === 0) {
      throw new CredentialConfigurationError("Credential is empty");
    }
    const secret = DisposableSecret.fromUtf8(environmentValue);
    try {
      access.deleteEnvironment(source.environmentVariable);
    } catch {
      secret.dispose();
      throw new CredentialConfigurationError(
        "Credential environment source could not be cleared",
      );
    }
    return secret;
  }

  if (source.filePath === undefined) {
    throw new CredentialConfigurationError("Credential is not available");
  }

  const bytes = (access.readProtectedFile ?? readProtectedCredentialFile)(
    source.filePath,
  );
  let normalized: Uint8Array | undefined;
  try {
    assertCredentialByteLength(bytes.byteLength);
    normalized = stripOneTerminalLineEnding(bytes);
    return DisposableSecret.fromBytes(normalized);
  } finally {
    normalized?.fill(0);
    bytes.fill(0);
  }
}

export function activateIndependentLegacySseBearerCredential(
  targetSecret: DisposableSecret,
  bearer: LegacySseBearerCredential,
): IndependentLegacySseBearerCredential {
  let targetDigest: Buffer | undefined;
  let bearerDigest: Buffer | undefined;
  try {
    targetDigest = targetSecret.useBytes((bytes) =>
      createHash("sha256").update(bytes).digest(),
    );
    bearerDigest = bearer.secret.useBytes((bytes) =>
      createHash("sha256").update(bytes).digest(),
    );
    if (timingSafeEqual(targetDigest, bearerDigest)) {
      throw new CredentialConfigurationError(
        "Target and legacy SSE credentials must be independent",
      );
    }
    const activated = Object.freeze({
      principalId: bearer.principalId,
      secret: bearer.secret,
    }) as IndependentLegacySseBearerCredential;
    ACTIVATED_LEGACY_SSE_BEARERS.add(activated);
    return activated;
  } catch {
    targetSecret.dispose();
    bearer.secret.dispose();
    throw new CredentialConfigurationError(
      "Target and legacy SSE credentials must be independent",
    );
  } finally {
    targetDigest?.fill(0);
    bearerDigest?.fill(0);
  }
}

export function assertIndependentLegacySseBearerCredential(
  bearer: IndependentLegacySseBearerCredential,
): void {
  if (ACTIVATED_LEGACY_SSE_BEARERS.has(bearer)) return;
  throw new CredentialConfigurationError(
    "Legacy SSE bearer credential must be independently activated",
  );
}

export function validateCredentialFileMetadata(
  metadata: CredentialFileMetadata,
  currentUid: number,
): void {
  if (!metadata.isFile || metadata.isSymbolicLink) {
    throw new CredentialConfigurationError(PROTECTED_CREDENTIAL_FILE_MESSAGE);
  }
  if (metadata.uid !== currentUid) {
    throw new CredentialConfigurationError(
      "Credential file is not owned by the current user",
    );
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new CredentialConfigurationError(
      "Credential file permissions are not private",
    );
  }
}

export function evaluateLegacySseRequest(
  request: LegacySseRequestHeaders,
  policy: LegacySseSecurityPolicy,
  bearer?: LegacySseBearerCredential,
  authenticateBearer?: LegacySseBearerAuthenticator,
): LegacySsePrincipal {
  if (!policy.enabled) {
    throw new HttpBoundaryError(403);
  }

  const principal = authenticateRequest(
    request.authorization,
    policy,
    bearer,
    authenticateBearer,
  );

  if (
    request.host === undefined ||
    !policy.hostAuthorities.includes(normalizeRequestAuthority(request.host))
  ) {
    throw new HttpBoundaryError(403);
  }

  if (request.origin === undefined) {
    if (policy.rejectMissingOrigin) {
      throw new HttpBoundaryError(403);
    }
  } else if (
    !policy.allowedOrigins.includes(normalizeRequestOrigin(request.origin))
  ) {
    throw new HttpBoundaryError(403);
  }

  if (policy.requiresAntiCsrf && request.antiCsrf !== "1") {
    throw new HttpBoundaryError(403);
  }

  return Object.freeze({ principalId: principal });
}

function authenticateRequest(
  authorization: string | undefined,
  policy: LegacySseSecurityPolicy,
  bearer: LegacySseBearerCredential | undefined,
  authenticateBearer: LegacySseBearerAuthenticator | undefined,
): string {
  if (!policy.requiresBearer) {
    return "local-operator";
  }
  if (
    authorization !== undefined &&
    (authorization.length > "Bearer ".length + CREDENTIAL_MAX_BYTES ||
      Buffer.byteLength(authorization, "utf8") >
        "Bearer ".length + CREDENTIAL_MAX_BYTES)
  ) {
    throw new HttpBoundaryError(401);
  }
  if (authenticateBearer !== undefined) {
    try {
      const principal = authenticateBearer(authorization);
      if (!/^[a-zA-Z0-9._~-]{1,128}$/u.test(principal.principalId)) {
        throw new Error("invalid principal");
      }
      return principal.principalId;
    } catch {
      throw new HttpBoundaryError(401);
    }
  }
  if (bearer === undefined || authorization === undefined) {
    throw new HttpBoundaryError(401);
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (
    match === null ||
    match[1] === undefined ||
    !matchesSecret(match[1], bearer.secret)
  ) {
    throw new HttpBoundaryError(401);
  }
  return bearer.principalId;
}

function matchesSecret(candidate: string, secret: DisposableSecret): boolean {
  if (!isCredentialUtf8WithinLimit(candidate)) {
    return false;
  }
  let candidateDigest: Buffer | undefined;
  let secretDigest: Buffer | undefined;
  try {
    candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
    secretDigest = secret.useBytes((bytes) =>
      createHash("sha256").update(bytes).digest(),
    );
    return timingSafeEqual(candidateDigest, secretDigest);
  } catch {
    return false;
  } finally {
    candidateDigest?.fill(0);
    secretDigest?.fill(0);
  }
}

function normalizeOptionalPath(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  if (path.length === 0 || path.trim() !== path) {
    throw new CredentialConfigurationError("Credential file source is invalid");
  }
  return path;
}

function isCredentialUtf8WithinLimit(value: string): boolean {
  if (value.length > CREDENTIAL_MAX_BYTES) {
    return false;
  }
  return Buffer.byteLength(value, "utf8") <= CREDENTIAL_MAX_BYTES;
}

function assertCredentialByteLength(byteLength: number): void {
  if (byteLength > CREDENTIAL_MAX_BYTES) {
    throw new CredentialConfigurationError(CREDENTIAL_TOO_LARGE_MESSAGE);
  }
}

function stripOneTerminalLineEnding(bytes: Uint8Array): Uint8Array {
  let end = bytes.byteLength;
  if (end > 0 && bytes[end - 1] === 0x0a) {
    end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d) {
      end -= 1;
    }
  }
  return bytes.slice(0, end);
}

function readProtectedCredentialFile(path: string): Uint8Array {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw new CredentialConfigurationError(
      "Current-user credential ownership checks are unavailable",
    );
  }

  let before: Stats;
  try {
    before = lstatSync(path);
  } catch {
    throw new CredentialConfigurationError(PROTECTED_CREDENTIAL_FILE_MESSAGE);
  }
  validateCredentialFileMetadata(
    {
      uid: before.uid,
      mode: before.mode,
      isFile: before.isFile(),
      isSymbolicLink: before.isSymbolicLink(),
    },
    currentUid,
  );
  assertCredentialByteLength(before.size);

  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new CredentialConfigurationError(PROTECTED_CREDENTIAL_FILE_MESSAGE);
  }

  let bytes: Uint8Array | undefined;
  let failure: CredentialConfigurationError | undefined;
  try {
    const opened = fstatSync(descriptor);
    validateCredentialFileMetadata(
      {
        uid: opened.uid,
        mode: opened.mode,
        isFile: opened.isFile(),
        isSymbolicLink: false,
      },
      currentUid,
    );
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new CredentialConfigurationError(
        "Credential file changed while opening",
      );
    }
    assertCredentialByteLength(opened.size);

    bytes = readBoundedCredentialBytes(descriptor);

    const afterRead = fstatSync(descriptor);
    validateCredentialFileMetadata(
      {
        uid: afterRead.uid,
        mode: afterRead.mode,
        isFile: afterRead.isFile(),
        isSymbolicLink: false,
      },
      currentUid,
    );
    assertCredentialByteLength(afterRead.size);
  } catch (error) {
    failure =
      error instanceof CredentialConfigurationError
        ? error
        : new CredentialConfigurationError(PROTECTED_CREDENTIAL_FILE_MESSAGE);
  }

  try {
    closeSync(descriptor);
  } catch {
    failure ??= new CredentialConfigurationError(
      PROTECTED_CREDENTIAL_FILE_MESSAGE,
    );
  }

  if (failure !== undefined) {
    bytes?.fill(0);
    throw failure;
  }
  if (bytes === undefined) {
    throw new CredentialConfigurationError(PROTECTED_CREDENTIAL_FILE_MESSAGE);
  }
  return bytes;
}

function readBoundedCredentialBytes(descriptor: number): Uint8Array {
  const staging = Buffer.allocUnsafe(CREDENTIAL_MAX_BYTES + 1);
  try {
    let bytesRead = 0;
    while (bytesRead < staging.byteLength) {
      const read = readSync(
        descriptor,
        staging,
        bytesRead,
        staging.byteLength - bytesRead,
        null,
      );
      if (read === 0) {
        break;
      }
      bytesRead += read;
    }
    assertCredentialByteLength(bytesRead);
    return Uint8Array.from(staging.subarray(0, bytesRead));
  } finally {
    staging.fill(0);
  }
}

function normalizeRequestAuthority(authority: string): string {
  if (authority.trim() !== authority || authority.length === 0) {
    return "";
  }
  return authority.toLowerCase();
}

function normalizeRequestOrigin(origin: string): string {
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return "";
    }
    return parsed.origin.toLowerCase();
  } catch {
    return "";
  }
}

const processCredentialAccess: CredentialAccess = Object.freeze({
  readEnvironment(name: string): string | undefined {
    return process.env[name];
  },
  deleteEnvironment(name: string): void {
    delete process.env[name];
  },
  readProtectedFile: readProtectedCredentialFile,
});
