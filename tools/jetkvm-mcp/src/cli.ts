import { readFile } from "node:fs/promises";
import type { Server as NodeServer } from "node:http";

import {
  parseOperatorConfig,
  type OperatorConfig,
  type OperatorConfigEnvironment,
  type OperatorConfigInput,
} from "./config.js";
import {
  loadDeviceLeaseProofReference,
} from "./deviceLease.js";
import { runDeviceLeaseCli } from "./deviceLeaseRunner.js";
import { LegacySseAdapter } from "./mcp/legacySse.js";
import { startStdioServer } from "./mcp/stdio.js";
import { createStructuredLogger } from "./observability/logger.js";
import {
  configuredDeviceFingerprint,
  createProductionRuntime,
  type ProductionRuntime,
} from "./runtime.js";
import { assertSupportedNodeVersion } from "./runtimePolicy.js";

const LEASE_PROOF_ENV = "JETKVM_DEVICE_LEASE_PROOF_PATH";
const DEFAULT_SSE_PORT = 3_000;

export interface CliDependencies {
  readonly createRuntime?: (config: OperatorConfig) => ProductionRuntime;
  readonly startStdio?: typeof startStdioServer;
  readonly runLease?: typeof runDeviceLeaseCli;
  readonly loadLeaseProof?: typeof loadDeviceLeaseProofReference;
  readonly waitForSignal?: () => Promise<NodeJS.Signals>;
  readonly entryPath?: string;
}

interface ParsedCli {
  readonly config: OperatorConfig;
  readonly transport: "stdio" | "sse";
  readonly port: number;
  readonly tlsCertificateFile?: string;
  readonly tlsKeyFile?: string;
  readonly childArgs: readonly string[];
  readonly explicitlyLeased: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readConfigFile(path: string): Promise<OperatorConfigInput> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Configuration must be a JSON object.");
  return parsed as OperatorConfigInput;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("SSE port must be an integer from 0 through 65535.");
  }
  return parsed;
}

function takeValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires one value.`);
  }
  return value;
}

async function parseCli(
  rawArgs: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ParsedCli> {
  let configPath: string | undefined;
  let targetUrl: string | undefined;
  let credentialFile: string | undefined;
  let credentialEnvironmentVariable: string | undefined;
  let allowInsecureHttp: boolean | undefined;
  let allowDangerousTargetHttp: boolean | undefined;
  let transport: "stdio" | "sse" = "stdio";
  let port = DEFAULT_SSE_PORT;
  let tlsCertificateFile: string | undefined;
  let tlsKeyFile: string | undefined;
  let explicitlyLeased = false;
  const childArgs: string[] = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const flag = rawArgs[index];
    if (flag === "--leased") {
      explicitlyLeased = true;
      continue;
    }
    childArgs.push(flag ?? "");
    if (flag === "--allow-insecure-http") {
      allowInsecureHttp = true;
      continue;
    }
    if (flag === "--allow-dangerous-target-http") {
      allowDangerousTargetHttp = true;
      continue;
    }
    const value = takeValue(rawArgs, index, flag ?? "argument");
    childArgs.push(value);
    index += 1;
    switch (flag) {
      case "--config":
        configPath = value;
        break;
      case "--target-url":
        targetUrl = value;
        break;
      case "--credential-file":
        credentialFile = value;
        break;
      case "--credential-env":
        credentialEnvironmentVariable = value;
        break;
      case "--transport":
        if (value !== "stdio" && value !== "sse") {
          throw new Error("Transport must be stdio or sse.");
        }
        transport = value;
        break;
      case "--port":
        port = parsePort(value);
        break;
      case "--tls-cert-file":
        tlsCertificateFile = value;
        break;
      case "--tls-key-file":
        tlsKeyFile = value;
        break;
      default:
        throw new Error("Unknown command-line option.");
    }
  }

  const fileInput =
    configPath === undefined ? {} : await readConfigFile(configPath);
  const input: OperatorConfigInput = {
    ...fileInput,
    ...(targetUrl === undefined ? {} : { targetUrl }),
    ...(credentialFile === undefined ? {} : { credentialFile }),
    ...(credentialEnvironmentVariable === undefined
      ? {}
      : { credentialEnvironmentVariable }),
    ...(allowInsecureHttp === undefined ? {} : { allowInsecureHttp }),
    ...(allowDangerousTargetHttp === undefined
      ? {}
      : { allowDangerousTargetHttp }),
  };
  const config = parseOperatorConfig(
    input,
    environment as OperatorConfigEnvironment,
  );
  if (transport === "sse" && !config.legacySse.enabled) {
    throw new Error("SSE transport requires legacySse.enabled configuration.");
  }
  if (
    transport === "sse" &&
    config.legacySse.scheme === "https" &&
    (tlsCertificateFile === undefined || tlsKeyFile === undefined)
  ) {
    throw new Error("HTTPS SSE requires certificate and key files.");
  }
  return {
    config,
    transport,
    port,
    ...(tlsCertificateFile === undefined ? {} : { tlsCertificateFile }),
    ...(tlsKeyFile === undefined ? {} : { tlsKeyFile }),
    childArgs,
    explicitlyLeased,
  };
}

function defaultSignalWaiter(): Promise<NodeJS.Signals> {
  const completion = Promise.withResolvers<NodeJS.Signals>();
  const onSigint = () => completion.resolve("SIGINT");
  const onSigterm = () => completion.resolve("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  void completion.promise.finally(() => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  });
  return completion.promise;
}

async function closeNodeServer(server: NodeServer): Promise<void> {
  if (!server.listening) return;
  const completion = Promise.withResolvers<void>();
  server.close((error) => {
    if (error === undefined) completion.resolve();
    else completion.reject(error);
  });
  await completion.promise;
}

async function listen(server: NodeServer, port: number, host: string): Promise<void> {
  const completion = Promise.withResolvers<void>();
  const onError = (error: Error) => completion.reject(error);
  server.once("error", onError);
  server.once("listening", completion.resolve);
  server.listen(port, host);
  try {
    await completion.promise;
  } finally {
    server.off("error", onError);
  }
}

async function runTransport(
  parsed: ParsedCli,
  dependencies: CliDependencies,
): Promise<number> {
  const runtime = (dependencies.createRuntime ?? createProductionRuntime)(
    parsed.config,
  );
  try {
    if (parsed.transport === "stdio") {
      const handle = await (dependencies.startStdio ?? startStdioServer)(
        runtime.handlers,
      );
      await Promise.race([
        handle.closed,
        (dependencies.waitForSignal ?? defaultSignalWaiter)().then(() =>
          handle.close(),
        ),
      ]);
      await handle.close();
      return 0;
    }

    const policy = parsed.config.legacySse;
    const bearer =
      policy.bearerCredential === null
        ? undefined
        : runtime.activateLegacySseBearer(policy.bearerCredential);
    const adapter = new LegacySseAdapter({
      handlerRegistry: runtime.handlers,
      securityPolicy: policy,
      ...(bearer === undefined ? {} : { bearerCredential: bearer }),
    });
    let server: NodeServer | undefined;
    try {
      if (policy.scheme === "http") {
        server = adapter.createHttpServer();
      } else {
        const [cert, key] = await Promise.all([
          readFile(parsed.tlsCertificateFile as string),
          readFile(parsed.tlsKeyFile as string),
        ]);
        server = adapter.createHttpsServer({ cert, key });
      }
      await listen(server, parsed.port, policy.bindHost);
      await (dependencies.waitForSignal ?? defaultSignalWaiter)();
      return 0;
    } finally {
      if (server !== undefined) await closeNodeServer(server);
      await adapter.close();
      bearer?.secret.dispose();
    }
  } finally {
    await runtime.close();
  }
}

export async function runJetKvmMcpCli(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const logger = createStructuredLogger();
  try {
    assertSupportedNodeVersion();
    const parsed = await parseCli(args, environment);
    const inheritedProofPath = environment[LEASE_PROOF_ENV];
    if (parsed.explicitlyLeased && !inheritedProofPath) {
      throw new Error("Internal leased startup lacks a lease proof.");
    }
    if (!parsed.explicitlyLeased && inheritedProofPath) {
      throw new Error(
        "An inherited lease proof is accepted only in internal leased startup.",
      );
    }
    if (inheritedProofPath) {
      await (dependencies.loadLeaseProof ?? loadDeviceLeaseProofReference)(
        inheritedProofPath,
        configuredDeviceFingerprint(parsed.config.targetUrl),
      );
      return await runTransport(parsed, dependencies);
    }
    const entryPath = dependencies.entryPath ?? process.argv[1];
    if (entryPath === undefined || entryPath.length === 0) {
      throw new Error("Executable entry path is unavailable.");
    }
    return await (dependencies.runLease ?? runDeviceLeaseCli)(
      [
        "--device-key",
        configuredDeviceFingerprint(parsed.config.targetUrl),
        "--",
        process.execPath,
        entryPath,
        "--leased",
        ...parsed.childArgs,
      ],
      environment,
    );
  } catch (error) {
    logger.error("startup_failed", { error });
    return 1;
  }
}

