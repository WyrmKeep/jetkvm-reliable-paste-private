import { isIP } from "node:net";
import { resolve } from "node:path";
import {
  selectCredentialSource,
  type CredentialSourceSelection,
} from "./browser/auth.js";

const DEFAULT_CREDENTIAL_ENVIRONMENT_VARIABLE = "JETKVM_CREDENTIAL";
const DEFAULT_SSE_BEARER_ENVIRONMENT_VARIABLE = "JETKVM_MCP_BEARER";
const DEFAULT_SSE_BIND_HOST = "127.0.0.1";
const DEFAULT_SSE_HOST_AUTHORITY = "127.0.0.1";
const DEFAULT_SSE_MAX_CONCURRENT_STREAMS = 64;
const DEFAULT_SSE_MAX_CONCURRENT_STREAMS_PER_PRINCIPAL = 8;
const DEFAULT_SSE_STREAM_OPEN_RATE_LIMIT = 120;
const DEFAULT_SSE_STREAM_OPEN_RATE_LIMIT_PER_PRINCIPAL = 30;
const DEFAULT_SSE_STREAM_OPEN_RATE_WINDOW_MS = 60_000;
const DEFAULT_SSE_MAX_CONCURRENT_POSTS = 64;
const DEFAULT_SSE_MAX_CONCURRENT_POSTS_PER_PRINCIPAL = 16;
const DEFAULT_SSE_MAX_CONCURRENT_POSTS_PER_SESSION = 4;
const DEFAULT_SSE_POST_RATE_LIMIT = 600;
const DEFAULT_SSE_POST_RATE_LIMIT_PER_PRINCIPAL = 120;
const DEFAULT_SSE_POST_RATE_LIMIT_PER_SESSION = 60;
const DEFAULT_SSE_POST_RATE_WINDOW_MS = 60_000;
const SSE_CONNECTION_RESERVE = 32;
const DEFAULT_SSE_SESSION_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_SSE_REQUEST_BODY_IDLE_TIMEOUT_MS = 5_000;
const DEFAULT_SSE_REQUEST_HEADER_TIMEOUT_MS = 10_000;
const DEFAULT_SSE_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_SSE_REQUEST_BODY_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_SSE_MAX_RESPONSE_MESSAGE_BYTES = 12_582_912;
const DEFAULT_SSE_MAX_RESPONSE_BUFFERED_BYTES = 16_777_216;
const DEFAULT_SSE_RESPONSE_BACKPRESSURE_TIMEOUT_MS = 5_000;
const MAX_SSE_CONCURRENT_STREAMS = 1_024;
const MAX_SSE_CONCURRENT_POSTS = 1_024;
const MAX_SSE_STREAM_OPEN_RATE_LIMIT = 10_000;
const MAX_SSE_POST_RATE_LIMIT = 10_000;
const MAX_SSE_STREAM_OPEN_RATE_WINDOW_MS = 3_600_000;
const MAX_SSE_POST_RATE_WINDOW_MS = 3_600_000;
const MAX_SSE_SESSION_IDLE_TIMEOUT_MS = 3_600_000;
const MAX_SSE_REQUEST_BODY_IDLE_TIMEOUT_MS = 60_000;
const MAX_SSE_REQUEST_BODY_TOTAL_TIMEOUT_MS = 120_000;
const MAX_SSE_REQUEST_HEADER_TIMEOUT_MS = 60_000;
const MAX_SSE_KEEP_ALIVE_TIMEOUT_MS = 60_000;
const MAX_SSE_RESPONSE_MESSAGE_BYTES = 16_777_216;
const MAX_SSE_RESPONSE_BUFFERED_BYTES = 16_777_216;
const MAX_SSE_RESPONSE_BACKPRESSURE_TIMEOUT_MS = 60_000;
const FORBIDDEN_PUBLIC_FIELD_NAMES: Readonly<Record<string, true>> = {
  auth: true,
  authentication: true,
  authorization: true,
  bearer: true,
  bearertoken: true,
  cookie: true,
  credential: true,
  credentials: true,
  deviceurl: true,
  password: true,
  secret: true,
  target: true,
  targeturl: true,
  token: true,
  url: true,
  uri: true,
};

