import { isIP } from "node:net";
import {
  selectCredentialSource,
  type CredentialSourceSelection,
} from "./browser/auth.js";

const DEFAULT_CREDENTIAL_ENVIRONMENT_VARIABLE = "JETKVM_CREDENTIAL";
const DEFAULT_SSE_BEARER_ENVIRONMENT_VARIABLE = "JETKVM_MCP_BEARER";
const DEFAULT_SSE_BIND_HOST = "127.0.0.1";
const DEFAULT_SSE_HOST_AUTHORITY = "127.0.0.1";
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
  readonly bindHost?: string;
  readonly hostAuthorities?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly allowNetworkExposure?: boolean;
  readonly bearerCredentialFile?: string;
  readonly bearerEnvironmentVariable?: string;
}

export interface OperatorConfigInput {
  readonly targetUrl?: string;
  readonly allowInsecureHttp?: boolean;
  readonly credentialFile?: string;
  readonly credentialEnvironmentVariable?: string;
  readonly legacySse?: LegacySseConfigInput;
}

export interface OperatorConfigEnvironment {
  readonly JETKVM_TARGET_URL?: string;
  readonly JETKVM_ALLOW_INSECURE_HTTP?: string;
  readonly JETKVM_CREDENTIAL_FILE?: string;
  readonly JETKVM_CREDENTIAL_ENV?: string;
}

export interface LegacySseSecurityPolicy {
  readonly enabled: boolean;
  readonly bindHost: string;
  readonly hostAuthorities: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly rejectMissingOrigin: boolean;
  readonly requiresBearer: boolean;
  readonly requiresAntiCsrf: boolean;
  readonly bearerCredential: Readonly<CredentialSourceSelection> | null;
  readonly networkExposed: boolean;
}

export interface OperatorConfig {
  readonly targetUrl: string;
  readonly allowInsecureHttp: boolean;
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
  validateTargetUrl(targetUrl, allowInsecureHttp);

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

  return Object.freeze({
    targetUrl,
    allowInsecureHttp,
    credential,
    legacySse,
  });
}

export function parseLegacySsePolicy(
  input: LegacySseConfigInput = {},
): Readonly<LegacySseSecurityPolicy> {
  const enabled = input.enabled ?? false;
  const bindHost = normalizeBindHost(input.bindHost ?? DEFAULT_SSE_BIND_HOST);
  const networkExposed = !isLoopbackHost(bindHost);

  if (networkExposed && input.allowNetworkExposure !== true) {
    throw new OperatorConfigError(
      "Non-loopback legacy SSE requires explicit network exposure",
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

  return Object.freeze({
    enabled,
    bindHost,
    hostAuthorities,
    allowedOrigins,
    rejectMissingOrigin: networkExposed,
    requiresBearer: bearerCredential !== null || networkExposed,
    requiresAntiCsrf: networkExposed,
    bearerCredential,
    networkExposed,
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
}

function normalizeBindHost(host: string): string {
  if (host.length === 0 || host.trim() !== host || /[/:?#@]/u.test(host)) {
    if (host !== "::" && host !== "::1") {
      throw new OperatorConfigError("Legacy SSE bind host is invalid");
    }
  }
  return host.toLowerCase();
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
    authority.includes("*") ||
    authority.includes("/") ||
    authority.includes("@")
  ) {
    throw new OperatorConfigError("Legacy SSE Host authority is invalid");
  }

  try {
    const parsed = new URL(`http://${authority}`);
    if (parsed.hostname.length === 0 || parsed.pathname !== "/") {
      throw new Error("invalid");
    }
  } catch {
    throw new OperatorConfigError("Legacy SSE Host authority is invalid");
  }
  return authority.toLowerCase();
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
