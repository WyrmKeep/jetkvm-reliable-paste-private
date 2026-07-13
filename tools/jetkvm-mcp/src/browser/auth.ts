import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { inspect } from "node:util";
import type { LegacySseSecurityPolicy } from "../config.js";

const REDACTED = "[REDACTED]";
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;

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

  static fromUtf8(value: string): DisposableSecret {
    return DisposableSecret.fromBytes(Buffer.from(value, "utf8"));
  }

  static fromBytes(value: Uint8Array): DisposableSecret {
    if (value.byteLength === 0) {
      throw new CredentialConfigurationError("Credential is empty");
    }
    return new DisposableSecret(Uint8Array.from(value));
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
    return this.useBytes((bytes) =>
      consumer(Buffer.from(bytes).toString("utf8")),
    );
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
    access.deleteEnvironment(source.environmentVariable);
    return secret;
  }

  if (source.filePath === undefined) {
    throw new CredentialConfigurationError("Credential is not available");
  }

  const bytes = (access.readProtectedFile ?? readProtectedCredentialFile)(
    source.filePath,
  );
  const normalized = stripOneTerminalLineEnding(bytes);
  try {
    return DisposableSecret.fromBytes(normalized);
  } finally {
    normalized.fill(0);
    if (bytes !== normalized) {
      bytes.fill(0);
    }
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
    throw new CredentialConfigurationError(
      "Credential source must be a protected regular file",
    );
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
  try {
    const candidateDigest = createHash("sha256")
      .update(candidate, "utf8")
      .digest();
    const secretDigest = secret.useBytes((bytes) =>
      createHash("sha256").update(bytes).digest(),
    );
    return timingSafeEqual(candidateDigest, secretDigest);
  } catch {
    return false;
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

  const before = lstatSync(path);
  validateCredentialFileMetadata(
    {
      uid: before.uid,
      mode: before.mode,
      isFile: before.isFile(),
      isSymbolicLink: before.isSymbolicLink(),
    },
    currentUid,
  );

  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new CredentialConfigurationError(
      "Credential source must be a protected regular file",
    );
  }

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
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
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