export interface LegacySseConfigInput {
  readonly enabled?: boolean;
  readonly scheme?: "https" | "http";
  readonly bindHost?: string;
  readonly hostAuthorities?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly allowNetworkExposure?: boolean;
  readonly allowPlaintextHttp?: boolean;
  readonly allowDangerousNetworkPlaintext?: boolean;
  readonly bearerCredentialFile?: string;
  readonly bearerEnvironmentVariable?: string;
  readonly maxConcurrentStreams?: number;
  readonly maxConcurrentStreamsPerPrincipal?: number;
  readonly streamOpenRateLimit?: number;
  readonly streamOpenRateLimitPerPrincipal?: number;
  readonly streamOpenRateWindowMs?: number;
  readonly maxConcurrentPosts?: number;
  readonly maxConcurrentPostsPerPrincipal?: number;
  readonly maxConcurrentPostsPerSession?: number;
  readonly postRateLimit?: number;
  readonly postRateLimitPerPrincipal?: number;
  readonly postRateLimitPerSession?: number;
  readonly postRateWindowMs?: number;
  readonly sessionIdleTimeoutMs?: number;
  readonly requestBodyIdleTimeoutMs?: number;
  readonly requestHeaderTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
  readonly requestBodyTotalTimeoutMs?: number;
  readonly maxResponseMessageBytes?: number;
  readonly maxResponseBufferedBytes?: number;
  readonly responseBackpressureTimeoutMs?: number;
}

export interface OperatorConfigInput {
  readonly targetUrl?: string;
  readonly allowInsecureHttp?: boolean;
  readonly allowDangerousTargetHttp?: boolean;
  readonly credentialFile?: string;
  readonly credentialEnvironmentVariable?: string;
  readonly legacySse?: LegacySseConfigInput;
}

export interface OperatorConfigEnvironment {
  readonly JETKVM_TARGET_URL?: string;
  readonly JETKVM_ALLOW_INSECURE_HTTP?: string;
  readonly JETKVM_ALLOW_DANGEROUS_TARGET_HTTP?: string;
  readonly JETKVM_CREDENTIAL_FILE?: string;
  readonly JETKVM_CREDENTIAL_ENV?: string;
}

export interface LegacySseSecurityPolicy {
  readonly enabled: boolean;
  readonly scheme: "https" | "http";
  readonly bindHost: string;
  readonly hostAuthorities: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly rejectMissingOrigin: boolean;
  readonly requiresBearer: boolean;
  readonly requiresAntiCsrf: boolean;
  readonly bearerCredential: Readonly<CredentialSourceSelection> | null;
  readonly networkExposed: boolean;
  readonly maxConcurrentStreams: number;
  readonly maxConcurrentStreamsPerPrincipal: number;
  readonly streamOpenRateLimit: number;
  readonly streamOpenRateLimitPerPrincipal: number;
  readonly streamOpenRateWindowMs: number;
  readonly maxConcurrentPosts: number;
  readonly maxConcurrentPostsPerPrincipal: number;
  readonly maxConcurrentPostsPerSession: number;
  readonly postRateLimit: number;
  readonly postRateLimitPerPrincipal: number;
  readonly postRateLimitPerSession: number;
  readonly postRateWindowMs: number;
  readonly maxConnections: number;
  readonly sessionIdleTimeoutMs: number;
  readonly requestBodyIdleTimeoutMs: number;
  readonly requestHeaderTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly requestBodyTotalTimeoutMs: number;
  readonly maxResponseMessageBytes: number;
  readonly maxResponseBufferedBytes: number;
  readonly responseBackpressureTimeoutMs: number;
}

export interface OperatorConfig {
  readonly targetUrl: string;
  readonly allowInsecureHttp: boolean;
  readonly allowDangerousTargetHttp: boolean;
  readonly credential: Readonly<CredentialSourceSelection>;
  readonly legacySse: Readonly<LegacySseSecurityPolicy>;
}

export class OperatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorConfigError";
  }
}

export function parseOperatorConfig(
  input: OperatorConfigInput,
  environment: OperatorConfigEnvironment = {},
): Readonly<OperatorConfig> {
  const targetUrl = input.targetUrl ?? environment.JETKVM_TARGET_URL;
  if (targetUrl === undefined || targetUrl.length === 0) {
    throw new OperatorConfigError("A JetKVM target URL is required");
  }

  const allowInsecureHttp =
    input.allowInsecureHttp ??
    parseOptionalBoolean(
      environment.JETKVM_ALLOW_INSECURE_HTTP,
      "JETKVM_ALLOW_INSECURE_HTTP",
    ) ??
    false;
  const allowDangerousTargetHttp =
    input.allowDangerousTargetHttp ??
    parseOptionalBoolean(
      environment.JETKVM_ALLOW_DANGEROUS_TARGET_HTTP,
      "JETKVM_ALLOW_DANGEROUS_TARGET_HTTP",
    ) ??
    false;
  validateTargetUrl(targetUrl, allowInsecureHttp, allowDangerousTargetHttp);
  const credential = selectCredentialSource({
    ...(input.credentialFile === undefined
      ? {}
      : { cliFilePath: input.credentialFile }),
    ...(environment.JETKVM_CREDENTIAL_FILE === undefined
      ? {}
      : { environmentFilePath: environment.JETKVM_CREDENTIAL_FILE }),
    environmentVariable:
      input.credentialEnvironmentVariable ??
      environment.JETKVM_CREDENTIAL_ENV ??
      DEFAULT_CREDENTIAL_ENVIRONMENT_VARIABLE,
  });
  const legacySse = parseLegacySsePolicy(input.legacySse);
  if (
    legacySse.bearerCredential !== null &&
    credentialSourcesShareIdentity(credential, legacySse.bearerCredential)
  ) {
    throw new OperatorConfigError(
      "Target and legacy SSE credential sources must be independent",
    );
  }

  return Object.freeze({
    targetUrl,
    allowInsecureHttp,
    allowDangerousTargetHttp,
    credential,
    legacySse,
  });
}

export function parseLegacySsePolicy(
  input: LegacySseConfigInput = {},
): Readonly<LegacySseSecurityPolicy> {
  const enabled = input.enabled ?? false;
  const scheme = input.scheme ?? "https";
  if (scheme !== "https" && scheme !== "http") {
    throw new OperatorConfigError("Legacy SSE listener scheme is invalid");
  }
  const bindHost = normalizeBindHost(input.bindHost ?? DEFAULT_SSE_BIND_HOST);
  const networkExposed = !isLoopbackHost(bindHost);

  if (networkExposed && input.allowNetworkExposure !== true) {
    throw new OperatorConfigError(
      "Non-loopback legacy SSE requires explicit network exposure",
    );
  }

  if (scheme === "http" && input.allowPlaintextHttp !== true) {
    throw new OperatorConfigError(
      "Plain HTTP legacy SSE requires explicit insecure opt-in",
    );
  }
  if (
    scheme === "http" &&
    networkExposed &&
    input.allowDangerousNetworkPlaintext !== true
  ) {
    throw new OperatorConfigError(
      "Non-loopback plain HTTP legacy SSE requires explicit dangerous-network opt-in",
    );
  }

  if (networkExposed && input.hostAuthorities === undefined) {
    throw new OperatorConfigError(
      "Non-loopback legacy SSE requires exact Host authorities",
    );
  }
  const hostAuthorities = Object.freeze(
    (input.hostAuthorities ?? [DEFAULT_SSE_HOST_AUTHORITY]).map(
      normalizeHostAuthority,
    ),
  );
  if (hostAuthorities.length === 0) {
    throw new OperatorConfigError(
      "Legacy SSE requires at least one exact Host authority",
    );
  }

  if (networkExposed && input.allowedOrigins === undefined) {
    throw new OperatorConfigError(
      "Non-loopback legacy SSE requires an exact Origin allowlist",
    );
  }
  const allowedOrigins = Object.freeze(
    (input.allowedOrigins ?? []).map(normalizeOrigin),
  );
  if (networkExposed && allowedOrigins.length === 0) {
    throw new OperatorConfigError(
      "Non-loopback legacy SSE requires an exact Origin allowlist",
    );
  }

  const bearerConfigured =
    input.bearerCredentialFile !== undefined ||
    input.bearerEnvironmentVariable !== undefined;
  if (networkExposed && !bearerConfigured) {
    throw new OperatorConfigError(
      "Non-loopback legacy SSE requires an independent bearer credential",
    );
  }
  const bearerCredential = bearerConfigured
    ? selectCredentialSource({
        ...(input.bearerCredentialFile === undefined
          ? {}
          : { cliFilePath: input.bearerCredentialFile }),
        environmentVariable:
          input.bearerEnvironmentVariable ??
          DEFAULT_SSE_BEARER_ENVIRONMENT_VARIABLE,
      })
    : null;

  const maxConcurrentStreams = positiveSafeInteger(
    input.maxConcurrentStreams,
    DEFAULT_SSE_MAX_CONCURRENT_STREAMS,
    MAX_SSE_CONCURRENT_STREAMS,
    "Legacy SSE maximum concurrent streams",
  );
  const maxConcurrentStreamsPerPrincipal = positiveSafeInteger(
    input.maxConcurrentStreamsPerPrincipal,
    DEFAULT_SSE_MAX_CONCURRENT_STREAMS_PER_PRINCIPAL,
    MAX_SSE_CONCURRENT_STREAMS,
    "Legacy SSE per-principal maximum concurrent streams",
  );
  if (maxConcurrentStreamsPerPrincipal > maxConcurrentStreams) {
    throw new OperatorConfigError(
      "Legacy SSE per-principal concurrency cannot exceed the global limit",
    );
  }
  const streamOpenRateLimit = positiveSafeInteger(
    input.streamOpenRateLimit,
    DEFAULT_SSE_STREAM_OPEN_RATE_LIMIT,
    MAX_SSE_STREAM_OPEN_RATE_LIMIT,
    "Legacy SSE stream opening rate limit",
  );
  const streamOpenRateLimitPerPrincipal = positiveSafeInteger(
    input.streamOpenRateLimitPerPrincipal,
    DEFAULT_SSE_STREAM_OPEN_RATE_LIMIT_PER_PRINCIPAL,
    MAX_SSE_STREAM_OPEN_RATE_LIMIT,
    "Legacy SSE per-principal stream opening rate limit",
  );
  if (streamOpenRateLimitPerPrincipal > streamOpenRateLimit) {
    throw new OperatorConfigError(
      "Legacy SSE per-principal rate cannot exceed the global limit",
    );
  }
  const streamOpenRateWindowMs = positiveSafeInteger(
    input.streamOpenRateWindowMs,
    DEFAULT_SSE_STREAM_OPEN_RATE_WINDOW_MS,
    MAX_SSE_STREAM_OPEN_RATE_WINDOW_MS,
    "Legacy SSE stream opening rate window",
  );
  const maxConcurrentPosts = positiveSafeInteger(
    input.maxConcurrentPosts,
    DEFAULT_SSE_MAX_CONCURRENT_POSTS,
    MAX_SSE_CONCURRENT_POSTS,
    "Legacy SSE maximum concurrent POST requests",
  );
  const maxConcurrentPostsPerPrincipal = positiveSafeInteger(
    input.maxConcurrentPostsPerPrincipal,
    DEFAULT_SSE_MAX_CONCURRENT_POSTS_PER_PRINCIPAL,
    MAX_SSE_CONCURRENT_POSTS,
    "Legacy SSE per-principal maximum concurrent POST requests",
  );
  if (maxConcurrentPostsPerPrincipal > maxConcurrentPosts) {
    throw new OperatorConfigError(
      "Legacy SSE per-principal POST concurrency cannot exceed the global limit",
    );
  }
  const maxConcurrentPostsPerSession = positiveSafeInteger(
    input.maxConcurrentPostsPerSession,
    DEFAULT_SSE_MAX_CONCURRENT_POSTS_PER_SESSION,
    MAX_SSE_CONCURRENT_POSTS,
    "Legacy SSE per-session maximum concurrent POST requests",
  );
  if (maxConcurrentPostsPerSession > maxConcurrentPosts) {
    throw new OperatorConfigError(
      "Legacy SSE per-session POST concurrency cannot exceed the global limit",
    );
  }
  const postRateLimit = positiveSafeInteger(
    input.postRateLimit,
    DEFAULT_SSE_POST_RATE_LIMIT,
    MAX_SSE_POST_RATE_LIMIT,
    "Legacy SSE POST rate limit",
  );
  const postRateLimitPerPrincipal = positiveSafeInteger(
    input.postRateLimitPerPrincipal,
    DEFAULT_SSE_POST_RATE_LIMIT_PER_PRINCIPAL,
    MAX_SSE_POST_RATE_LIMIT,
    "Legacy SSE per-principal POST rate limit",
  );
  if (postRateLimitPerPrincipal > postRateLimit) {
    throw new OperatorConfigError(
      "Legacy SSE per-principal POST rate cannot exceed the global limit",
    );
  }
  const postRateLimitPerSession = positiveSafeInteger(
    input.postRateLimitPerSession,
    DEFAULT_SSE_POST_RATE_LIMIT_PER_SESSION,
    MAX_SSE_POST_RATE_LIMIT,
    "Legacy SSE per-session POST rate limit",
  );
  if (postRateLimitPerSession > postRateLimit) {
    throw new OperatorConfigError(
      "Legacy SSE per-session POST rate cannot exceed the global limit",
    );
  }
  const postRateWindowMs = positiveSafeInteger(
    input.postRateWindowMs,
    DEFAULT_SSE_POST_RATE_WINDOW_MS,
    MAX_SSE_POST_RATE_WINDOW_MS,
    "Legacy SSE POST rate window",
  );
  const maxConnections =
    maxConcurrentStreams + maxConcurrentPosts + SSE_CONNECTION_RESERVE;
  const sessionIdleTimeoutMs = positiveSafeInteger(
    input.sessionIdleTimeoutMs,
    DEFAULT_SSE_SESSION_IDLE_TIMEOUT_MS,
    MAX_SSE_SESSION_IDLE_TIMEOUT_MS,
    "Legacy SSE session idle timeout",
  );
  const requestHeaderTimeoutMs = positiveSafeInteger(
    input.requestHeaderTimeoutMs,
    DEFAULT_SSE_REQUEST_HEADER_TIMEOUT_MS,
    MAX_SSE_REQUEST_HEADER_TIMEOUT_MS,
    "Legacy SSE request header timeout",
  );
  const keepAliveTimeoutMs = positiveSafeInteger(
    input.keepAliveTimeoutMs,
    DEFAULT_SSE_KEEP_ALIVE_TIMEOUT_MS,
    MAX_SSE_KEEP_ALIVE_TIMEOUT_MS,
    "Legacy SSE keep-alive timeout",
  );
  const requestBodyIdleTimeoutMs = positiveSafeInteger(
    input.requestBodyIdleTimeoutMs,
    DEFAULT_SSE_REQUEST_BODY_IDLE_TIMEOUT_MS,
    MAX_SSE_REQUEST_BODY_IDLE_TIMEOUT_MS,
    "Legacy SSE request body idle timeout",
  );
  const requestBodyTotalTimeoutMs = positiveSafeInteger(
    input.requestBodyTotalTimeoutMs,
    DEFAULT_SSE_REQUEST_BODY_TOTAL_TIMEOUT_MS,
    MAX_SSE_REQUEST_BODY_TOTAL_TIMEOUT_MS,
    "Legacy SSE request body total timeout",
  );
  if (requestHeaderTimeoutMs > requestBodyTotalTimeoutMs) {
    throw new OperatorConfigError(
      "Legacy SSE request header timeout cannot exceed its total timeout",
    );
  }
  if (requestBodyIdleTimeoutMs > requestBodyTotalTimeoutMs) {
    throw new OperatorConfigError(
      "Legacy SSE request body idle timeout cannot exceed its total timeout",
    );
  }
  const maxResponseMessageBytes = positiveSafeInteger(
    input.maxResponseMessageBytes,
    DEFAULT_SSE_MAX_RESPONSE_MESSAGE_BYTES,
    MAX_SSE_RESPONSE_MESSAGE_BYTES,
    "Legacy SSE maximum serialized response message",
  );
  const maxResponseBufferedBytes = positiveSafeInteger(
    input.maxResponseBufferedBytes,
    DEFAULT_SSE_MAX_RESPONSE_BUFFERED_BYTES,
    MAX_SSE_RESPONSE_BUFFERED_BYTES,
    "Legacy SSE maximum response buffer",
  );
  if (maxResponseMessageBytes > maxResponseBufferedBytes) {
    throw new OperatorConfigError(
      "Legacy SSE maximum response message cannot exceed the response buffer",
    );
  }
  const responseBackpressureTimeoutMs = positiveSafeInteger(
    input.responseBackpressureTimeoutMs,
    DEFAULT_SSE_RESPONSE_BACKPRESSURE_TIMEOUT_MS,
    MAX_SSE_RESPONSE_BACKPRESSURE_TIMEOUT_MS,
    "Legacy SSE response backpressure timeout",
  );

  return Object.freeze({
    enabled,
    scheme,
    bindHost,
    hostAuthorities,
    allowedOrigins,
    rejectMissingOrigin: networkExposed,
    requiresBearer: bearerCredential !== null || networkExposed,
    requiresAntiCsrf: networkExposed,
    bearerCredential,
    networkExposed,
    maxConcurrentStreams,
    maxConcurrentStreamsPerPrincipal,
    streamOpenRateLimit,
    streamOpenRateLimitPerPrincipal,
    streamOpenRateWindowMs,
    maxConcurrentPosts,
    maxConcurrentPostsPerPrincipal,
    maxConcurrentPostsPerSession,
    postRateLimit,
    postRateLimitPerPrincipal,
    postRateLimitPerSession,
    postRateWindowMs,
    maxConnections,
    sessionIdleTimeoutMs,
    requestBodyIdleTimeoutMs,
    requestBodyTotalTimeoutMs,
    maxResponseMessageBytes,
    maxResponseBufferedBytes,
    requestHeaderTimeoutMs,
    keepAliveTimeoutMs,
    responseBackpressureTimeoutMs,
  });
}

export function assertPublicContractContainsNoOperatorSecrets(
  value: unknown,
): void {
  const visited = new Set<object>();

  function visit(current: unknown): void {
    if (current === null || typeof current !== "object") {
      return;
    }
    if (visited.has(current)) {
      return;
    }
    visited.add(current);

    for (const [key, nested] of Object.entries(current)) {
      const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
      if (FORBIDDEN_PUBLIC_FIELD_NAMES[normalized] === true) {
        throw new OperatorConfigError(
          "Public MCP contract contains an operator-only field",
        );
      }
      visit(nested);
    }
  }

  visit(value);
}

function validateTargetUrl(
  targetUrl: string,
  allowInsecureHttp: boolean,
  allowDangerousTargetHttp: boolean,
): void {
  if (targetUrl.trim() !== targetUrl) {
    throw new OperatorConfigError("Invalid JetKVM target URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new OperatorConfigError("Invalid JetKVM target URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new OperatorConfigError("Unsafe JetKVM target URL scheme");
  }
  if (parsed.hostname.length === 0) {
    throw new OperatorConfigError("Invalid JetKVM target URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new OperatorConfigError(
      "JetKVM target URL must not contain credentials",
    );
  }
  if (parsed.hash !== "") {
    throw new OperatorConfigError(
      "JetKVM target URL must not contain a fragment",
    );
  }
  if (parsed.search !== "") {
    throw new OperatorConfigError("JetKVM target URL must not contain a query");
  }
  if (parsed.protocol === "http:" && !allowInsecureHttp) {
    throw new OperatorConfigError(
      "Plain HTTP target requires explicit insecure opt-in",
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLoopbackHost(parsed.hostname.replace(/^\[|\]$/gu, "")) &&
    !allowDangerousTargetHttp
  ) {
    throw new OperatorConfigError(
      "Non-loopback plain HTTP target requires explicit dangerous-network opt-in",
    );
  }
}

function normalizeBindHost(host: string): string {
  if (host.length === 0 || host.trim() !== host) {
    throw new OperatorConfigError("Legacy SSE bind host is invalid");
  }
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || isIP(normalized) === 4) return normalized;
  if (isIP(normalized) === 6) {
    return new URL(`http://[${normalized}]`).hostname.slice(1, -1);
  }
  throw new OperatorConfigError("Legacy SSE bind host is invalid");
}

function isLoopbackHost(host: string): boolean {
  const addressFamily = isIP(host);
  if (addressFamily === 4) {
    const firstOctet = Number.parseInt(host.split(".")[0] ?? "", 10);
    return firstOctet === 127;
  }
  if (addressFamily === 6) {
    return host === "::1";
  }
  return host === "localhost";
}

function normalizeHostAuthority(authority: string): string {
  if (
    authority.length === 0 ||
    authority.trim() !== authority ||
    authority !== authority.toLowerCase() ||
    /[*\/@?#]/u.test(authority)
  ) {
    throw new OperatorConfigError("Legacy SSE Host authority is invalid");
  }

  try {
    const parsed = new URL(`http://${authority}`);
    if (
      parsed.hostname.length === 0 ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.host !== authority
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new OperatorConfigError("Legacy SSE Host authority is invalid");
  }
  return authority;
}

function normalizeOrigin(origin: string): string {
  if (origin.includes("*")) {
    throw new OperatorConfigError("Legacy SSE Origin is invalid");
  }
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("invalid");
    }
    return parsed.origin.toLowerCase();
  } catch {
    throw new OperatorConfigError("Legacy SSE Origin is invalid");
  }
}

function positiveSafeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new OperatorConfigError(
      `${name} must be a positive integer no greater than ${maximum}`,
    );
  }
  return resolved;
}

function credentialSourcesShareIdentity(
  target: CredentialSourceSelection,
  bearer: CredentialSourceSelection,
): boolean {
  if (target.environmentVariable === bearer.environmentVariable) return true;
  return (
    target.filePath !== undefined &&
    bearer.filePath !== undefined &&
    resolve(target.filePath) === resolve(bearer.filePath)
  );
}

function parseOptionalBoolean(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new OperatorConfigError(`${name} must be true or false`);
}
