import { EventEmitter } from "node:events";
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Server as HttpsServer } from "node:https";
import { connect as connectTls, type TLSSocket } from "node:tls";

import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  activateIndependentLegacySseBearerCredential,
  DisposableSecret,
  type IndependentLegacySseBearerCredential,
} from "../browser/auth.js";
import {
  LEGACY_SSE_ACTIVE_REQUEST_BODY_BUDGET_BYTES,
  LEGACY_SSE_MAX_HEADER_BYTES,
  LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES,
  MCP_TRANSPORT_MAX_REQUEST_BYTES,
  parseLegacySsePolicy,
  type LegacySseConfigInput,
  type LegacySseSecurityPolicy,
} from "../config.js";
import { JETKVM_TOOL_NAMES, type JetKvmToolName } from "../domain.js";
import {
  MCP_SERVER_BUSY_ERROR_CODE,
  type HandlerRegistry,
  type JetKvmHandlerContext,
  type JetKvmToolHandler,
} from "./server.js";
import {
  TOOL_BEHAVIOR_MATRIX,
  validateFocusedAssertionExecutions,
  type FocusedAssertionExecutionResult,
} from "../stories/manifest.js";
import {
  installBoundedSseWriter,
  LegacySseAdapter,
  type LegacySseAdapterOptions,
} from "./legacySse.js";

const AUTHORITY = "mcp.example.test";
const ORIGIN = "https://client.example.test";
const TOKEN = "test-only-bearer";
const PRINCIPAL = "operator-a";
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgZYQkNHZkAo6HBAxJ
qQkC+TFfas0/7683rr1wLHtdqVuhRANCAASoum/7fiyE/orVK+S3a7/l9h8V29nE
Cm+WCt0dQUvJfQkxrP/Pb4tFVHEAaitJYxfWm3lRr5dO4sB3nIVa60Ki
-----END PRIVATE KEY-----`;
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIUO+y0ClMJahI0IWgIdKfp/+YwtWwwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcxMzA3MjIyNFoXDTM2MDcxMDA3
MjIyNFowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEqLpv+34shP6K1Svkt2u/5fYfFdvZxApvlgrdHUFLyX0JMaz/z2+LRVRx
AGorSWMX1pt5Ua+XTuLAd5yFWutCoqNTMFEwHQYDVR0OBBYEFOeGEQz+TFlFiPH/
1pqbHZv6X/foMB8GA1UdIwQYMBaAFOeGEQz+TFlFiPH/1pqbHZv6X/foMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhANjMfCoov2tr20D5kozHjQq5
MIeO9vc+mVHzieR6JvTKAiBN/gGEbx2pv4EH9jI5wto2gF8AOMvqBirAyPmZg6w1
Zg==
-----END CERTIFICATE-----`;

function businessError(
  tool: JetKvmToolName,
  operationId = "operation-sse",
): CallToolResult {
  const isRead =
    tool === "jetkvm_display_capture" ||
    tool === "jetkvm_display_status" ||
    tool === "jetkvm_session_status";
  const payload = {
    ok: false as const,
    tool,
    operation_id: operationId,
    session_id: null,
    session_generation: null,
    duration_ms: 0,
    error: {
      code: "CONFIG_INVALID" as const,
      message: "deterministic SSE result",
      phase: "validate" as const,
      outcome: isRead ? null : ("not_sent" as const),
      verification: "none" as const,
      safe_to_retry: false,
      required_next_step: "none" as const,
      details: {
        permission: null,
        capability: null,
        failed_action_index: null,
        dispatched_action_count: null,
        completed_action_count: null,
        downstream_stage: "none" as const,
        expected_generation: null,
        actual_generation: null,
        observation_id: null,
      },
    },
  };
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function completeRegistry(
  override?: Partial<Record<JetKvmToolName, JetKvmToolHandler>>,
): HandlerRegistry {
  return {
    ...Object.fromEntries(
      JETKVM_TOOL_NAMES.map((name) => [name, async () => businessError(name)]),
    ),
    ...override,
  } as HandlerRegistry;
}

interface RunningAdapter {
  readonly adapter: LegacySseAdapter;
  readonly server: Server;
  readonly baseUrl: string;
  readonly targetSecret: DisposableSecret;
  readonly credential: IndependentLegacySseBearerCredential;
}

interface OpenSse {
  readonly response: IncomingMessage;
  readonly endpoint: string;
  readonly firstFrame: string;
  readonly nextFrame: () => Promise<string>;
}

const running: RunningAdapter[] = [];

function authorizedHeaders(principalToken = TOKEN): Record<string, string> {
  return {
    Host: AUTHORITY,
    Origin: ORIGIN,
    Authorization: `Bearer ${principalToken}`,
    "X-JetKVM-CSRF": "1",
  };
}

interface StartAdapterOptions extends Partial<LegacySseAdapterOptions> {
  readonly policy?: LegacySseConfigInput;
  readonly listenHost?: string;
}

async function startAdapter(
  options: StartAdapterOptions = {},
): Promise<RunningAdapter> {
  const targetSecret = DisposableSecret.fromUtf8("test-only-target");
  const credential = activateIndependentLegacySseBearerCredential(
    targetSecret,
    {
      principalId: PRINCIPAL,
      secret: DisposableSecret.fromUtf8(TOKEN),
    },
  );
  const {
    policy: policyOverride = {},
    listenHost,
    ...adapterOptions
  } = options;
  const policy = parseLegacySsePolicy({
    enabled: true,
    scheme: "http",
    bindHost: "0.0.0.0",
    allowNetworkExposure: true,
    allowPlaintextHttp: true,
    allowDangerousNetworkPlaintext: true,
    hostAuthorities: [AUTHORITY],
    allowedOrigins: [ORIGIN],
    bearerEnvironmentVariable: "JETKVM_TEST_SSE_BEARER",
    ...policyOverride,
  });
  const adapter = new LegacySseAdapter({
    handlerRegistry: completeRegistry(),
    securityPolicy: policy,
    bearerCredential: credential,
    ...adapterOptions,
  });
  const server = adapter.createHttpServer();
  const listening = Promise.withResolvers<void>();
  server.once("listening", listening.resolve);
  server.listen(0, listenHost ?? policy.bindHost);
  await listening.promise;
  const address = server.address() as AddressInfo;
  const value = {
    adapter,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    credential,
    targetSecret,
  };
  running.push(value);
  return value;
}

async function closeRunning(value: RunningAdapter): Promise<void> {
  await value.adapter.close();
  value.targetSecret.dispose();
  value.credential.secret.dispose();
  if (!value.server.listening) return;
  const closed = Promise.withResolvers<void>();
  value.server.close(() => closed.resolve());
  await closed.promise;
}

function frameReader(response: IncomingMessage): () => Promise<string> {
  response.setEncoding("utf8");
  let buffer = "";
  const queued: string[] = [];
  const waiters: Array<(frame: string) => void> = [];
  response.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = `${buffer.slice(0, boundary)}\n\n`;
      buffer = buffer.slice(boundary + 2);
      const resolve = waiters.shift();
      if (resolve) resolve(frame);
      else queued.push(frame);
    }
  });
  return async () => {
    const frame = queued.shift();
    if (frame !== undefined) return frame;
    const pending = Promise.withResolvers<string>();
    waiters.push(pending.resolve);
    return pending.promise;
  };
}

async function openSse(
  baseUrl: string,
  headers: Record<string, string> = authorizedHeaders(),
): Promise<OpenSse> {
  const responseReady = Promise.withResolvers<IncomingMessage>();
  const request = httpRequest(`${baseUrl}/sse`, { method: "GET", headers });
  request.once("response", responseReady.resolve);
  request.once("error", responseReady.reject);
  request.end();
  const response = await responseReady.promise;
  const nextFrame = frameReader(response);
  const firstFrame = await nextFrame();
  const match =
    /^event: endpoint\ndata: (\/messages\?sessionId=[0-9a-f-]+)\n\n$/.exec(
      firstFrame,
    );
  if (!match?.[1]) throw new Error(`Unexpected endpoint frame: ${firstFrame}`);
  return { response, endpoint: match[1], firstFrame, nextFrame };
}

interface TestHttpResponse {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  text(): Promise<string>;
}

interface TestHttpRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
}

async function testFetch(
  input: string,
  init: TestHttpRequestInit = {},
): Promise<TestHttpResponse> {
  const url = new URL(input);
  const responseReady = Promise.withResolvers<IncomingMessage>();
  const body = init.body ?? "";
  const headers = {
    ...init.headers,
    ...(body.length === 0 ||
    init.headers?.["Content-Length"] !== undefined ||
    init.headers?.["Transfer-Encoding"] !== undefined
      ? {}
      : { "Content-Length": String(Buffer.byteLength(body)) }),
  };
  const request = httpRequest({
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers,
  });
  request.once("response", responseReady.resolve);
  request.once("error", responseReady.reject);
  request.end(body);
  const response = await responseReady.promise;
  response.setEncoding("utf8");
  let responseBody = "";
  for await (const chunk of response) responseBody += chunk;
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    text: async () => responseBody,
  };
}

async function post(
  baseUrl: string,
  endpoint: string,
  body: string,
  headers: Record<string, string> = authorizedHeaders(),
): Promise<TestHttpResponse> {
  return testFetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body,
  });
}

interface PendingPost {
  readonly request: ClientRequest;
  readonly response: Promise<TestHttpResponse>;
}

function beginPendingPost(
  baseUrl: string,
  endpoint: string,
  headers: Record<string, string> = authorizedHeaders(),
): PendingPost {
  const url = new URL(`${baseUrl}${endpoint}`);
  const responseReady = Promise.withResolvers<IncomingMessage>();
  const request = httpRequest({
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
  });
  request.once("response", responseReady.resolve);
  request.once("error", responseReady.reject);
  request.write("{");
  const response = responseReady.promise.then(async (incoming) => {
    incoming.setEncoding("utf8");
    let body = "";
    for await (const chunk of incoming) body += chunk;
    return {
      status: incoming.statusCode ?? 0,
      headers: incoming.headers,
      text: async () => body,
    };
  });
  return { request, response };
}

async function listenOnLoopback(server: Server | HttpsServer): Promise<number> {
  const listening = Promise.withResolvers<void>();
  server.once("listening", listening.resolve);
  server.listen(0, "127.0.0.1");
  await listening.promise;
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server | HttpsServer): Promise<void> {
  if (!server.listening) return;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
}

async function connectRaw(port: number): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port });
  const connected = Promise.withResolvers<void>();
  socket.once("connect", connected.resolve);
  socket.once("error", connected.reject);
  await connected.promise;
  return socket;
}

async function waitForSocketClose(
  socket: Socket,
  timeoutMs: number,
): Promise<string> {
  const completed = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  // These integration checks exercise Node's real parser/TLS construction timers.
  const timer = setTimeout(() => {
    socket.destroy();
    completed.reject(new Error(`Socket remained open after ${timeoutMs}ms`));
  }, timeoutMs);
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.once("error", () => undefined);
  socket.once("close", () => {
    clearTimeout(timer);
    completed.resolve(Buffer.concat(chunks).toString("utf8"));
  });
  return completed.promise;
}
function replaceNextMcpServerClose(close: () => Promise<void>): void {
  const connect = McpSdkServer.prototype.connect;
  vi.spyOn(McpSdkServer.prototype, "connect").mockImplementationOnce(
    async function (
      this: McpSdkServer,
      transport: Parameters<McpSdkServer["connect"]>[0],
    ): Promise<void> {
      await connect.call(this, transport);
      this.close = close;
    },
  );
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map(closeRunning));
});

describe("legacy SSE adapter", () => {
  it.each([
    [
      "partial",
      {
        jetkvm_session_connect: vi.fn(async () =>
          businessError("jetkvm_session_connect"),
        ),
      },
    ],
    ["unknown", { unknown_tool: vi.fn() }],
  ] as const)(
    "rejects a %s handler registry synchronously before transport state",
    (_case, handlerRegistry) => {
      const targetSecret = DisposableSecret.fromUtf8("registry-target");
      const credential = activateIndependentLegacySseBearerCredential(
        targetSecret,
        {
          principalId: PRINCIPAL,
          secret: DisposableSecret.fromUtf8("registry-bearer"),
        },
      );
      const transportFactory = vi.fn(
        (
          endpoint: string,
          response: ConstructorParameters<typeof SSEServerTransport>[1],
        ) => new SSEServerTransport(endpoint, response),
      );
      try {
        expect(
          () =>
            new LegacySseAdapter({
              handlerRegistry: handlerRegistry as HandlerRegistry,
              securityPolicy: parseLegacySsePolicy({
                enabled: true,
                scheme: "http",
                bindHost: "127.0.0.1",
                allowPlaintextHttp: true,
                hostAuthorities: [AUTHORITY],
                bearerEnvironmentVariable: "JETKVM_TEST_SSE_BEARER",
              }),
              bearerCredential: credential,
              transportFactory,
            }),
        ).toThrowError(/handler registry/i);
        expect(transportFactory).not.toHaveBeenCalled();
      } finally {
        credential.secret.dispose();
        targetSecret.dispose();
      }
    },
  );

  it("rejects a hand-built security policy before any server can be created", () => {
    const parsed = parseLegacySsePolicy();
    const forged = {
      ...parsed,
      enabled: true,
      scheme: "http",
      bindHost: "0.0.0.0",
      networkExposed: true,
      hostAuthorities: [],
      allowedOrigins: [],
      rejectMissingOrigin: false,
      requiresBearer: false,
      requiresAntiCsrf: false,
      bearerCredential: null,
    } as LegacySseSecurityPolicy;

    expect(() => new LegacySseAdapter({ securityPolicy: forged })).toThrowError(
      /parseLegacySsePolicy/i,
    );
  });

  it.each([
    ["http", undefined, "missing"],
    ["http", "Bearer invalid", "invalid"],
    ["https", undefined, "missing"],
    ["https", "Bearer invalid", "invalid"],
  ] as const)(
    "does not let injected authentication bypass the activated bearer over raw %s (%s)",
    async (scheme, authorization, _case) => {
      const targetSecret = DisposableSecret.fromUtf8("bypass-target");
      const credential = activateIndependentLegacySseBearerCredential(
        targetSecret,
        {
          principalId: PRINCIPAL,
          secret: DisposableSecret.fromUtf8(TOKEN),
        },
      );
      const authenticateBearer = vi.fn(() => ({ principalId: PRINCIPAL }));
      const policy = parseLegacySsePolicy({
        enabled: true,
        scheme,
        bindHost: "0.0.0.0",
        allowNetworkExposure: true,
        hostAuthorities: [AUTHORITY],
        allowedOrigins: [ORIGIN],
        bearerEnvironmentVariable: "JETKVM_TEST_SSE_BEARER",
        ...(scheme === "http"
          ? {
              allowPlaintextHttp: true,
              allowDangerousNetworkPlaintext: true,
            }
          : {}),
      });
      const adapter = new LegacySseAdapter({
        handlerRegistry: completeRegistry(),
        securityPolicy: policy,
        bearerCredential: credential,
        authenticateBearer,
      });
      const server =
        scheme === "http"
          ? adapter.createHttpServer()
          : adapter.createHttpsServer({
              key: TEST_TLS_KEY,
              cert: TEST_TLS_CERT,
            });
      const listening = Promise.withResolvers<void>();
      server.once("listening", listening.resolve);
      server.listen(0, policy.bindHost);
      await listening.promise;
      const port = (server.address() as AddressInfo).port;
      let socket: Socket | undefined;

      try {
        if (scheme === "http") {
          socket = await connectRaw(port);
        } else {
          const tlsSocket = connectTls({
            host: "127.0.0.1",
            port,
            rejectUnauthorized: false,
          });
          const secured = Promise.withResolvers<void>();
          tlsSocket.once("secureConnect", secured.resolve);
          tlsSocket.once("error", secured.reject);
          await secured.promise;
          socket = tlsSocket;
        }
        socket.write(
          [
            "POST /messages?sessionId=00000000-0000-4000-8000-000000000000 HTTP/1.1",
            `Host: ${AUTHORITY}`,
            `Origin: ${ORIGIN}`,
            "X-JetKVM-CSRF: 1",
            ...(authorization === undefined
              ? []
              : [`Authorization: ${authorization}`]),
            "Content-Type: application/json",
            "Content-Length: 2",
            "Connection: close",
            "",
            "{}",
          ].join("\r\n"),
        );

        const response = await waitForSocketClose(socket, 500);
        expect(response).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
        expect(response.endsWith("Unauthorized")).toBe(true);
        expect(authenticateBearer).not.toHaveBeenCalled();
      } finally {
        socket?.destroy();
        await adapter.close();
        await closeServer(server);
        credential.secret.dispose();
        targetSecret.dispose();
      }
    },
  );
  it.each([
    ["GET", "/sse", undefined, "missing"],
    ["GET", "/sse", "Bearer invalid", "invalid"],
    [
      "POST",
      "/messages?sessionId=00000000-0000-4000-8000-000000000000",
      undefined,
      "missing",
    ],
    [
      "POST",
      "/messages?sessionId=00000000-0000-4000-8000-000000000000",
      "Bearer invalid",
      "invalid",
    ],
  ] as const)(
    "returns 401 before %s allocation or lookup when authentication is missing or invalid",
    async (method, path, authorization, _case) => {
      const transportFactory = vi.fn(
        (
          endpoint: string,
          response: ConstructorParameters<typeof SSEServerTransport>[1],
        ) => new SSEServerTransport(endpoint, response),
      );
      const { baseUrl } = await startAdapter({ transportFactory });

      const response = await testFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Host: AUTHORITY,
          Origin: ORIGIN,
          "X-JetKVM-CSRF": "1",
          ...(authorization === undefined
            ? {}
            : { Authorization: authorization }),
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });

      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
      expect(transportFactory).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["GET", false, 401, "Unauthorized"],
    ["POST", false, 401, "Unauthorized"],
    ["GET", true, 403, "Forbidden"],
    ["POST", true, 403, "Forbidden"],
  ] as const)(
    "classifies a missing Host in authenticated middleware for %s auth=%s",
    async (method, authenticated, status, body) => {
      const { baseUrl } = await startAdapter();
      const port = Number(new URL(baseUrl).port);
      const path =
        method === "GET"
          ? "/sse"
          : "/messages?sessionId=00000000-0000-4000-8000-000000000000";
      const socket = await connectRaw(port);
      socket.write(
        [
          `${method} ${path} HTTP/1.1`,
          `Origin: ${ORIGIN}`,
          "X-JetKVM-CSRF: 1",
          ...(authenticated ? [`Authorization: Bearer ${TOKEN}`] : []),
          ...(method === "POST"
            ? ["Content-Type: application/json", "Content-Length: 0"]
            : []),
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );

      const response = await waitForSocketClose(socket, 500);
      expect(response).toMatch(
        new RegExp(`^HTTP/1\\.1 ${status} ${body}\\r\\n`),
      );
      expect(response.endsWith(body)).toBe(true);
    },
  );

  it.each(["http", "https"] as const)(
    "admits Expect requests through security before interim bytes over %s",
    async (scheme) => {
      const targetSecret = DisposableSecret.fromUtf8("expect-target");
      const credential = activateIndependentLegacySseBearerCredential(
        targetSecret,
        {
          principalId: PRINCIPAL,
          secret: DisposableSecret.fromUtf8(TOKEN),
        },
      );
      const policy = parseLegacySsePolicy({
        enabled: true,
        scheme,
        bindHost: "127.0.0.1",
        hostAuthorities: [AUTHORITY],
        allowedOrigins: [ORIGIN],
        bearerEnvironmentVariable: "JETKVM_TEST_SSE_BEARER",
        ...(scheme === "http"
          ? {
              allowPlaintextHttp: true,
            }
          : {}),
      });
      const adapter = new LegacySseAdapter({
        handlerRegistry: completeRegistry(),
        securityPolicy: policy,
        bearerCredential: credential,
      });
      const server =
        scheme === "http"
          ? adapter.createHttpServer()
          : adapter.createHttpsServer({
              key: TEST_TLS_KEY,
              cert: TEST_TLS_CERT,
            });
      const port = await listenOnLoopback(server);
      let owner: Socket | undefined;

      const connectClient = async (): Promise<Socket> => {
        if (scheme === "http") return connectRaw(port);
        const socket = connectTls({
          host: "127.0.0.1",
          port,
          rejectUnauthorized: false,
        });
        const secured = Promise.withResolvers<void>();
        socket.once("secureConnect", secured.resolve);
        socket.once("error", secured.reject);
        await secured.promise;
        return socket;
      };

      try {
        owner = await connectClient();
        let ownerWire = "";
        owner.on("data", (chunk: Buffer) => {
          ownerWire += chunk.toString("utf8");
        });
        owner.write(
          [
            "GET /sse HTTP/1.1",
            ...Object.entries(authorizedHeaders()).map(
              ([name, value]) => `${name}: ${value}`,
            ),
            "Connection: keep-alive",
            "",
            "",
          ].join("\r\n"),
        );
        await vi.waitFor(
          () => {
            expect(ownerWire).toContain("event: endpoint");
          },
          { interval: 5, timeout: 500 },
        );
        const endpoint = ownerWire.match(
          /data: (\/messages\?sessionId=[^\r\n]+)/,
        )?.[1];
        expect(endpoint).toBeDefined();

        const body = JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        const issue = async (
          method: "GET" | "POST",
          expectation: "100-continue" | "unsupported-expectation",
          identity: "missing" | "forbidden" | "valid",
        ): Promise<string> => {
          const socket = await connectClient();
          let observed = "";
          socket.on("data", (chunk: Buffer) => {
            observed += chunk.toString("utf8");
          });
          const closed = waitForSocketClose(socket, 1_000);
          socket.write(
            [
              `${method} ${method === "GET" ? "/sse" : endpoint} HTTP/1.1`,
              `Host: ${
                identity === "forbidden" ? "attacker.example.test" : AUTHORITY
              }`,
              `Origin: ${ORIGIN}`,
              "X-JetKVM-CSRF: 1",
              ...(identity === "missing"
                ? []
                : [`Authorization: Bearer ${TOKEN}`]),
              `Expect: ${expectation}`,
              ...(method === "POST"
                ? [
                    "Content-Type: application/json",
                    `Content-Length: ${Buffer.byteLength(body)}`,
                  ]
                : []),
              "Connection: close",
              "",
              "",
            ].join("\r\n"),
          );

          if (
            identity === "valid" &&
            expectation === "100-continue" &&
            method === "POST"
          ) {
            await vi.waitFor(
              () => {
                expect(observed).toContain("HTTP/1.1 100 Continue\r\n\r\n");
              },
              { interval: 5, timeout: 500 },
            );
            socket.write(body);
          } else if (
            identity === "valid" &&
            expectation === "100-continue" &&
            method === "GET"
          ) {
            await vi.waitFor(
              () => {
                expect(observed).toContain("event: endpoint");
              },
              { interval: 5, timeout: 500 },
            );
            socket.destroy();
          }
          return closed;
        };

        for (const method of ["GET", "POST"] as const) {
          for (const expectation of [
            "100-continue",
            "unsupported-expectation",
          ] as const) {
            const missing = await issue(method, expectation, "missing");
            expect(missing).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
            expect(missing).not.toContain("HTTP/1.1 100 Continue");

            const forbidden = await issue(method, expectation, "forbidden");
            expect(forbidden).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
            expect(forbidden).not.toContain("HTTP/1.1 100 Continue");

            const accepted = await issue(method, expectation, "valid");
            if (expectation === "unsupported-expectation") {
              expect(accepted).toMatch(
                /^HTTP\/1\.1 417 Expectation Failed\r\n/,
              );
              expect(accepted.endsWith("Expectation Failed")).toBe(true);
              expect(accepted).not.toContain("HTTP/1.1 100 Continue");
            } else if (method === "GET") {
              expect(accepted).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
              expect(accepted).toContain("event: endpoint");
              expect(accepted).not.toContain("HTTP/1.1 100 Continue");
            } else {
              expect(accepted.match(/HTTP\/1\.1 100 Continue/g)).toHaveLength(
                1,
              );
              expect(accepted).toContain("\r\n\r\nHTTP/1.1 202 Accepted\r\n");
            }
          }
        }

        const getWithBody = await connectClient();
        const getWithBodyClosed = waitForSocketClose(getWithBody, 500);
        getWithBody.write(
          [
            "GET /sse HTTP/1.1",
            ...Object.entries(authorizedHeaders()).map(
              ([name, value]) => `${name}: ${value}`,
            ),
            "Expect: 100-continue",
            "Content-Length: 2",
            "Connection: close",
            "",
            "",
          ].join("\r\n"),
        );
        const rejectedGetBody = await getWithBodyClosed;
        expect(rejectedGetBody).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
        expect(rejectedGetBody.endsWith("Request body not allowed")).toBe(true);
        expect(rejectedGetBody).not.toContain("HTTP/1.1 100 Continue");
      } finally {
        owner?.destroy();
        await adapter.close();
        await closeServer(server);
        credential.secret.dispose();
        targetSecret.dispose();
      }
    },
  );

  it("counts each Expect event once against the global route ceiling", async () => {
    const value = await startAdapter({
      policy: { routeAttemptRateLimit: 2 },
    });
    const port = Number(new URL(value.baseUrl).port);
    const path = "/messages?sessionId=00000000-0000-4000-8000-000000000000";
    const exchange = async (
      expectation: string,
      authenticated: boolean,
    ): Promise<string> => {
      const socket = await connectRaw(port);
      const closed = waitForSocketClose(socket, 500);
      socket.write(
        [
          `POST ${path} HTTP/1.1`,
          `Host: ${AUTHORITY}`,
          `Origin: ${ORIGIN}`,
          "X-JetKVM-CSRF: 1",
          ...(authenticated ? [`Authorization: Bearer ${TOKEN}`] : []),
          `Expect: ${expectation}`,
          "Content-Type: application/json",
          "Content-Length: 2",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
      return closed;
    };

    const unauthenticated = await exchange("100-continue", false);
    expect(unauthenticated).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
    expect(unauthenticated).not.toContain("HTTP/1.1 100 Continue");
    expect(await exchange("unsupported-expectation", true)).toMatch(
      /^HTTP\/1\.1 417 Expectation Failed\r\n/,
    );
    const limited = await exchange("100-continue", true);
    expect(limited).toMatch(/^HTTP\/1\.1 429 Too Many Requests\r\n/);
    expect(limited).not.toContain("HTTP/1.1 100 Continue");
  });

  it.each([
    ["Host", "hOsT", "attacker.example.test"],
    ["Origin", "oRiGiN", "https://attacker.example.test"],
    ["Authorization", "aUtHoRiZaTiOn", "Bearer attacker"],
    ["X-JetKVM-CSRF", "x-JeTkVm-CsRf", "0"],
  ] as const)(
    "rejects duplicate %s raw headers before authentication or allocation",
    async (_name, duplicateName, duplicateValue) => {
      const authenticateBearer = vi.fn((authorization: string | undefined) => {
        if (authorization !== `Bearer ${TOKEN}`) {
          throw new Error("invalid bearer");
        }
        return { principalId: PRINCIPAL };
      });
      const transportFactory = vi.fn(() => {
        throw new Error("duplicate header reached allocation");
      });
      const { baseUrl } = await startAdapter({
        authenticateBearer,
        transportFactory,
      });
      const socket = await connectRaw(Number(new URL(baseUrl).port));
      socket.write(
        [
          "GET /sse HTTP/1.1",
          `Host: ${AUTHORITY}`,
          `Origin: ${ORIGIN}`,
          `Authorization: Bearer ${TOKEN}`,
          "X-JetKVM-CSRF: 1",
          `${duplicateName}: ${duplicateValue}`,
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"),
      );

      const response = await waitForSocketClose(socket, 500);
      expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
      expect(authenticateBearer).not.toHaveBeenCalled();
      expect(transportFactory).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "Transfer-Encoding",
      "GET",
      "/unknown",
      ["Transfer-Encoding: gzip", "tRaNsFeR-EnCoDiNg: chunked"],
      "1\r\n{\r\n",
    ],
    [
      "Content-Length",
      "POST",
      "/messages?sessionId=00000000-0000-4000-8000-000000000001",
      [
        "Content-Type: application/json",
        "Content-Length: 100",
        "cOnTeNt-LeNgTh: 101",
      ],
      "{",
    ],
    [
      "Content-Type",
      "POST",
      "/messages?sessionId=00000000-0000-4000-8000-000000000001",
      [
        "Content-Type: application/json",
        "cOnTeNt-TyPe: text/plain",
        "Content-Length: 100",
      ],
      "{",
    ],
  ] as const)(
    "rejects ambiguous duplicate %s framing before routing or authentication",
    async (_name, method, path, framingHeaders, body) => {
      const authenticateBearer = vi.fn(() => ({ principalId: PRINCIPAL }));
      const { baseUrl } = await startAdapter({ authenticateBearer });
      const socket = await connectRaw(Number(new URL(baseUrl).port));
      socket.write(
        [
          `${method} ${path} HTTP/1.1`,
          `Host: ${AUTHORITY}`,
          `Origin: ${ORIGIN}`,
          `Authorization: Bearer ${TOKEN}`,
          "X-JetKVM-CSRF: 1",
          ...framingHeaders,
          "Connection: keep-alive",
          "",
          body,
        ].join("\r\n"),
      );

      const response = await waitForSocketClose(socket, 500);
      expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
      expect(response.toLowerCase()).toContain("\r\nconnection: close\r\n");
      expect(authenticateBearer).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["GET", "/sse", { Host: "attacker.example.test" }, "Host"],
    ["GET", "/sse", { Origin: "https://attacker.example.test" }, "Origin"],
    ["GET", "/sse", { "X-JetKVM-CSRF": "0" }, "anti-CSRF"],
    [
      "POST",
      "/messages?sessionId=00000000-0000-4000-8000-000000000000",
      { Host: "attacker.example.test" },
      "Host",
    ],
    [
      "POST",
      "/messages?sessionId=00000000-0000-4000-8000-000000000000",
      { Origin: "https://attacker.example.test" },
      "Origin",
    ],
    [
      "POST",
      "/messages?sessionId=00000000-0000-4000-8000-000000000000",
      { "X-JetKVM-CSRF": "0" },
      "anti-CSRF",
    ],
  ] as const)(
    "returns 403 before %s allocation or lookup for forbidden Host/Origin/CSRF policy",
    async (method, path, forbiddenHeader, _case) => {
      const transportFactory = vi.fn(
        (
          endpoint: string,
          response: ConstructorParameters<typeof SSEServerTransport>[1],
        ) => new SSEServerTransport(endpoint, response),
      );
      const { baseUrl } = await startAdapter({ transportFactory });

      const response = await testFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...authorizedHeaders(),
          ...forbiddenHeader,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden");
      expect(transportFactory).not.toHaveBeenCalled();
    },
  );

  it("opens exact SDK endpoint framing and required SSE headers", async () => {
    const { baseUrl } = await startAdapter();

    const stream = await openSse(baseUrl);

    expect(stream.response.statusCode).toBe(200);
    expect(stream.response.headers["content-type"]).toBe("text/event-stream");
    expect(stream.response.headers["cache-control"]).toBe(
      "no-cache, no-transform",
    );
    expect(stream.response.headers.connection).toBe("keep-alive");
    expect(stream.firstFrame).toBe(
      `event: endpoint\ndata: ${stream.endpoint}\n\n`,
    );
    stream.response.destroy();
  });

  it("keeps malformed/missing routing separate from safe indistinguishable 404 cases", async () => {
    const streamClosed = Promise.withResolvers<void>();
    const { baseUrl } = await startAdapter({
      policy: { bindHost: "127.0.0.1" },
      authenticateBearer: (authorization) => ({
        principalId:
          authorization === "Bearer other-token" ? "operator-b" : PRINCIPAL,
      }),
      onDiagnostic: (event) => {
        if (event.code === "transport_closed") streamClosed.resolve();
      },
    });
    const stream = await openSse(baseUrl);

    for (const endpoint of [
      "/messages",
      "/messages?sessionId=bad id",
      "/messages?sessionId=00000000-0000-0000-0000-000000000000&sessionId=duplicate",
    ]) {
      const response = await post(baseUrl, endpoint, "{}");
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Bad Request");
    }

    const unknown = await post(
      baseUrl,
      "/messages?sessionId=00000000-0000-4000-8000-000000000000",
      "{}",
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("Not Found");

    const crossPrincipal = await post(
      baseUrl,
      stream.endpoint,
      "{}",
      authorizedHeaders("other-token"),
    );
    expect(crossPrincipal.status).toBe(404);
    expect(await crossPrincipal.text()).toBe("Not Found");

    stream.response.destroy();
    await streamClosed.promise;
    const closed = await post(baseUrl, stream.endpoint, "{}");
    expect(closed.status).toBe(404);
    expect(await closed.text()).toBe("Not Found");
  });

  it("forwards only app-owned principal/correlation context to handlers", async () => {
    const observedContext = Promise.withResolvers<JetKvmHandlerContext>();
    const handler = vi.fn(
      async (_input: unknown, context: JetKvmHandlerContext) => {
        observedContext.resolve(context);
        return businessError("jetkvm_session_connect", "auth-forwarded");
      },
    );
    const { baseUrl } = await startAdapter({
      handlerRegistry: completeRegistry({ jetkvm_session_connect: handler }),
    });
    const stream = await openSse(baseUrl);

    const initialized = await post(
      baseUrl,
      stream.endpoint,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "sse-test", version: "1.0.0" },
        },
      }),
    );
    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe("Accepted");
    await stream.nextFrame();

    const called = await post(
      baseUrl,
      stream.endpoint,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "jetkvm_session_connect",
          arguments: { request_id: "request-sse", timeout_ms: 100 },
        },
      }),
    );

    expect(called.status).toBe(202);
    expect(await called.text()).toBe("Accepted");
    const context = await observedContext.promise;
    expect(Object.keys(context).sort()).toEqual([
      "correlationId",
      "principalId",
      "signal",
    ]);
    expect(context.principalId).toMatch(/^principal-[a-f0-9]{64}$/);
    expect(context.correlationId).toMatch(/^mcp-[0-9a-f]{32}$/);
    expect(JSON.stringify(context)).not.toMatch(
      /authInfo|requestInfo|sessionId|authorization|bearer|csrf|test-only-bearer/i,
    );
    expect(await stream.nextFrame()).toMatch(
      /^event: message\ndata: .*"operation_id":"auth-forwarded".*\n\n$/,
    );
    stream.response.destroy();
  });

  it("aborts an in-flight SSE tool call on a cancellation notification", async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const handler = vi.fn(
      async (_input: unknown, extra: { signal: AbortSignal }) => {
        entered.resolve();
        if (!extra.signal.aborted) {
          const signalAborted = Promise.withResolvers<void>();
          extra.signal.addEventListener(
            "abort",
            () => signalAborted.resolve(),
            {
              once: true,
            },
          );
          await signalAborted.promise;
        }
        aborted.resolve();
        return businessError("jetkvm_session_connect");
      },
    );
    const { baseUrl } = await startAdapter({
      handlerRegistry: completeRegistry({ jetkvm_session_connect: handler }),
    });
    const stream = await openSse(baseUrl);

    const initialized = await post(
      baseUrl,
      stream.endpoint,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "sse-cancel-test", version: "1.0.0" },
        },
      }),
    );
    expect(initialized.status).toBe(202);
    await stream.nextFrame();

    const callAccepted = await post(
      baseUrl,
      stream.endpoint,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "jetkvm_session_connect",
          arguments: { request_id: "request-sse-cancel", timeout_ms: 60_000 },
        },
      }),
    );
    expect(callAccepted.status).toBe(202);
    await entered.promise;

    const cancelAccepted = await post(
      baseUrl,
      stream.endpoint,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "test cancellation" },
      }),
    );
    expect(cancelAccepted.status).toBe(202);
    await aborted.promise;
    expect(handler).toHaveBeenCalledOnce();
    stream.response.destroy();
  });

  it("fail-closes a duplicate pending request ID and releases its slots", async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let callIndex = 0;
    const handler = vi.fn(
      async (_input: unknown, context: { signal: AbortSignal }) => {
        const index = callIndex++;
        if (index !== 0) {
          return businessError("jetkvm_session_connect", "sequential-id-reuse");
        }
        entered.resolve();
        if (!context.signal.aborted) {
          const signalAborted = Promise.withResolvers<void>();
          context.signal.addEventListener(
            "abort",
            () => signalAborted.resolve(),
            { once: true },
          );
          await signalAborted.promise;
        }
        aborted.resolve();
        return businessError("jetkvm_session_connect");
      },
    );
    const streamClosed = Promise.withResolvers<void>();
    const { baseUrl } = await startAdapter({
      policy: {
        maxConcurrentStreams: 1,
        maxConcurrentStreamsPerPrincipal: 1,
        maxConcurrentPosts: 2,
        maxConcurrentPostsPerPrincipal: 2,
        maxConcurrentPostsPerSession: 2,
      },
      handlerRegistry: completeRegistry({ jetkvm_session_connect: handler }),
      onDiagnostic: (event) => {
        if (event.code === "transport_closed") streamClosed.resolve();
      },
    });
    const stream = await openSse(baseUrl);
    const initialized = await post(
      baseUrl,
      stream.endpoint,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "sse-duplicate-id", version: "1.0.0" },
        },
      }),
    );
    expect(initialized.status).toBe(202);
    await stream.nextFrame();
    const call = (requestId: string) =>
      post(
        baseUrl,
        stream.endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "jetkvm_session_connect",
            arguments: { request_id: requestId, timeout_ms: 60_000 },
          },
        }),
      );

    expect((await call("request-duplicate-first")).status).toBe(202);
    await entered.promise;
    expect((await call("request-duplicate-second")).status).toBe(202);
    await aborted.promise;
    const duplicateFrames = [
      await stream.nextFrame(),
      await stream.nextFrame(),
    ];
    expect(
      duplicateFrames.some((frame) =>
        frame.includes(`"code":${MCP_SERVER_BUSY_ERROR_CODE}`),
      ),
    ).toBe(true);
    expect(handler).toHaveBeenCalledOnce();

    expect((await call("request-sequential-reuse")).status).toBe(202);
    expect(await stream.nextFrame()).toContain(
      '"operation_id":"sequential-id-reuse"',
    );
    expect(handler).toHaveBeenCalledTimes(2);

    stream.response.destroy();
    await streamClosed.promise;
    const replacement = await openSse(baseUrl);
    replacement.response.destroy();
  });

  it("shares global and principal handler admission across SSE streams", async () => {
    let abortedCount = 0;
    const handler = vi.fn(
      async (_input: unknown, context: { signal: AbortSignal }) => {
        if (!context.signal.aborted) {
          const aborted = Promise.withResolvers<void>();
          context.signal.addEventListener("abort", () => aborted.resolve(), {
            once: true,
          });
          await aborted.promise;
        }
        abortedCount += 1;
        return businessError("jetkvm_display_status");
      },
    );
    const { baseUrl } = await startAdapter({
      policy: {
        bindHost: "127.0.0.1",
        maxConcurrentStreams: 12,
        maxConcurrentStreamsPerPrincipal: 6,
        streamOpenRateLimit: 30,
        streamOpenRateLimitPerPrincipal: 10,
      },
      handlerRegistry: completeRegistry({ jetkvm_display_status: handler }),
      authenticateBearer: (authorization) => ({
        principalId: authorization?.slice("Bearer ".length) ?? "missing",
      }),
    });
    const streams: OpenSse[] = [];
    const open = async (token: string): Promise<OpenSse> => {
      const stream = await openSse(baseUrl, authorizedHeaders(token));
      streams.push(stream);
      const initialized = await post(
        baseUrl,
        stream.endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 100 + streams.length,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "sse-admission", version: "1.0.0" },
          },
        }),
        authorizedHeaders(token),
      );
      expect(initialized.status).toBe(202);
      await stream.nextFrame();
      return stream;
    };
    const call = async (
      stream: OpenSse,
      token: string,
      id: number,
      sessionId: string,
    ): Promise<void> => {
      const accepted = await post(
        baseUrl,
        stream.endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "jetkvm_display_status",
            arguments: {
              session_id: sessionId,
              session_generation: 1,
              timeout_ms: 1_000,
            },
          },
        }),
        authorizedHeaders(token),
      );
      expect(accepted.status).toBe(202);
    };

    try {
      const principalA = await Promise.all(
        Array.from({ length: 5 }, () => open("handler-a")),
      );
      for (let index = 0; index < 4; index += 1) {
        await call(
          principalA[index]!,
          "handler-a",
          index + 1,
          `session-a-${index}`,
        );
      }
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(4));
      await call(principalA[4]!, "handler-a", 5, "session-a-overload");
      expect(await principalA[4]!.nextFrame()).toContain(
        `"code":${MCP_SERVER_BUSY_ERROR_CODE}`,
      );
      expect(handler).toHaveBeenCalledTimes(4);

      const principalB = await Promise.all(
        Array.from({ length: 4 }, () => open("handler-b")),
      );
      for (let index = 0; index < principalB.length; index += 1) {
        await call(
          principalB[index]!,
          "handler-b",
          index + 10,
          `session-b-${index}`,
        );
      }
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(8));

      const principalC = await open("handler-c");
      await call(principalC, "handler-c", 20, "session-c-overload");
      expect(await principalC.nextFrame()).toContain(
        `"code":${MCP_SERVER_BUSY_ERROR_CODE}`,
      );
      expect(handler).toHaveBeenCalledTimes(8);

      principalA[0]!.response.destroy();
      await vi.waitFor(() => expect(abortedCount).toBe(1));
      await call(principalC, "handler-c", 21, "session-c-retry");
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(9));
    } finally {
      for (const stream of streams) stream.response.destroy();
    }
  }, 10_000);

  it("shares session handler admission and releases it on stream close", async () => {
    let abortedCount = 0;
    const handler = vi.fn(
      async (_input: unknown, context: { signal: AbortSignal }) => {
        if (!context.signal.aborted) {
          const aborted = Promise.withResolvers<void>();
          context.signal.addEventListener("abort", () => aborted.resolve(), {
            once: true,
          });
          await aborted.promise;
        }
        abortedCount += 1;
        return businessError("jetkvm_display_status");
      },
    );
    const { baseUrl } = await startAdapter({
      handlerRegistry: completeRegistry({ jetkvm_display_status: handler }),
    });
    const streams = await Promise.all(
      Array.from({ length: 3 }, () => openSse(baseUrl)),
    );
    for (let index = 0; index < streams.length; index += 1) {
      const initialized = await post(
        baseUrl,
        streams[index]!.endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 100 + index,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "sse-session-admission", version: "1.0.0" },
          },
        }),
      );
      expect(initialized.status).toBe(202);
      await streams[index]!.nextFrame();
    }
    const call = async (stream: OpenSse, id: number): Promise<void> => {
      expect(
        (
          await post(
            baseUrl,
            stream.endpoint,
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: {
                name: "jetkvm_display_status",
                arguments: {
                  session_id: "shared-application-session",
                  session_generation: 1,
                  timeout_ms: 1_000,
                },
              },
            }),
          )
        ).status,
      ).toBe(202);
    };

    try {
      await call(streams[0]!, 1);
      await call(streams[1]!, 2);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      await call(streams[2]!, 3);
      expect(await streams[2]!.nextFrame()).toContain(
        `"code":${MCP_SERVER_BUSY_ERROR_CODE}`,
      );
      expect(handler).toHaveBeenCalledTimes(2);

      streams[0]!.response.destroy();
      await vi.waitFor(() => expect(abortedCount).toBe(1));
      await call(streams[2]!, 4);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
    } finally {
      for (const stream of streams) stream.response.destroy();
    }
  }, 10_000);

  it.each([
    ["disabled policy", { enabled: false }, authorizedHeaders()],
    ["Host", {}, { ...authorizedHeaders(), Host: "attacker.example.test" }],
    [
      "Origin",
      {},
      { ...authorizedHeaders(), Origin: "https://attacker.example.test" },
    ],
    ["anti-CSRF", {}, { ...authorizedHeaders(), "X-JetKVM-CSRF": "0" }],
  ] as const)(
    "keeps %s invariant when a bearer authenticator is injected",
    async (_case, policy, headers) => {
      const transportFactory = vi.fn(
        (
          endpoint: string,
          response: ConstructorParameters<typeof SSEServerTransport>[1],
        ) => new SSEServerTransport(endpoint, response),
      );
      const authenticateBearer = vi.fn(() => ({ principalId: PRINCIPAL }));
      const { baseUrl } = await startAdapter({
        policy,
        authenticateBearer,
        transportFactory,
      });

      const response = await testFetch(`${baseUrl}/sse`, { headers });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden");
      expect(transportFactory).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "loopback policy on a wildcard listener",
      { bindHost: "127.0.0.1" },
      "0.0.0.0",
    ],
  ] as const)(
    "rejects %s before authentication or allocation",
    async (_case, policy, listenHost) => {
      const authenticateBearer = vi.fn(() => ({ principalId: PRINCIPAL }));
      const transportFactory = vi.fn(
        (
          endpoint: string,
          response: ConstructorParameters<typeof SSEServerTransport>[1],
        ) => new SSEServerTransport(endpoint, response),
      );
      const { baseUrl } = await startAdapter({
        policy,
        listenHost,
        authenticateBearer,
        transportFactory,
      });

      const response = await testFetch(`${baseUrl}/sse`, {
        headers: authorizedHeaders(),
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden");
      expect(authenticateBearer).not.toHaveBeenCalled();
      expect(transportFactory).not.toHaveBeenCalled();
    },
  );

  it("refuses an HTTP constructor for an HTTPS policy", () => {
    const adapter = new LegacySseAdapter({
      securityPolicy: parseLegacySsePolicy({ enabled: true }),
    });

    expect(() => adapter.createHttpServer()).toThrowError(
      "Legacy SSE HTTPS policy requires an HTTPS server",
    );
  });

  it("emits one fixed plaintext warning when the listener starts", async () => {
    await startAdapter();

    expect(vi.mocked(process.stderr.write).mock.calls).toEqual([
      ["legacy SSE plaintext transport enabled\n"],
    ]);
  });

  it("does not emit the plaintext warning for HTTPS", async () => {
    const adapter = new LegacySseAdapter({
      securityPolicy: parseLegacySsePolicy({ enabled: true }),
    });
    const server = adapter.createHttpsServer({
      key: TEST_TLS_KEY,
      cert: TEST_TLS_CERT,
    });
    await listenOnLoopback(server);
    try {
      expect(process.stderr.write).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
      await closeServer(server);
    }
  });

  it("does not emit the plaintext warning for a disabled policy", async () => {
    const adapter = new LegacySseAdapter({
      securityPolicy: parseLegacySsePolicy({
        enabled: false,
        scheme: "http",
        allowPlaintextHttp: true,
      }),
    });
    const server = adapter.createHttpServer();
    await listenOnLoopback(server);
    try {
      expect(process.stderr.write).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
      await closeServer(server);
    }
  });

  it("makes attached listener deadlines immutable", async () => {
    const value = await startAdapter();

    expect(() => {
      value.server.headersTimeout = 0;
    }).toThrow(TypeError);
    expect(() => {
      value.server.requestTimeout = 0;
    }).toThrow(TypeError);
    expect(() => {
      value.server.keepAliveTimeout = 0;
    }).toThrow(TypeError);
    expect(() => {
      value.server.keepAliveTimeoutBuffer = 1_000;
    }).toThrow(TypeError);
    const parserBoundServer = value.server as typeof value.server & {
      maxHeaderSize: number;
      insecureHTTPParser: boolean;
    };
    expect(() => {
      parserBoundServer.maxHeaderSize = 1_048_576;
    }).toThrow(TypeError);
    expect(() => {
      parserBoundServer.insecureHTTPParser = true;
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(parserBoundServer, "maxHeaderSize", {
        value: 1_048_576,
      });
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(parserBoundServer, "insecureHTTPParser", {
        value: true,
      });
    }).toThrow(TypeError);
    expect(value.server.headersTimeout).toBe(10_000);
    expect(value.server.requestTimeout).toBe(30_000);
    expect(value.server.keepAliveTimeout).toBe(5_000);
    expect(value.server.keepAliveTimeoutBuffer).toBe(0);
    expect(parserBoundServer.maxHeaderSize).toBe(LEGACY_SSE_MAX_HEADER_BYTES);
    expect(parserBoundServer.insecureHTTPParser).toBe(false);
  });

  it("rejects servers without project-owned construction proof", () => {
    const adapter = new LegacySseAdapter({
      securityPolicy: parseLegacySsePolicy({
        enabled: true,
        scheme: "http",
        allowPlaintextHttp: true,
      }),
    });
    const server = createServer();

    expect(() => adapter.attachServer(server)).toThrowError(
      "Legacy SSE server lacks project-owned construction proof",
    );
    expect(server.maxConnections).toBeUndefined();
  });

  it("ignores HTTPS parser-bound overrides at construction", () => {
    const adapter = new LegacySseAdapter({
      securityPolicy: parseLegacySsePolicy({ enabled: true }),
    });
    const server = adapter.createHttpsServer({
      key: TEST_TLS_KEY,
      cert: TEST_TLS_CERT,
      maxHeaderSize: 1_048_576,
      insecureHTTPParser: true,
    }) as HttpsServer & {
      maxHeaderSize: number;
      insecureHTTPParser: boolean;
    };

    expect(server.maxHeaderSize).toBe(LEGACY_SSE_MAX_HEADER_BYTES);
    expect(server.insecureHTTPParser).toBe(false);
    expect(() => {
      server.maxHeaderSize = 1_048_576;
    }).toThrow(TypeError);
    expect(() => {
      server.insecureHTTPParser = true;
    }).toThrow(TypeError);
  });

  it("expires incomplete HTTP headers at the configured construction bound", async () => {
    const adapter = new LegacySseAdapter({
      securityPolicy: parseLegacySsePolicy({
        enabled: true,
        scheme: "http",
        allowPlaintextHttp: true,
        requestHeaderTimeoutMs: 40,
      }),
    });
    const server = adapter.createHttpServer();
    const port = await listenOnLoopback(server);

    try {
      // Connect just after Node's periodic sweep to expose its near-2x gap.
      await new Promise((resolve) => setTimeout(resolve, 45));
      const socket = await connectRaw(port);
      const startedAt = Date.now();
      socket.write("GET /sse HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      await waitForSocketClose(socket, 500);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(25);
      expect(elapsedMs).toBeLessThan(65);
    } finally {
      await adapter.close();
      await closeServer(server);
    }
  });

  it("starts a fresh absolute header deadline for keep-alive requests", async () => {
    const value = await startAdapter({
      policy: { requestHeaderTimeoutMs: 40 },
    });
    const stream = await openSse(value.baseUrl);
    const port = Number(new URL(value.baseUrl).port);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    await new Promise((resolve) => setTimeout(resolve, 45));
    const socket = await connectRaw(port);
    const firstResponse = Promise.withResolvers<void>();
    socket.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("Accepted")) {
        firstResponse.resolve();
      }
    });
    socket.write(
      [
        `POST ${stream.endpoint} HTTP/1.1`,
        ...Object.entries(authorizedHeaders()).map(
          ([name, value]) => `${name}: ${value}`,
        ),
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: keep-alive",
        "",
        body,
      ].join("\r\n"),
    );
    await firstResponse.promise;

    const startedAt = Date.now();
    socket.write(`POST ${stream.endpoint} HTTP/1.1\r\nHost: ${AUTHORITY}\r\n`);
    await waitForSocketClose(socket, 500);
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(25);
    expect(elapsedMs).toBeLessThan(65);
    stream.response.destroy();
  });

  it("accepts exactly 16 KiB of headers and rejects one byte more", async () => {
    const authenticateBearer = vi.fn(() => ({ principalId: PRINCIPAL }));
    const adapter = new LegacySseAdapter({
      securityPolicy: parseLegacySsePolicy({
        enabled: true,
        scheme: "http",
        bindHost: "127.0.0.1",
        allowPlaintextHttp: true,
        hostAuthorities: ["127.0.0.1"],
        bearerEnvironmentVariable: "JETKVM_TEST_SSE_BEARER",
      }),
      authenticateBearer,
    });
    const server = adapter.createHttpServer();
    const port = await listenOnLoopback(server);
    const headerPrefix = [
      "Host: 127.0.0.1",
      `Authorization: Bearer ${TOKEN}`,
      "X-Fill: ",
    ].join("\r\n");
    const headerSuffix = "\r\nConnection: close\r\n\r\n";
    // Node 22 excludes these fixed delimiter bytes from maxHeaderSize.
    const uncountedHeaderDelimiterBytes = 9;
    const requestWithHeaderBytes = (byteLength: number): string => {
      const fillBytes =
        byteLength +
        uncountedHeaderDelimiterBytes -
        Buffer.byteLength(headerPrefix) -
        Buffer.byteLength(headerSuffix);
      return `GET /unknown HTTP/1.1\r\n${headerPrefix}${"x".repeat(
        fillBytes,
      )}${headerSuffix}`;
    };

    try {
      const exact = await connectRaw(port);
      exact.write(requestWithHeaderBytes(LEGACY_SSE_MAX_HEADER_BYTES));
      expect(await waitForSocketClose(exact, 500)).toMatch(
        /^HTTP\/1\.1 404 Not Found\r\n/,
      );

      const oversized = await connectRaw(port);
      oversized.write(requestWithHeaderBytes(LEGACY_SSE_MAX_HEADER_BYTES + 1));
      expect(await waitForSocketClose(oversized, 500)).toMatch(
        /^HTTP\/1\.1 431 Request Header Fields Too Large\r\n/,
      );

      const malformed = await connectRaw(port);
      malformed.write(
        [
          "GET /sse HTTP/1.1",
          "Host: 127.0.0.1",
          `Authorization: Bearer ${TOKEN}`,
          "Malformed Header",
          "",
          "",
        ].join("\r\n"),
      );
      expect(await waitForSocketClose(malformed, 500)).toMatch(
        /^HTTP\/1\.1 400 Bad Request\r\n/,
      );
      expect(authenticateBearer).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
      await closeServer(server);
    }
  });

  it("expires a fragmented TLS ClientHello at the absolute header bound", async () => {
    const adapter = new LegacySseAdapter({
      securityPolicy: parseLegacySsePolicy({
        enabled: true,
        requestHeaderTimeoutMs: 40,
      }),
    });
    const server = adapter.createHttpsServer({});
    const port = await listenOnLoopback(server);

    try {
      const socket = await connectRaw(port);
      const fragmentedClientHello = Buffer.from([
        0x16,
        0x03,
        0x01,
        0x40,
        0x00,
        0x01,
        0x00,
        0x3f,
        0xfc,
        0x03,
        0x03,
        ...Buffer.alloc(256),
      ]);
      let offset = 11;
      socket.write(fragmentedClientHello.subarray(0, offset));
      // Real activity is required to prove TLS reads cannot reset the deadline.
      const activity = setInterval(() => {
        if (socket.destroyed) return;
        const nextOffset = Math.min(offset + 1, fragmentedClientHello.length);
        socket.write(fragmentedClientHello.subarray(offset, nextOffset));
        offset = nextOffset;
      }, 10);
      try {
        await waitForSocketClose(socket, 200);
      } finally {
        clearInterval(activity);
      }
    } finally {
      await adapter.close();
      await closeServer(server);
    }
  });

  it("starts the absolute header deadline after a TLS handshake", async () => {
    const adapter = new LegacySseAdapter({
      securityPolicy: parseLegacySsePolicy({
        enabled: true,
        requestHeaderTimeoutMs: 40,
      }),
    });
    const server = adapter.createHttpsServer({
      key: TEST_TLS_KEY,
      cert: TEST_TLS_CERT,
    });
    const port = await listenOnLoopback(server);
    let client: TLSSocket | undefined;

    try {
      await new Promise((resolve) => setTimeout(resolve, 45));
      client = connectTls({
        host: "127.0.0.1",
        port,
        rejectUnauthorized: false,
      });
      const secured = Promise.withResolvers<void>();
      client.once("secureConnect", secured.resolve);
      client.once("error", secured.reject);
      await secured.promise;

      const startedAt = Date.now();
      client.write("GET /sse HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      await waitForSocketClose(client, 500);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(25);
      expect(elapsedMs).toBeLessThan(65);
    } finally {
      client?.destroy();
      await adapter.close();
      await closeServer(server);
    }
  });

  it("clears the absolute TLS deadline after a completed handshake", async () => {
    const adapter = new LegacySseAdapter({
      securityPolicy: parseLegacySsePolicy({
        enabled: true,
        requestHeaderTimeoutMs: 40,
      }),
    });
    const server = adapter.createHttpsServer({
      key: TEST_TLS_KEY,
      cert: TEST_TLS_CERT,
    });
    const port = await listenOnLoopback(server);
    let client: TLSSocket | undefined;

    try {
      client = connectTls({
        host: "127.0.0.1",
        port,
        rejectUnauthorized: false,
      });
      const secured = Promise.withResolvers<void>();
      client.once("secureConnect", secured.resolve);
      client.once("error", secured.reject);
      await secured.promise;

      const endpointFrame = Promise.withResolvers<void>();
      let response = "";
      client.on("data", (chunk: Buffer) => {
        response += chunk.toString("utf8");
        if (response.includes("event: endpoint")) endpointFrame.resolve();
      });
      client.write(
        "GET /sse HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
      );
      await endpointFrame.promise;

      const survived = Promise.withResolvers<void>();
      // This platform integration wait exceeds the absolute handshake deadline.
      const survivalTimer = setTimeout(survived.resolve, 100);
      client.once("close", () => {
        clearTimeout(survivalTimer);
        survived.reject(
          new Error("Completed TLS connection hit the handshake deadline"),
        );
      });
      await survived.promise;
      expect(client.destroyed).toBe(false);
    } finally {
      client?.destroy();
      await adapter.close();
      await closeServer(server);
    }
  });

  it("sets a finite immutable connection cap before listening", async () => {
    const value = await startAdapter();
    const descriptor = Object.getOwnPropertyDescriptor(
      value.server,
      "maxConnections",
    );

    expect(value.server.maxConnections).toBe(160);
    expect(Number.isFinite(value.server.maxConnections)).toBe(true);
    expect(descriptor).toMatchObject({
      configurable: false,
      writable: false,
      value: 160,
    });
    expect(() => {
      value.server.maxConnections = 1;
    }).toThrow(TypeError);
  });

  it("rejects a concrete bearer that bypassed independent activation", () => {
    const secret = DisposableSecret.fromUtf8(TOKEN);
    expect(
      () =>
        new LegacySseAdapter({
          securityPolicy: parseLegacySsePolicy({
            bearerEnvironmentVariable: "JETKVM_TEST_SSE_BEARER",
          }),
          bearerCredential: {
            principalId: PRINCIPAL,
            secret,
          } as never,
        }),
    ).toThrowError(
      "Legacy SSE bearer credential must be independently activated",
    );
    secret.dispose();
  });

  it("rate-limits unauthenticated and malformed route attempts before checks", async () => {
    let now = 1_000;
    const authenticateBearer = vi.fn((authorization: string | undefined) => {
      if (authorization !== `Bearer ${TOKEN}`) {
        throw new Error("invalid bearer");
      }
      return { principalId: PRINCIPAL };
    });
    const transportFactory = vi.fn(
      (
        endpoint: string,
        response: ConstructorParameters<typeof SSEServerTransport>[1],
      ) => new SSEServerTransport(endpoint, response),
    );
    const { baseUrl } = await startAdapter({
      policy: {
        routeAttemptRateLimit: 2,
        routeAttemptRateWindowMs: 100,
      },
      now: () => now,
      authenticateBearer,
      transportFactory,
    });

    const unauthenticated = await testFetch(`${baseUrl}/sse`, {
      headers: {
        Host: AUTHORITY,
        Origin: ORIGIN,
        "X-JetKVM-CSRF": "1",
      },
    });
    expect(unauthenticated.status).toBe(401);

    const malformed = await post(baseUrl, "/messages?sessionId=bad", "{}");
    expect(malformed.status).toBe(400);

    const limited = await testFetch(`${baseUrl}/unknown`, {
      headers: authorizedHeaders(),
    });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("Too Many Requests");
    expect(authenticateBearer).toHaveBeenCalledTimes(1);
    expect(transportFactory).not.toHaveBeenCalled();

    now -= 1;
    const recovered = await testFetch(`${baseUrl}/unknown`, {
      headers: authorizedHeaders(),
    });
    expect(recovered.status).toBe(404);
  });

  it("closes a rejected POST socket without draining its trickled body", async () => {
    const { baseUrl } = await startAdapter();
    const port = Number(new URL(baseUrl).port);
    const socket = await connectRaw(port);
    socket.write(
      [
        "POST /messages?sessionId=00000000-0000-4000-8000-000000000000 HTTP/1.1",
        `Host: ${AUTHORITY}`,
        `Origin: ${ORIGIN}`,
        "X-JetKVM-CSRF: 1",
        "Content-Type: application/json",
        "Content-Length: 1048576",
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"),
    );

    const response = await waitForSocketClose(socket, 500);
    expect(response).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
    expect(response.toLowerCase()).toContain("\r\nconnection: close\r\n");
    expect(response.endsWith("Unauthorized")).toBe(true);
  });

  it("releases a full connection cap of rejected GET and HEAD trickles", async () => {
    const transportFactory = vi.fn(
      (
        endpoint: string,
        response: ConstructorParameters<typeof SSEServerTransport>[1],
      ) => new SSEServerTransport(endpoint, response),
    );
    const value = await startAdapter({
      policy: {
        maxConcurrentStreams: 1,
        maxConcurrentStreamsPerPrincipal: 1,
        maxConcurrentPosts: 1,
        maxConcurrentPostsPerPrincipal: 1,
        maxConcurrentPostsPerSession: 1,
      },
      transportFactory,
    });
    const port = Number(new URL(value.baseUrl).port);
    const sockets = await Promise.all(
      Array.from({ length: value.server.maxConnections }, () =>
        connectRaw(port),
      ),
    );

    for (const [index, socket] of sockets.entries()) {
      const method = index % 2 === 0 ? "GET" : "HEAD";
      const chunked = index % 4 >= 2;
      socket.write(
        [
          `${method} /sse HTTP/1.1`,
          `Host: ${AUTHORITY}`,
          `Origin: ${ORIGIN}`,
          `Authorization: Bearer ${TOKEN}`,
          "X-JetKVM-CSRF: 1",
          ...(chunked
            ? ["Transfer-Encoding: chunked"]
            : ["Content-Length: 1048576"]),
          "Connection: keep-alive",
          "",
          chunked ? "1\r\n{\r\n" : "{",
        ].join("\r\n"),
      );
    }
    const responses = await Promise.all(
      sockets.map((socket) => waitForSocketClose(socket, 500)),
    );

    for (const [index, response] of responses.entries()) {
      expect(response).toMatch(
        index % 2 === 0
          ? /^HTTP\/1\.1 400 Bad Request\r\n/
          : /^HTTP\/1\.1 405 Method Not Allowed\r\n/,
      );
      expect(response.toLowerCase()).toContain("\r\nconnection: close\r\n");
    }
    expect(transportFactory).not.toHaveBeenCalled();

    const valid = await openSse(value.baseUrl);
    expect(transportFactory).toHaveBeenCalledOnce();
    valid.response.destroy();
  });

  it("enforces global and per-principal stream concurrency before allocation", async () => {
    const streamClosed = Promise.withResolvers<void>();
    const transportFactory = vi.fn(
      (
        endpoint: string,
        response: ConstructorParameters<typeof SSEServerTransport>[1],
      ) => new SSEServerTransport(endpoint, response),
    );
    const { baseUrl } = await startAdapter({
      policy: {
        maxConcurrentStreams: 2,
        maxConcurrentStreamsPerPrincipal: 1,
      },
      transportFactory,
      onDiagnostic: (event) => {
        if (event.code === "transport_closed") streamClosed.resolve();
      },
    });
    const first = await openSse(baseUrl);

    const principalLimited = await testFetch(`${baseUrl}/sse`, {
      headers: authorizedHeaders(),
    });
    expect(principalLimited.status).toBe(429);
    expect(await principalLimited.text()).toBe("Too Many Requests");
    expect(transportFactory).toHaveBeenCalledTimes(1);

    first.response.destroy();
    await streamClosed.promise;
    const replacement = await openSse(baseUrl);
    expect(transportFactory).toHaveBeenCalledTimes(2);
    replacement.response.destroy();

    const globalTransportFactory = vi.fn(
      (
        endpoint: string,
        response: ConstructorParameters<typeof SSEServerTransport>[1],
      ) => new SSEServerTransport(endpoint, response),
    );
    const global = await startAdapter({
      policy: {
        bindHost: "127.0.0.1",
        maxConcurrentStreams: 1,
        maxConcurrentStreamsPerPrincipal: 1,
      },
      authenticateBearer: (authorization) => ({
        principalId:
          authorization === "Bearer second-token" ? "operator-b" : PRINCIPAL,
      }),
      transportFactory: globalTransportFactory,
    });
    const globalFirst = await openSse(global.baseUrl);
    const globallyLimited = await testFetch(`${global.baseUrl}/sse`, {
      headers: authorizedHeaders("second-token"),
    });
    expect(globallyLimited.status).toBe(429);
    expect(await globallyLimited.text()).toBe("Too Many Requests");
    expect(globalTransportFactory).toHaveBeenCalledTimes(1);
    globalFirst.response.destroy();
  });

  it("enforces stream opening rate bounds before allocation", async () => {
    let now = 1_000;
    const streamClosed = Promise.withResolvers<void>();
    const transportFactory = vi.fn(
      (
        endpoint: string,
        response: ConstructorParameters<typeof SSEServerTransport>[1],
      ) => new SSEServerTransport(endpoint, response),
    );
    const { baseUrl } = await startAdapter({
      policy: {
        streamOpenRateLimit: 1,
        streamOpenRateLimitPerPrincipal: 1,
        streamOpenRateWindowMs: 100,
      },
      now: () => now,
      transportFactory,
      onDiagnostic: (event) => {
        if (event.code === "transport_closed") streamClosed.resolve();
      },
    });
    const first = await openSse(baseUrl);
    first.response.destroy();
    await streamClosed.promise;

    const limited = await testFetch(`${baseUrl}/sse`, {
      headers: authorizedHeaders(),
    });
    expect(limited.status).toBe(429);
    expect(transportFactory).toHaveBeenCalledTimes(1);

    now += 100;
    const afterWindow = await openSse(baseUrl);
    expect(transportFactory).toHaveBeenCalledTimes(2);
    afterWindow.response.destroy();
  });

  it("resets stream opening histories when the clock moves backward", async () => {
    let now = 1_000;
    const streamClosed = Promise.withResolvers<void>();
    let allocationCount = 0;
    const transportFactory = vi.fn(
      (
        endpoint: string,
        response: ConstructorParameters<typeof SSEServerTransport>[1],
      ) => {
        allocationCount += 1;
        if (allocationCount === 2) {
          throw new Error("rollback reached allocation");
        }
        return new SSEServerTransport(endpoint, response);
      },
    );
    const { baseUrl } = await startAdapter({
      policy: {
        routeAttemptRateLimit: 10,
        streamOpenRateLimit: 1,
        streamOpenRateLimitPerPrincipal: 1,
        streamOpenRateWindowMs: 100,
      },
      now: () => now,
      transportFactory,
      onDiagnostic: (event) => {
        if (event.code === "transport_closed") streamClosed.resolve();
      },
    });
    const first = await openSse(baseUrl);
    first.response.destroy();
    await streamClosed.promise;
    expect(
      (
        await testFetch(`${baseUrl}/sse`, {
          headers: authorizedHeaders(),
        })
      ).status,
    ).toBe(429);

    now = 900;
    const afterRollback = await testFetch(`${baseUrl}/sse`, {
      headers: authorizedHeaders(),
    });
    expect(afterRollback.status).toBe(500);
    expect(transportFactory).toHaveBeenCalledTimes(2);
  });

  it("bounds concurrent POST work globally, per principal, and per session", async () => {
    const globalRouted = Promise.withResolvers<void>();
    const global = await startAdapter({
      policy: {
        bindHost: "127.0.0.1",
        maxConcurrentPosts: 1,
        maxConcurrentPostsPerPrincipal: 1,
        maxConcurrentPostsPerSession: 1,
      },
      authenticateBearer: (authorization) => ({
        principalId:
          authorization === "Bearer second-token" ? "operator-b" : PRINCIPAL,
      }),
      onDiagnostic: (event) => {
        if (event.code === "post_routed") globalRouted.resolve();
      },
    });
    const globalFirstStream = await openSse(global.baseUrl);
    const globalSecondStream = await openSse(
      global.baseUrl,
      authorizedHeaders("second-token"),
    );
    const globalPending = beginPendingPost(
      global.baseUrl,
      globalFirstStream.endpoint,
    );
    await globalRouted.promise;
    const globallyLimited = await post(
      global.baseUrl,
      globalSecondStream.endpoint,
      "{}",
      authorizedHeaders("second-token"),
    );
    expect(globallyLimited.status).toBe(429);
    expect(await globallyLimited.text()).toBe("Too Many Requests");
    globalPending.request.destroy();
    await globalPending.response.catch(() => undefined);
    globalFirstStream.response.destroy();
    globalSecondStream.response.destroy();

    const principalRouted = Promise.withResolvers<void>();
    const perPrincipal = await startAdapter({
      policy: {
        maxConcurrentPosts: 2,
        maxConcurrentPostsPerPrincipal: 1,
        maxConcurrentPostsPerSession: 1,
      },
      onDiagnostic: (event) => {
        if (event.code === "post_routed") principalRouted.resolve();
      },
    });
    const principalFirstStream = await openSse(perPrincipal.baseUrl);
    const principalSecondStream = await openSse(perPrincipal.baseUrl);
    const principalPending = beginPendingPost(
      perPrincipal.baseUrl,
      principalFirstStream.endpoint,
    );
    await principalRouted.promise;
    const principalLimited = await post(
      perPrincipal.baseUrl,
      principalSecondStream.endpoint,
      "{}",
    );
    expect(principalLimited.status).toBe(429);
    expect(await principalLimited.text()).toBe("Too Many Requests");
    principalPending.request.destroy();
    await principalPending.response.catch(() => undefined);
    principalFirstStream.response.destroy();
    principalSecondStream.response.destroy();

    const sessionRouted = Promise.withResolvers<void>();
    const perSession = await startAdapter({
      policy: {
        maxConcurrentPosts: 2,
        maxConcurrentPostsPerPrincipal: 2,
        maxConcurrentPostsPerSession: 1,
      },
      onDiagnostic: (event) => {
        if (event.code === "post_routed") sessionRouted.resolve();
      },
    });
    const sessionStream = await openSse(perSession.baseUrl);
    const sessionPending = beginPendingPost(
      perSession.baseUrl,
      sessionStream.endpoint,
    );
    await sessionRouted.promise;
    const sessionLimited = await post(
      perSession.baseUrl,
      sessionStream.endpoint,
      "{}",
    );
    expect(sessionLimited.status).toBe(429);
    expect(await sessionLimited.text()).toBe("Too Many Requests");
    sessionPending.request.destroy();
    await sessionPending.response.catch(() => undefined);
    sessionStream.response.destroy();
  });

  it("keeps routed POST rate quota principal-bound before lookup", async () => {
    const value = await startAdapter({
      policy: {
        bindHost: "127.0.0.1",
        postRateLimit: 10,
        postRateLimitPerPrincipal: 10,
        postRateLimitPerSession: 1,
      },
      authenticateBearer: (authorization) => ({
        principalId:
          authorization === "Bearer attacker-token" ? "attacker" : PRINCIPAL,
      }),
    });
    const ownerStream = await openSse(value.baseUrl);

    expect(
      (
        await post(
          value.baseUrl,
          ownerStream.endpoint,
          "{}",
          authorizedHeaders("attacker-token"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          value.baseUrl,
          ownerStream.endpoint,
          "{}",
          authorizedHeaders("attacker-token"),
        )
      ).status,
    ).toBe(429);
    expect((await post(value.baseUrl, ownerStream.endpoint, "{}")).status).toBe(
      400,
    );
    expect((await post(value.baseUrl, ownerStream.endpoint, "{}")).status).toBe(
      429,
    );
    ownerStream.response.destroy();
  });

  it("keeps routed POST concurrency principal-bound before lookup", async () => {
    const routed = Promise.withResolvers<void>();
    const value = await startAdapter({
      policy: {
        bindHost: "127.0.0.1",
        maxConcurrentPosts: 4,
        maxConcurrentPostsPerPrincipal: 2,
        maxConcurrentPostsPerSession: 1,
        postRateLimit: 10,
        postRateLimitPerPrincipal: 10,
        postRateLimitPerSession: 10,
      },
      authenticateBearer: (authorization) => ({
        principalId:
          authorization === "Bearer attacker-token" ? "attacker" : PRINCIPAL,
      }),
      onDiagnostic: (event) => {
        if (event.code === "post_routed") routed.resolve();
      },
    });
    const ownerStream = await openSse(value.baseUrl);
    const ownerPending = beginPendingPost(value.baseUrl, ownerStream.endpoint);
    await routed.promise;

    const attacker = await post(
      value.baseUrl,
      ownerStream.endpoint,
      "{}",
      authorizedHeaders("attacker-token"),
    );
    expect(attacker.status).toBe(404);
    const ownerLimited = await post(value.baseUrl, ownerStream.endpoint, "{}");
    expect(ownerLimited.status).toBe(429);
    ownerPending.request.destroy();
    await ownerPending.response.catch(() => undefined);
    ownerStream.response.destroy();
  });

  it("admits POST rate attempts after auth and before routing in fixed windows", async () => {
    let now = 1_000;
    const unknownA = "/messages?sessionId=00000000-0000-4000-8000-000000000001";
    const unknownB = "/messages?sessionId=00000000-0000-4000-8000-000000000002";
    const perSession = await startAdapter({
      policy: {
        postRateLimit: 10,
        postRateLimitPerPrincipal: 10,
        postRateLimitPerSession: 1,
        postRateWindowMs: 100,
      },
      now: () => now,
    });
    const unauthenticated = await post(
      perSession.baseUrl,
      unknownA,
      "{}",
      authorizedHeaders("invalid"),
    );
    expect(unauthenticated.status).toBe(401);
    expect((await post(perSession.baseUrl, unknownA, "{}")).status).toBe(404);
    expect((await post(perSession.baseUrl, unknownA, "{}")).status).toBe(429);
    expect((await post(perSession.baseUrl, unknownB, "{}")).status).toBe(404);
    now += 100;
    expect((await post(perSession.baseUrl, unknownA, "{}")).status).toBe(404);

    const perPrincipal = await startAdapter({
      policy: {
        bindHost: "127.0.0.1",
        postRateLimit: 10,
        postRateLimitPerPrincipal: 1,
        postRateLimitPerSession: 10,
      },
      authenticateBearer: (authorization) => ({
        principalId:
          authorization === "Bearer second-token" ? "operator-b" : PRINCIPAL,
      }),
    });
    expect((await post(perPrincipal.baseUrl, unknownA, "{}")).status).toBe(404);
    expect((await post(perPrincipal.baseUrl, unknownB, "{}")).status).toBe(429);
    expect(
      (
        await post(
          perPrincipal.baseUrl,
          unknownB,
          "{}",
          authorizedHeaders("second-token"),
        )
      ).status,
    ).toBe(404);

    const global = await startAdapter({
      policy: {
        bindHost: "127.0.0.1",
        postRateLimit: 1,
        postRateLimitPerPrincipal: 1,
        postRateLimitPerSession: 1,
      },
      authenticateBearer: (authorization) => ({
        principalId:
          authorization === "Bearer second-token" ? "operator-b" : PRINCIPAL,
      }),
    });
    expect((await post(global.baseUrl, unknownA, "{}")).status).toBe(404);
    expect(
      (
        await post(
          global.baseUrl,
          unknownB,
          "{}",
          authorizedHeaders("second-token"),
        )
      ).status,
    ).toBe(429);
  });

  it.each([
    [
      "principal",
      {
        postRateLimit: 2,
        postRateLimitPerPrincipal: 1,
        postRateLimitPerSession: 2,
      },
      "/messages?sessionId=00000000-0000-4000-8000-000000000002",
      "/messages?sessionId=00000000-0000-4000-8000-000000000003",
    ],
    [
      "session",
      {
        postRateLimit: 2,
        postRateLimitPerPrincipal: 2,
        postRateLimitPerSession: 1,
      },
      "/messages?sessionId=00000000-0000-4000-8000-000000000001",
      "/messages?sessionId=00000000-0000-4000-8000-000000000002",
    ],
  ] as const)(
    "does not burn global POST capacity on a %s quota rejection",
    async (_scope, policy, rejectedPath, secondPrincipalPath) => {
      const firstPath =
        "/messages?sessionId=00000000-0000-4000-8000-000000000001";
      const value = await startAdapter({
        policy: { ...policy, bindHost: "127.0.0.1" },
        authenticateBearer: (authorization) => ({
          principalId:
            authorization === "Bearer second-token" ? "operator-b" : PRINCIPAL,
        }),
      });

      expect((await post(value.baseUrl, firstPath, "{}")).status).toBe(404);
      expect((await post(value.baseUrl, rejectedPath, "{}")).status).toBe(429);
      expect(
        (
          await post(
            value.baseUrl,
            secondPrincipalPath,
            "{}",
            authorizedHeaders("second-token"),
          )
        ).status,
      ).toBe(404);
    },
  );

  it("closes trickled requests at full route, stream, and POST quotas", async () => {
    const routeLimited = await startAdapter({
      policy: {
        routeAttemptRateLimit: 1,
        routeAttemptRateWindowMs: 1_000,
      },
    });
    expect(
      (
        await testFetch(`${routeLimited.baseUrl}/unknown`, {
          headers: authorizedHeaders(),
        })
      ).status,
    ).toBe(404);
    const routeSocket = await connectRaw(
      Number(new URL(routeLimited.baseUrl).port),
    );
    routeSocket.write(
      [
        "GET /unknown HTTP/1.1",
        ...Object.entries(authorizedHeaders()).map(
          ([name, value]) => `${name}: ${value}`,
        ),
        "Content-Length: 100",
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"),
    );
    const routeResponse = await waitForSocketClose(routeSocket, 500);
    expect(routeResponse).toMatch(/^HTTP\/1\.1 429 Too Many Requests\r\n/);
    expect(routeResponse.toLowerCase()).toContain("\r\nconnection: close\r\n");

    const streamLimited = await startAdapter({
      policy: {
        maxConcurrentStreams: 1,
        maxConcurrentStreamsPerPrincipal: 1,
      },
    });
    const heldStream = await openSse(streamLimited.baseUrl);
    const streamSocket = await connectRaw(
      Number(new URL(streamLimited.baseUrl).port),
    );
    streamSocket.write(
      [
        "GET /sse HTTP/1.1",
        ...Object.entries(authorizedHeaders()).map(
          ([name, value]) => `${name}: ${value}`,
        ),
        "Transfer-Encoding: gzip",
        "tRaNsFeR-EnCoDiNg: chunked",
        "Connection: keep-alive",
        "",
        "1\r\n{\r\n",
      ].join("\r\n"),
    );
    const streamResponse = await waitForSocketClose(streamSocket, 500);
    expect(streamResponse).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(streamResponse.toLowerCase()).toContain("\r\nconnection: close\r\n");
    heldStream.response.destroy();

    const postLimited = await startAdapter({
      policy: {
        postRateLimit: 1,
        postRateLimitPerPrincipal: 1,
        postRateLimitPerSession: 1,
      },
    });
    const firstPostPath =
      "/messages?sessionId=00000000-0000-4000-8000-000000000001";
    const secondPostPath =
      "/messages?sessionId=00000000-0000-4000-8000-000000000002";
    expect((await post(postLimited.baseUrl, firstPostPath, "{}")).status).toBe(
      404,
    );
    const postSocket = await connectRaw(
      Number(new URL(postLimited.baseUrl).port),
    );
    postSocket.write(
      [
        `POST ${secondPostPath} HTTP/1.1`,
        ...Object.entries(authorizedHeaders()).map(
          ([name, value]) => `${name}: ${value}`,
        ),
        "Content-Type: application/json",
        "Content-Length: 100",
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"),
    );
    const postResponse = await waitForSocketClose(postSocket, 500);
    expect(postResponse).toMatch(/^HTTP\/1\.1 429 Too Many Requests\r\n/);
    expect(postResponse.toLowerCase()).toContain("\r\nconnection: close\r\n");
  });

  it("releases POST concurrency after routing, validation, and accepted work", async () => {
    const value = await startAdapter({
      policy: {
        maxConcurrentPosts: 1,
        maxConcurrentPostsPerPrincipal: 1,
        maxConcurrentPostsPerSession: 1,
      },
    });
    const unknown = "/messages?sessionId=00000000-0000-4000-8000-000000000001";
    expect((await post(value.baseUrl, unknown, "{}")).status).toBe(404);

    const stream = await openSse(value.baseUrl);
    const acceptedBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const invalidMediaType = await testFetch(
      `${value.baseUrl}${stream.endpoint}`,
      {
        method: "POST",
        headers: authorizedHeaders(),
        body: "{}",
      },
    );
    expect(invalidMediaType.status).toBe(400);
    expect(await invalidMediaType.text()).toBe("Invalid Content-Type");
    expect(
      (await post(value.baseUrl, stream.endpoint, acceptedBody)).status,
    ).toBe(202);
    expect(
      (await post(value.baseUrl, stream.endpoint, acceptedBody)).status,
    ).toBe(202);
    stream.response.destroy();
  });

  it("expires idle streams with a refreshable timer", async () => {
    const streamClosed = Promise.withResolvers<void>();
    const { baseUrl } = await startAdapter({
      policy: { sessionIdleTimeoutMs: 50 },
      onDiagnostic: (event) => {
        if (event.code === "transport_closed") streamClosed.resolve();
      },
    });
    const stream = await openSse(baseUrl);
    vi.useFakeTimers();
    try {
      const accepted = await post(
        baseUrl,
        stream.endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      );
      expect(accepted.status).toBe(202);
      await vi.advanceTimersByTimeAsync(49);
      expect(stream.response.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await streamClosed.promise;
    } finally {
      vi.useRealTimers();
    }

    const expired = await post(baseUrl, stream.endpoint, "{}");
    expect(expired.status).toBe(404);
    expect(await expired.text()).toBe("Not Found");
  });

  it("terminates a slow upload at the body idle deadline", async () => {
    const routed = Promise.withResolvers<void>();
    const { baseUrl } = await startAdapter({
      policy: {
        requestHeaderTimeoutMs: 50,
        requestBodyIdleTimeoutMs: 20,
        requestBodyTotalTimeoutMs: 100,
      },
      onDiagnostic: (event) => {
        if (event.code === "post_routed") routed.resolve();
      },
    });
    const stream = await openSse(baseUrl);
    const url = new URL(`${baseUrl}${stream.endpoint}`);
    const responseReady = Promise.withResolvers<IncomingMessage>();
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        ...authorizedHeaders(),
        "Content-Type": "application/json",
        "Content-Length": "100",
      },
    });
    request.once("response", responseReady.resolve);
    request.once("error", responseReady.reject);

    vi.useFakeTimers();
    let response: IncomingMessage;
    try {
      request.write("{");
      await routed.promise;
      await vi.advanceTimersByTimeAsync(20);
      response = await responseReady.promise;
    } finally {
      vi.useRealTimers();
    }
    response.setEncoding("utf8");
    let text = "";
    for await (const chunk of response) text += chunk;

    expect(response.statusCode).toBe(408);
    expect(text).toBe("Request Timeout");
    request.destroy();
    stream.response.destroy();
  });

  it("terminates a trickle upload at the body total deadline", async () => {
    const routed = Promise.withResolvers<void>();
    const { baseUrl } = await startAdapter({
      policy: {
        requestHeaderTimeoutMs: 50,
        requestBodyIdleTimeoutMs: 30,
        requestBodyTotalTimeoutMs: 70,
      },
      onDiagnostic: (event) => {
        if (event.code === "post_routed") routed.resolve();
      },
    });
    const stream = await openSse(baseUrl);
    const url = new URL(`${baseUrl}${stream.endpoint}`);
    const responseReady = Promise.withResolvers<IncomingMessage>();
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        ...authorizedHeaders(),
        "Content-Type": "application/json",
        "Content-Length": "100",
      },
    });
    request.once("response", responseReady.resolve);
    request.once("error", responseReady.reject);

    vi.useFakeTimers();
    let response: IncomingMessage;
    try {
      request.write("{");
      await routed.promise;
      for (let elapsed = 10; elapsed < 70; elapsed += 10) {
        await vi.advanceTimersByTimeAsync(10);
        request.write(" ");
      }
      await vi.advanceTimersByTimeAsync(10);
      response = await responseReady.promise;
    } finally {
      vi.useRealTimers();
    }
    response.setEncoding("utf8");
    let text = "";
    for await (const chunk of response) text += chunk;

    expect(response.statusCode).toBe(408);
    expect(text).toBe("Request Timeout");
    request.destroy();
    stream.response.destroy();
  });

  it("closes a slow SSE reader before response buffering can grow past its cap", async () => {
    let transport: SSEServerTransport | undefined;
    let serverResponse: ConstructorParameters<typeof SSEServerTransport>[1];
    const streamClosed = Promise.withResolvers<void>();
    const { baseUrl } = await startAdapter({
      policy: {
        maxResponseMessageBytes: LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES,
        maxResponseBufferedBytes: LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES,
        responseBackpressureTimeoutMs: 20,
      },
      transportFactory: (endpoint, response) => {
        serverResponse = response;
        transport = new SSEServerTransport(endpoint, response);
        return transport;
      },
      onDiagnostic: (event) => {
        if (event.code === "transport_closed") streamClosed.resolve();
      },
    });
    const stream = await openSse(baseUrl);
    stream.response.pause();
    serverResponse!.cork();

    const queuedMessage = {
      jsonrpc: "2.0" as const,
      method: "notifications/message",
      params: { data: "x".repeat(8 * 1024 * 1024) },
    };
    await transport!.send(queuedMessage);
    await transport!.send(queuedMessage);
    await streamClosed.promise;

    await expect(
      transport!.send({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { data: "after-close" },
      }),
    ).rejects.toThrow("Not connected");
    stream.response.destroy();
  });

  it("closes a backpressured SSE writer at its write deadline", async () => {
    vi.useFakeTimers();
    try {
      const destroy = vi.fn();
      const write = vi.fn(() => false);
      const response = Object.assign(new EventEmitter(), {
        destroy,
        writableLength: 0,
        write,
      }) as unknown as Parameters<typeof installBoundedSseWriter>[0];
      const cleanup = installBoundedSseWriter(response, 1_024, 4_096, 20);

      expect(response.write("event: message\ndata: {}\n\n")).toBe(false);
      expect(write).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(19);
      expect(destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds one serialized message separately from total queued bytes", () => {
    const fakeResponse = (writableLength: number) => {
      const destroy = vi.fn();
      const write = vi.fn(() => true);
      const response = Object.assign(new EventEmitter(), {
        destroy,
        writableLength,
        write,
      }) as unknown as Parameters<typeof installBoundedSseWriter>[0];
      return { destroy, response, write };
    };
    const exactBoundary = fakeResponse(0);
    installBoundedSseWriter(
      exactBoundary.response,
      LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES,
      16_777_216,
      20,
    );
    expect(
      exactBoundary.response.write(
        Buffer.alloc(LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES),
      ),
    ).toBe(true);
    expect(exactBoundary.write).toHaveBeenCalledOnce();
    expect(exactBoundary.destroy).not.toHaveBeenCalled();

    const boundaryPlusOne = fakeResponse(0);
    installBoundedSseWriter(
      boundaryPlusOne.response,
      LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES,
      16_777_216,
      20,
    );
    expect(
      boundaryPlusOne.response.write(
        Buffer.alloc(LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES + 1),
      ),
    ).toBe(false);
    expect(boundaryPlusOne.write).not.toHaveBeenCalled();
    expect(boundaryPlusOne.destroy).toHaveBeenCalledOnce();

    const oversizedMessage = fakeResponse(0);
    installBoundedSseWriter(oversizedMessage.response, 4, 100, 20);
    expect(oversizedMessage.response.write("12345")).toBe(false);
    expect(oversizedMessage.write).not.toHaveBeenCalled();
    expect(oversizedMessage.destroy).toHaveBeenCalledTimes(1);

    const overflowingQueue = fakeResponse(8);
    installBoundedSseWriter(overflowingQueue.response, 10, 10, 20);
    expect(overflowingQueue.response.write("123")).toBe(false);
    expect(overflowingQueue.write).not.toHaveBeenCalled();
    expect(overflowingQueue.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["callback", "drain", "close", "error"] as const)(
    "releases hierarchical response bytes exactly on %s",
    (releaseEvent) => {
      let writeCallback: ((error?: Error | null) => void) | undefined;
      const originalCallback = vi.fn();
      const write = vi.fn(
        (_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
          writeCallback =
            typeof encodingOrCallback === "function"
              ? (encodingOrCallback as (error?: Error | null) => void)
              : (callback as (error?: Error | null) => void);
          return true;
        },
      );
      const response = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        writableLength: 0,
        write,
      }) as unknown as Parameters<typeof installBoundedSseWriter>[0];
      const release = vi.fn();
      const reserve = vi.fn(() => release);
      const cleanup = installBoundedSseWriter(response, 100, 100, 20, reserve);

      expect(response.write("queued", originalCallback)).toBe(true);
      expect(reserve).toHaveBeenCalledWith(6);
      expect(release).not.toHaveBeenCalled();
      if (releaseEvent === "callback") {
        writeCallback?.();
      } else if (releaseEvent === "error") {
        response.emit("error", new Error("closed"));
      } else {
        response.emit(releaseEvent);
      }
      expect(release).toHaveBeenCalledOnce();
      if (releaseEvent !== "callback") writeCallback?.();
      expect(release).toHaveBeenCalledOnce();
      expect(originalCallback).toHaveBeenCalledOnce();
      cleanup();
      expect(response.write).toBe(write);
      expect(response.listenerCount("drain")).toBe(0);
      expect(response.listenerCount("close")).toBe(0);
      expect(response.listenerCount("error")).toBe(0);
    },
  );

  it("bounds queued SSE bytes globally and per principal with fair recovery", async () => {
    const transports: SSEServerTransport[] = [];
    const serverResponses: ConstructorParameters<
      typeof SSEServerTransport
    >[1][] = [];
    const diagnostics: string[] = [];
    const value = await startAdapter({
      policy: {
        bindHost: "127.0.0.1",
        maxConcurrentStreams: 8,
        maxConcurrentStreamsPerPrincipal: 2,
        streamOpenRateLimit: 20,
        streamOpenRateLimitPerPrincipal: 4,
        responseBackpressureTimeoutMs: 60_000,
      },
      authenticateBearer: (authorization) => ({
        principalId: authorization?.slice("Bearer ".length) ?? "missing",
      }),
      transportFactory: (endpoint, response) => {
        serverResponses.push(response);
        const transport = new SSEServerTransport(endpoint, response);
        transports.push(transport);
        return transport;
      },
      onDiagnostic: (event) => diagnostics.push(event.code),
    });
    const emptyMessage = {
      jsonrpc: "2.0" as const,
      method: "notifications/message",
      params: { data: "" },
    };
    const emptyFrame = `event: message\ndata: ${JSON.stringify(
      emptyMessage,
    )}\n\n`;
    const message = {
      ...emptyMessage,
      params: {
        data: "x".repeat(
          LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES - Buffer.byteLength(emptyFrame),
        ),
      },
    };
    expect(
      Buffer.byteLength(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
    ).toBe(LEGACY_SSE_MIN_RESPONSE_MESSAGE_BYTES);
    const streams: OpenSse[] = [];
    const openPaused = async (token: string): Promise<OpenSse> => {
      const stream = await openSse(value.baseUrl, authorizedHeaders(token));
      stream.response.pause();
      serverResponses[serverResponses.length - 1]!.cork();
      streams.push(stream);
      return stream;
    };
    const sendAndWaitForClose = async (
      index: number,
      stream: OpenSse,
    ): Promise<void> => {
      const closed = Promise.withResolvers<void>();
      stream.response.once("close", closed.resolve);
      await transports[index]!.send(message).catch(() => undefined);
      await closed.promise;
    };

    try {
      const firstA = await openPaused("response-a");
      await transports[0]!.send(message);
      expect(serverResponses[0]!.destroyed).toBe(false);

      const secondA = await openPaused("response-a");
      await sendAndWaitForClose(1, secondA);
      expect(diagnostics).toContain("response_capacity_exceeded");
      expect(serverResponses[0]!.destroyed).toBe(false);

      for (const token of ["response-b", "response-c", "response-d"]) {
        await openPaused(token);
        const index = transports.length - 1;
        await transports[index]!.send(message);
        expect(serverResponses[index]!.destroyed).toBe(false);
      }

      const firstE = await openPaused("response-e");
      await sendAndWaitForClose(transports.length - 1, firstE);
      expect(
        diagnostics.filter((code) => code === "response_capacity_exceeded"),
      ).toHaveLength(2);

      const firstServerResponseClosed = Promise.withResolvers<void>();
      serverResponses[0]!.once("close", firstServerResponseClosed.resolve);
      firstA.response.destroy();
      await firstServerResponseClosed.promise;

      await openPaused("response-e");
      const replacementIndex = transports.length - 1;
      await transports[replacementIndex]!.send(message);
      expect(serverResponses[replacementIndex]!.destroyed).toBe(false);
    } finally {
      for (const stream of streams) stream.response.destroy();
    }
  }, 20_000);

  it("routes two independent streams and closing one leaves the other working", async () => {
    const { baseUrl } = await startAdapter();
    const first = await openSse(baseUrl);
    const second = await openSse(baseUrl);
    expect(first.endpoint).not.toBe(second.endpoint);

    for (const [id, stream] of [
      [1, first],
      [2, second],
    ] as const) {
      const listed = await post(
        baseUrl,
        stream.endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/list",
          params: {},
        }),
      );
      expect(listed.status).toBe(202);
      expect(await stream.nextFrame()).toMatch(
        new RegExp(`^event: message\\ndata: .*"id":${id}.*\\n\\n$`),
      );
    }

    first.response.destroy();
    const listedAgain = await post(
      baseUrl,
      second.endpoint,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      }),
    );
    expect(listedAgain.status).toBe(202);
    expect(await second.nextFrame()).toMatch(
      /^event: message\ndata: .*"id":3.*\n\n$/,
    );
    second.response.destroy();
  });

  it.each([
    ["text/plain", "{}", "Invalid Content-Type"],
    ["application/json; charset=utf-8", "{}", "Invalid Content-Type"],
    ["application/json", "{", "Invalid JSON"],
    ["application/json", "{}", "Invalid JSON-RPC message"],
  ])(
    "returns adapter-owned 400 for media/body/message errors",
    async (contentType, body, expectedBody) => {
      const { baseUrl } = await startAdapter();
      const stream = await openSse(baseUrl);

      const response = await testFetch(`${baseUrl}${stream.endpoint}`, {
        method: "POST",
        headers: { ...authorizedHeaders(), "Content-Type": contentType },
        body,
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(expectedBody);
      stream.response.destroy();
    },
  );

  it("rejects malformed UTF-8 before JSON parsing or dispatch", async () => {
    const handler = vi.fn(async (_input: unknown) =>
      businessError("jetkvm_input_paste"),
    );
    const { baseUrl } = await startAdapter({
      handlerRegistry: completeRegistry({ jetkvm_input_paste: handler }),
    });
    const stream = await openSse(baseUrl);
    const initialized = await post(
      baseUrl,
      stream.endpoint,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "invalid-utf8-test", version: "1.0.0" },
        },
      }),
    );
    expect(initialized.status).toBe(202);
    await stream.nextFrame();

    const malformed = Buffer.concat([
      Buffer.from(
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"jetkvm_input_paste","arguments":{"session_id":"session-1","session_generation":1,"observation_id":"observation-1","request_id":"request-utf8","text":"',
      ),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('","timeout_ms":100}}}'),
    ]);
    const response = await testFetch(`${baseUrl}${stream.endpoint}`, {
      method: "POST",
      headers: {
        ...authorizedHeaders(),
        "Content-Type": "application/json",
      },
      body: malformed,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid UTF-8");
    expect(handler).not.toHaveBeenCalled();
    stream.response.destroy();
  });

  it("accepts a maximum worst-escaped paste request above 1 MiB", async () => {
    const observedInput = Promise.withResolvers<unknown>();
    const handler = vi.fn(async (input: unknown) => {
      observedInput.resolve(input);
      return businessError("jetkvm_input_paste");
    });
    const { baseUrl } = await startAdapter({
      handlerRegistry: completeRegistry({ jetkvm_input_paste: handler }),
    });
    const stream = await openSse(baseUrl);
    const initialized = await post(
      baseUrl,
      stream.endpoint,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "max-paste-test", version: "1.0.0" },
        },
      }),
    );
    expect(initialized.status).toBe(202);
    await stream.nextFrame();

    const text = "\u0000".repeat(262_144);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "jetkvm_input_paste",
        arguments: {
          session_id: "session-1",
          session_generation: 1,
          observation_id: "observation-1",
          request_id: "request-max-paste",
          text,
          timeout_ms: 100,
        },
      },
    });
    expect(Buffer.byteLength(body)).toBeGreaterThan(1_048_576);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
      MCP_TRANSPORT_MAX_REQUEST_BYTES,
    );

    const called = await post(baseUrl, stream.endpoint, body);
    expect(called.status).toBe(202);
    const input = (await observedInput.promise) as { readonly text: string };
    expect(input.text.length).toBe(262_144);
    expect(input.text.charCodeAt(0)).toBe(0);
    expect(handler).toHaveBeenCalledOnce();
    await stream.nextFrame();
    stream.response.destroy();
  });

  it("coalesces many one-byte chunked writes into one bounded allocation", async () => {
    const { baseUrl } = await startAdapter();
    const stream = await openSse(baseUrl);
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const body = notification + " ".repeat(4_096 - notification.length);
    const url = new URL(`${baseUrl}${stream.endpoint}`);
    const responseReady = Promise.withResolvers<IncomingMessage>();
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        ...authorizedHeaders(),
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
    });
    request.once("response", responseReady.resolve);
    request.once("error", responseReady.reject);
    const allocateUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    try {
      for (let index = 0; index < body.length; index += 1) {
        request.write(body[index]!);
      }
      request.end();
      const response = await responseReady.promise;
      response.resume();
      expect(response.statusCode).toBe(202);
      expect(
        allocateUnsafe.mock.calls.filter(([size]) => size === 8_192),
      ).toHaveLength(1);
      expect(
        allocateUnsafe.mock.calls.some(
          ([size]) => size === MCP_TRANSPORT_MAX_REQUEST_BYTES,
        ),
      ).toBe(false);
    } finally {
      allocateUnsafe.mockRestore();
    }
    stream.response.destroy();
  });

  it("zeroes the coalesced request buffer before releasing capacity", async () => {
    const { baseUrl } = await startAdapter();
    const stream = await openSse(baseUrl);
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const body = notification + " ".repeat(1_023 - notification.length);
    const originalAllocateUnsafe = Buffer.allocUnsafe;
    let captured: Buffer | undefined;
    const allocateUnsafe = vi
      .spyOn(Buffer, "allocUnsafe")
      .mockImplementation((size) => {
        const allocated = originalAllocateUnsafe(size);
        if (size === body.length) captured = allocated;
        return allocated;
      });
    try {
      const response = await post(baseUrl, stream.endpoint, body);
      expect(response.status).toBe(202);
      expect(captured).toBeDefined();
      expect(captured!.every((byte) => byte === 0)).toBe(true);
    } finally {
      allocateUnsafe.mockRestore();
      stream.response.destroy();
    }
  });

  it("zeroes each original IncomingMessage chunk before successful intake ends", async () => {
    const { baseUrl } = await startAdapter();
    const stream = await openSse(baseUrl);
    const socket = await connectRaw(Number(new URL(baseUrl).port));
    const marker = "retained-success-body-chunk";
    const markerBytes = Buffer.from(marker);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: { marker },
    });
    const originalIsBuffer = Buffer.isBuffer;
    const retained: Buffer[] = [];
    const isBuffer = vi
      .spyOn(Buffer, "isBuffer")
      .mockImplementation((value: unknown): value is Buffer => {
        const result = originalIsBuffer(value);
        if (result && value.includes(markerBytes)) retained.push(value);
        return result;
      });

    try {
      socket.write(
        [
          `POST ${stream.endpoint} HTTP/1.1`,
          ...Object.entries(authorizedHeaders()).map(
            ([name, value]) => `${name}: ${value}`,
          ),
          "Content-Type: application/json",
          "Transfer-Encoding: chunked",
          "Connection: close",
          "",
          `${Buffer.byteLength(body).toString(16)}`,
          body,
          "",
        ].join("\r\n"),
      );
      await vi.waitFor(
        () => {
          expect(retained.length).toBeGreaterThan(0);
        },
        { interval: 5, timeout: 500 },
      );
      expect(retained.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
        true,
      );

      socket.write("0\r\n\r\n");
      const response = await waitForSocketClose(socket, 500);
      expect(response).toMatch(/^HTTP\/1\.1 202 Accepted\r\n/);
    } finally {
      isBuffer.mockRestore();
      socket.destroy();
      stream.response.destroy();
    }
  });

  it("zeroes each original IncomingMessage chunk on the streamed cap path", async () => {
    const { baseUrl } = await startAdapter();
    const stream = await openSse(baseUrl);
    const socket = await connectRaw(Number(new URL(baseUrl).port));
    const originalIsBuffer = Buffer.isBuffer;
    const retained: Buffer[] = [];
    const isBuffer = vi
      .spyOn(Buffer, "isBuffer")
      .mockImplementation((value: unknown): value is Buffer => {
        const result = originalIsBuffer(value);
        if (
          result &&
          value.byteLength > 0 &&
          value.every((byte) => byte === 0x7a)
        ) {
          retained.push(value);
        }
        return result;
      });

    try {
      socket.write(
        [
          `POST ${stream.endpoint} HTTP/1.1`,
          ...Object.entries(authorizedHeaders()).map(
            ([name, value]) => `${name}: ${value}`,
          ),
          "Content-Type: application/json",
          "Transfer-Encoding: chunked",
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"),
      );
      const bodyLength = MCP_TRANSPORT_MAX_REQUEST_BYTES + 1;
      socket.write(`${bodyLength.toString(16)}\r\n`);
      socket.write("z".repeat(bodyLength));
      socket.write("\r\n");

      const response = await waitForSocketClose(socket, 2_000);
      expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
      expect(response.endsWith("Request body too large")).toBe(true);
      expect(retained.length).toBeGreaterThan(0);
      expect(retained.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
        true,
      );
    } finally {
      isBuffer.mockRestore();
      socket.destroy();
      stream.response.destroy();
    }
  });

  it("zeroes each original IncomingMessage chunk on body budget rejection", async () => {
    const value = await startAdapter({
      policy: {
        maxConcurrentPosts: 4,
        maxConcurrentPostsPerPrincipal: 4,
        maxConcurrentPostsPerSession: 4,
        postRateLimit: 10,
        postRateLimitPerPrincipal: 10,
        postRateLimitPerSession: 10,
      },
    });
    const stream = await openSse(value.baseUrl);
    const port = Number(new URL(value.baseUrl).port);
    const requestHead = [
      `POST ${stream.endpoint} HTTP/1.1`,
      ...Object.entries(authorizedHeaders()).map(
        ([name, headerValue]) => `${name}: ${headerValue}`,
      ),
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "Connection: keep-alive",
      "",
      "",
    ].join("\r\n");
    const chunkLength = MCP_TRANSPORT_MAX_REQUEST_BYTES / 2 + 1;
    const allocateUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    const held = await connectRaw(port);
    held.write(requestHead);
    held.write(`${chunkLength.toString(16)}\r\n`);
    held.write(" ".repeat(chunkLength));
    held.write("\r\n");
    await vi.waitFor(
      () => {
        expect(
          allocateUnsafe.mock.calls.filter(
            ([size]) => size === MCP_TRANSPORT_MAX_REQUEST_BYTES,
          ),
        ).toHaveLength(1);
      },
      { interval: 5, timeout: 2_000 },
    );

    const originalIsBuffer = Buffer.isBuffer;
    const retained: Buffer[] = [];
    const isBuffer = vi
      .spyOn(Buffer, "isBuffer")
      .mockImplementation((candidate: unknown): candidate is Buffer => {
        const result = originalIsBuffer(candidate);
        if (
          result &&
          candidate.byteLength > 0 &&
          candidate.every((byte) => byte === 0x79)
        ) {
          retained.push(candidate);
        }
        return result;
      });
    const denied = await connectRaw(port);
    try {
      denied.write(requestHead);
      denied.write(`${chunkLength.toString(16)}\r\n`);
      denied.write("y".repeat(chunkLength));
      denied.write("\r\n");

      const response = await waitForSocketClose(denied, 2_000);
      expect(response).toMatch(/^HTTP\/1\.1 429 Too Many Requests\r\n/);
      expect(retained.length).toBeGreaterThan(0);
      expect(retained.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
        true,
      );
    } finally {
      isBuffer.mockRestore();
      allocateUnsafe.mockRestore();
      denied.destroy();
      held.destroy();
      stream.response.destroy();
    }
  });

  it("keeps 1,024 declared-max one-byte trickles within the global budget", async () => {
    const value = await startAdapter({
      policy: {
        maxConcurrentStreams: 2,
        maxConcurrentStreamsPerPrincipal: 2,
        maxConcurrentPosts: 1_024,
        maxConcurrentPostsPerPrincipal: 1_024,
        maxConcurrentPostsPerSession: 512,
        postRateLimit: 10_000,
        postRateLimitPerPrincipal: 10_000,
        postRateLimitPerSession: 10_000,
        routeAttemptRateLimit: 10_000,
      },
    });
    const streams = [
      await openSse(value.baseUrl),
      await openSse(value.baseUrl),
    ];
    const port = Number(new URL(value.baseUrl).port);
    const requestHeads = streams.map((stream) =>
      [
        `POST ${stream.endpoint} HTTP/1.1`,
        ...Object.entries(authorizedHeaders()).map(
          ([name, headerValue]) => `${name}: ${headerValue}`,
        ),
        "Content-Type: application/json",
        `Content-Length: ${MCP_TRANSPORT_MAX_REQUEST_BYTES}`,
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n"),
    );
    const sockets: Socket[] = [];
    const allocateUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    try {
      for (let index = 0; index < 1_024; index += 1) {
        const socket = await connectRaw(port);
        sockets.push(socket);
        socket.write(requestHeads[index % requestHeads.length]!);
        socket.write(" ");
        if ((index + 1) % 128 === 0) {
          await vi.waitFor(
            () => {
              expect(
                allocateUnsafe.mock.calls.filter(([size]) => size === 8_192),
              ).toHaveLength(index + 1);
            },
            { interval: 5, timeout: 2_000 },
          );
        }
      }
      await vi.waitFor(
        () => {
          expect(
            allocateUnsafe.mock.calls.filter(([size]) => size === 8_192),
          ).toHaveLength(1_024);
        },
        { interval: 5, timeout: 5_000 },
      );
      expect(
        allocateUnsafe.mock.calls.some(
          ([size]) => size === MCP_TRANSPORT_MAX_REQUEST_BYTES,
        ),
      ).toBe(false);
      expect(1_024 * 8_192).toBeLessThanOrEqual(
        LEGACY_SSE_ACTIVE_REQUEST_BODY_BUDGET_BYTES,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      allocateUnsafe.mockRestore();
      for (const stream of streams) stream.response.destroy();
    }
  }, 20_000);

  it("accepts the exact 2 MiB cap and closes on streamed cap plus one", async () => {
    const { baseUrl } = await startAdapter();
    const stream = await openSse(baseUrl);
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const exactBody =
      notification +
      " ".repeat(
        MCP_TRANSPORT_MAX_REQUEST_BYTES - Buffer.byteLength(notification),
      );
    expect(Buffer.byteLength(exactBody)).toBe(MCP_TRANSPORT_MAX_REQUEST_BYTES);

    const declared = await post(baseUrl, stream.endpoint, exactBody);
    expect(declared.status).toBe(202);
    const streamed = await testFetch(`${baseUrl}${stream.endpoint}`, {
      method: "POST",
      headers: {
        ...authorizedHeaders(),
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
      body: exactBody,
    });
    expect(streamed.status).toBe(202);

    const allocateUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    let rejected = "";
    let bodyAllocationCount = 0;
    try {
      const socket = await connectRaw(Number(new URL(baseUrl).port));
      socket.write(
        [
          `POST ${stream.endpoint} HTTP/1.1`,
          ...Object.entries(authorizedHeaders()).map(
            ([name, value]) => `${name}: ${value}`,
          ),
          "Content-Type: application/json",
          "Transfer-Encoding: chunked",
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"),
      );
      socket.write(`${MCP_TRANSPORT_MAX_REQUEST_BYTES.toString(16)}\r\n`);
      socket.write(exactBody);
      socket.write("\r\n1\r\n \r\n");
      rejected = await waitForSocketClose(socket, 1_000);
      bodyAllocationCount = allocateUnsafe.mock.calls.filter(
        ([size]) => size === MCP_TRANSPORT_MAX_REQUEST_BYTES,
      ).length;
    } finally {
      allocateUnsafe.mockRestore();
    }
    expect(bodyAllocationCount).toBe(1);
    expect(rejected).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(rejected.toLowerCase()).toContain("\r\nconnection: close\r\n");
    expect(rejected.endsWith("Request body too large")).toBe(true);
    stream.response.destroy();
  });

  it("reserves the global body budget atomically and releases capacity", async () => {
    const value = await startAdapter({
      policy: {
        bindHost: "127.0.0.1",
        maxConcurrentStreams: 32,
        maxConcurrentStreamsPerPrincipal: 7,
        streamOpenRateLimit: 100,
        streamOpenRateLimitPerPrincipal: 20,
        maxConcurrentPosts: 40,
        maxConcurrentPostsPerPrincipal: 7,
        maxConcurrentPostsPerSession: 2,
        postRateLimit: 100,
        postRateLimitPerPrincipal: 100,
        postRateLimitPerSession: 100,
        routeAttemptRateLimit: 100,
      },
      authenticateBearer: (authorization) => ({
        principalId: authorization?.slice("Bearer ".length) ?? "missing",
      }),
    });
    const port = Number(new URL(value.baseUrl).port);
    const chunk = Buffer.alloc(MCP_TRANSPORT_MAX_REQUEST_BYTES / 2 + 1, 0x20);
    const streams: OpenSse[] = [];
    const held: Socket[] = [];
    const allocateUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    const countMaximumAllocations = (): number =>
      allocateUnsafe.mock.calls.filter(
        ([size]) => size === MCP_TRANSPORT_MAX_REQUEST_BYTES,
      ).length;
    const startTrickle = async (
      stream: OpenSse,
      token: string,
    ): Promise<Socket> => {
      const socket = await connectRaw(port);
      socket.write(
        [
          `POST ${stream.endpoint} HTTP/1.1`,
          ...Object.entries(authorizedHeaders(token)).map(
            ([name, headerValue]) => `${name}: ${headerValue}`,
          ),
          "Content-Type: application/json",
          "Transfer-Encoding: chunked",
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"),
      );
      socket.write(`${chunk.byteLength.toString(16)}\r\n`);
      socket.write(chunk);
      socket.write("\r\n");
      return socket;
    };

    try {
      let deniedStream: OpenSse | undefined;
      let deniedToken = "";
      for (let index = 0; index < 32; index += 1) {
        const token = `body-principal-${Math.floor(index / 7)}`;
        const stream = await openSse(value.baseUrl, authorizedHeaders(token));
        streams.push(stream);
        const socket = await startTrickle(stream, token);
        if (index === 31) {
          deniedStream = stream;
          deniedToken = token;
          const deniedResponse = await waitForSocketClose(socket, 2_000);
          expect(deniedResponse).toMatch(
            /^HTTP\/1\.1 429 Too Many Requests\r\n/,
          );
          continue;
        }
        held.push(socket);
        await vi.waitFor(
          () => {
            expect(countMaximumAllocations()).toBe(index + 1);
          },
          { interval: 5, timeout: 2_000 },
        );
      }

      const released = Promise.withResolvers<void>();
      held[0]!.once("close", released.resolve);
      held[0]!.destroy();
      await released.promise;
      const nextTurn = Promise.withResolvers<void>();
      setImmediate(nextTurn.resolve);
      await nextTurn.promise;

      const replacement = await startTrickle(deniedStream!, deniedToken);
      held.push(replacement);
      await vi.waitFor(
        () => {
          expect(countMaximumAllocations()).toBe(32);
        },
        { interval: 5, timeout: 2_000 },
      );
    } finally {
      const closed = held
        .filter((socket) => !socket.destroyed)
        .map((socket) => {
          const completion = Promise.withResolvers<void>();
          socket.once("close", completion.resolve);
          socket.destroy();
          return completion.promise;
        });
      await Promise.all(closed);
      for (const stream of streams) stream.response.destroy();
      allocateUnsafe.mockRestore();
    }
  }, 20_000);

  it("isolates per-session and per-principal body capacity and recovers", async () => {
    const value = await startAdapter({
      policy: {
        bindHost: "127.0.0.1",
        maxConcurrentStreams: 12,
        maxConcurrentStreamsPerPrincipal: 10,
        streamOpenRateLimit: 100,
        streamOpenRateLimitPerPrincipal: 20,
        maxConcurrentPosts: 20,
        maxConcurrentPostsPerPrincipal: 12,
        maxConcurrentPostsPerSession: 4,
        postRateLimit: 100,
        postRateLimitPerPrincipal: 100,
        postRateLimitPerSession: 100,
        routeAttemptRateLimit: 100,
      },
      authenticateBearer: (authorization) => ({
        principalId: authorization?.slice("Bearer ".length) ?? "missing",
      }),
    });
    const port = Number(new URL(value.baseUrl).port);
    const chunk = Buffer.alloc(MCP_TRANSPORT_MAX_REQUEST_BYTES / 2 + 1, 0x20);
    const streams: OpenSse[] = [];
    const held: Socket[] = [];
    const allocateUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    const countMaximumAllocations = (): number =>
      allocateUnsafe.mock.calls.filter(
        ([size]) => size === MCP_TRANSPORT_MAX_REQUEST_BYTES,
      ).length;
    const open = async (token: string): Promise<OpenSse> => {
      const stream = await openSse(value.baseUrl, authorizedHeaders(token));
      streams.push(stream);
      return stream;
    };
    const startTrickle = async (
      stream: OpenSse,
      token: string,
    ): Promise<Socket> => {
      const socket = await connectRaw(port);
      socket.write(
        [
          `POST ${stream.endpoint} HTTP/1.1`,
          ...Object.entries(authorizedHeaders(token)).map(
            ([name, headerValue]) => `${name}: ${headerValue}`,
          ),
          "Content-Type: application/json",
          "Transfer-Encoding: chunked",
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"),
      );
      socket.write(`${chunk.byteLength.toString(16)}\r\n`);
      socket.write(chunk);
      socket.write("\r\n");
      return socket;
    };
    const hold = async (
      stream: OpenSse,
      token: string,
      expectedAllocations: number,
    ): Promise<Socket> => {
      const socket = await startTrickle(stream, token);
      held.push(socket);
      await vi.waitFor(
        () => {
          expect(countMaximumAllocations()).toBe(expectedAllocations);
        },
        { interval: 5, timeout: 2_000 },
      );
      return socket;
    };

    try {
      const first = await open("body-a");
      const firstSocket = await hold(first, "body-a", 1);
      const sameSessionDenied = await startTrickle(first, "body-a");
      expect(await waitForSocketClose(sameSessionDenied, 2_000)).toMatch(
        /^HTTP\/1\.1 429 Too Many Requests\r\n/,
      );

      for (let index = 1; index < 7; index += 1) {
        await hold(await open("body-a"), "body-a", index + 1);
      }
      const principalDeniedStream = await open("body-a");
      const principalDenied = await startTrickle(
        principalDeniedStream,
        "body-a",
      );
      expect(await waitForSocketClose(principalDenied, 2_000)).toMatch(
        /^HTTP\/1\.1 429 Too Many Requests\r\n/,
      );

      await hold(await open("body-b"), "body-b", 8);

      const released = Promise.withResolvers<void>();
      firstSocket.once("close", released.resolve);
      firstSocket.destroy();
      await released.promise;
      const nextTurn = Promise.withResolvers<void>();
      setImmediate(nextTurn.resolve);
      await nextTurn.promise;
      await hold(first, "body-a", 9);
    } finally {
      const closed = held
        .filter((socket) => !socket.destroyed)
        .map((socket) => {
          const completion = Promise.withResolvers<void>();
          socket.once("close", completion.resolve);
          socket.destroy();
          return completion.promise;
        });
      await Promise.all(closed);
      for (const stream of streams) stream.response.destroy();
      allocateUnsafe.mockRestore();
    }
  }, 20_000);

  it("closes a trickled active body and awaits all lifecycle cleanup", async () => {
    const handler = vi.fn(async (_input: unknown) =>
      businessError("jetkvm_session_connect"),
    );
    const routed = Promise.withResolvers<void>();
    const value = await startAdapter({
      handlerRegistry: completeRegistry({ jetkvm_session_connect: handler }),
      onDiagnostic: (event) => {
        if (event.code === "post_routed") routed.resolve();
      },
    });
    const stream = await openSse(value.baseUrl);
    const port = Number(new URL(value.baseUrl).port);
    const socket = await connectRaw(port);
    socket.write(
      [
        `POST ${stream.endpoint} HTTP/1.1`,
        ...Object.entries(authorizedHeaders()).map(
          ([name, headerValue]) => `${name}: ${headerValue}`,
        ),
        "Content-Type: application/json",
        `Content-Length: ${MCP_TRANSPORT_MAX_REQUEST_BYTES}`,
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n"),
    );
    socket.write(" ");
    await routed.promise;

    const socketClosed = waitForSocketClose(socket, 500);
    const firstClose = value.adapter.close();
    const secondClose = value.adapter.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    await socketClosed;
    expect(socket.destroyed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(() => value.adapter.createHttpServer()).toThrowError(
      /closed legacy SSE adapter/i,
    );
    stream.response.destroy();
  });

  it.each([
    ["transport", "abort"],
    ["transport", "transport_closed diagnostic"],
    ["adapter", "abort"],
  ] as const)(
    "awaits stream retirement when %s close cleanup reenters from the %s hook",
    async (closeSource, reentrySource) => {
      const entered = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      let value: RunningAdapter;
      let reentrantClose: Promise<void> | undefined;
      const handler = vi.fn(
        async (
          _input: unknown,
          context: { signal: AbortSignal },
        ): Promise<CallToolResult> => {
          entered.resolve();
          const onAbort = () => {
            if (reentrySource === "abort") {
              reentrantClose = value.adapter.close();
            }
            aborted.resolve();
          };
          if (context.signal.aborted) {
            onAbort();
          } else {
            const signalAborted = Promise.withResolvers<void>();
            context.signal.addEventListener(
              "abort",
              () => {
                onAbort();
                signalAborted.resolve();
              },
              { once: true },
            );
            await signalAborted.promise;
          }
          await cleanup.promise;
          return businessError("jetkvm_session_connect");
        },
      );
      value = await startAdapter({
        handlerRegistry: completeRegistry({ jetkvm_session_connect: handler }),
        onDiagnostic: (event) => {
          if (
            reentrySource === "transport_closed diagnostic" &&
            event.code === "transport_closed"
          ) {
            reentrantClose = value.adapter.close();
          }
        },
      });
      const stream = await openSse(value.baseUrl);
      const initialized = await post(
        value.baseUrl,
        stream.endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "retiring-close-test", version: "1.0.0" },
          },
        }),
      );
      expect(initialized.status).toBe(202);
      await stream.nextFrame();
      const called = await post(
        value.baseUrl,
        stream.endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "jetkvm_session_connect",
            arguments: { request_id: "retiring-close", timeout_ms: 60_000 },
          },
        }),
      );
      expect(called.status).toBe(202);
      await entered.promise;

      const initiatingClose =
        closeSource === "adapter"
          ? value.adapter.close()
          : (stream.response.destroy(), undefined);
      await aborted.promise;
      expect(reentrantClose).toBeDefined();
      expect(value.adapter.close()).toBe(reentrantClose);
      if (initiatingClose !== undefined) {
        expect(reentrantClose).toBe(initiatingClose);
      }
      let closeSettled = false;
      void reentrantClose!.then(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSettled).toBe(false);

      cleanup.resolve();
      await reentrantClose;
      expect(closeSettled).toBe(true);
    },
  );

  it("settles transport retirement when its diagnostic hook throws", async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const diagnosed = Promise.withResolvers<void>();
    let value: RunningAdapter;
    let stream: OpenSse | undefined;
    let reentrantClose: Promise<void> | undefined;
    const handler = vi.fn(
      async (
        _input: unknown,
        context: { signal: AbortSignal },
      ): Promise<CallToolResult> => {
        entered.resolve();
        if (!context.signal.aborted) {
          const signalAborted = Promise.withResolvers<void>();
          context.signal.addEventListener(
            "abort",
            () => signalAborted.resolve(),
            { once: true },
          );
          await signalAborted.promise;
        }
        aborted.resolve();
        await cleanup.promise;
        return businessError("jetkvm_session_connect");
      },
    );
    value = await startAdapter({
      handlerRegistry: completeRegistry({ jetkvm_session_connect: handler }),
      onDiagnostic: (event) => {
        if (event.code !== "transport_closed") return;
        reentrantClose = value.adapter.close();
        diagnosed.resolve();
        throw new Error("hostile transport diagnostic");
      },
    });
    running.splice(running.indexOf(value), 1);

    try {
      stream = await openSse(value.baseUrl);
      const initialized = await post(
        value.baseUrl,
        stream.endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: {
              name: "hostile-diagnostic-test",
              version: "1.0.0",
            },
          },
        }),
      );
      expect(initialized.status).toBe(202);
      await stream.nextFrame();
      const called = await post(
        value.baseUrl,
        stream.endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "jetkvm_session_connect",
            arguments: {
              request_id: "hostile-diagnostic",
              timeout_ms: 60_000,
            },
          },
        }),
      );
      expect(called.status).toBe(202);
      await entered.promise;

      stream.response.destroy();
      await Promise.all([aborted.promise, diagnosed.promise]);
      expect(reentrantClose).toBeDefined();
      let closeSettled = false;
      void reentrantClose!.then(() => {
        closeSettled = true;
      });
      cleanup.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSettled).toBe(true);
      await expect(reentrantClose).resolves.toBeUndefined();
    } finally {
      cleanup.resolve();
      stream?.response.destroy();
      value.targetSecret.dispose();
      value.credential.secret.dispose();
      await closeServer(value.server);
    }
  });

  it.each(["throws synchronously", "rejects"] as const)(
    "reports and settles a retirement when server close %s",
    async (failureMode) => {
      const closeError = new Error(`test server close ${failureMode}`);
      replaceNextMcpServerClose(
        failureMode === "throws synchronously"
          ? () => {
              throw closeError;
            }
          : () => Promise.reject(closeError),
      );
      const diagnostics: string[] = [];
      let value: RunningAdapter;
      let reentrantClose: Promise<void> | undefined;
      const diagnosed = Promise.withResolvers<void>();
      value = await startAdapter({
        onDiagnostic: (event) => {
          diagnostics.push(event.code);
          if (event.code !== "unexpected_error") return;
          reentrantClose = value.adapter.close();
          diagnosed.resolve();
        },
      });
      const stream = await openSse(value.baseUrl);

      stream.response.destroy();
      await diagnosed.promise;
      expect(reentrantClose).toBeDefined();
      await expect(reentrantClose).resolves.toBeUndefined();
      expect(value.adapter.close()).toBe(reentrantClose);
      expect(diagnostics.filter((code) => code === "unexpected_error")).toEqual(
        ["unexpected_error"],
      );
    },
  );

  it("rejects a declared body larger than 2 MiB without dispatch", async () => {
    const handler = vi.fn(async (_input: unknown) =>
      businessError("jetkvm_session_connect"),
    );
    const { baseUrl } = await startAdapter({
      handlerRegistry: completeRegistry({ jetkvm_session_connect: handler }),
    });
    const stream = await openSse(baseUrl);

    const response = await testFetch(`${baseUrl}${stream.endpoint}`, {
      method: "POST",
      headers: {
        ...authorizedHeaders(),
        "Content-Type": "application/json",
        "Content-Length": String(MCP_TRANSPORT_MAX_REQUEST_BYTES + 1),
      },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Request body too large");
    expect(response.headers.connection).toBe("close");
    expect(handler).not.toHaveBeenCalled();
    stream.response.destroy();
  });

  it("preserves exactly one SDK inactive-stream 500 during an in-flight disconnect", async () => {
    const routed = Promise.withResolvers<void>();
    const streamClosed = Promise.withResolvers<void>();
    const { baseUrl } = await startAdapter({
      onDiagnostic: (event) => {
        if (event.code === "post_routed") routed.resolve();
        if (event.code === "transport_closed") streamClosed.resolve();
      },
    });
    const stream = await openSse(baseUrl);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const url = new URL(`${baseUrl}${stream.endpoint}`);
    const responseReady = Promise.withResolvers<IncomingMessage>();
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        ...authorizedHeaders(),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    });
    request.once("response", responseReady.resolve);
    request.once("error", responseReady.reject);
    request.write(body.slice(0, 1));
    await routed.promise;
    stream.response.destroy();
    await streamClosed.promise;
    request.end(body.slice(1));

    const response = await responseReady.promise;
    response.setEncoding("utf8");
    let received = "";
    for await (const chunk of response) received += chunk;

    expect(response.statusCode).toBe(500);
    expect(received).toBe("SSE connection not established");
  });

  it("makes duplicate stream close and server shutdown idempotent", async () => {
    const value = await startAdapter();
    const first = await openSse(value.baseUrl);
    const second = await openSse(value.baseUrl);

    first.response.destroy();
    first.response.destroy();
    await value.adapter.close();
    await value.adapter.close();

    const firstClosed = await post(value.baseUrl, first.endpoint, "{}");
    const secondClosed = await post(value.baseUrl, second.endpoint, "{}");
    expect(firstClosed.status).toBe(404);
    expect(secondClosed.status).toBe(404);
  });

  it("rejects new streams after shutdown without reviving routing state", async () => {
    const value = await startAdapter();
    await value.adapter.close();

    const response = await testFetch(`${value.baseUrl}/sse`, {
      headers: authorizedHeaders(),
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Service Unavailable");
  });

  it("maps transport allocation failures to one safe 500 and still closes idempotently", async () => {
    const { adapter, baseUrl } = await startAdapter({
      transportFactory: () => {
        throw new Error("test transport allocation failure");
      },
    });

    const response = await testFetch(`${baseUrl}/sse`, {
      headers: authorizedHeaders(),
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    await adapter.close();
    await adapter.close();
  });

  it("returns 404 for unknown routes and 405 for unsupported methods", async () => {
    const { baseUrl } = await startAdapter();

    const unknown = await testFetch(`${baseUrl}/stream`, {
      headers: authorizedHeaders(),
    });
    const wrongMethod = await testFetch(`${baseUrl}/sse`, {
      method: "POST",
      headers: { ...authorizedHeaders(), "Content-Type": "application/json" },
      body: "{}",
    });

    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("Not Found");
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.text()).toBe("Method Not Allowed");
  });
});

const PHASE_5_SSE_SUITE = "Phase 5 shared SSE focused assertion matrix";
const PHASE_5_SSE_RESULTS: FocusedAssertionExecutionResult[] = [];
const PHASE_5_SSE_CELLS = TOOL_BEHAVIOR_MATRIX.flatMap((row) =>
  JETKVM_TOOL_NAMES.flatMap((tool) => {
    const cell = row.cells[tool];
    return cell.applicability === "applicable" &&
      cell.focused_assertion_owner_phase === "phase_5"
      ? [
          {
            tool,
            requirement: row.requirement,
            focusedAssertionId: cell.focused_assertion_id,
          },
        ]
      : [];
  }),
);

function phase5ValidInput(tool: JetKvmToolName): Record<string, unknown> {
  const session = {
    session_id: "session-1",
    session_generation: 1,
    timeout_ms: 1_000,
  };
  switch (tool) {
    case "jetkvm_session_connect":
      return { request_id: "request-1", timeout_ms: 1_000 };
    case "jetkvm_session_reconnect":
      return { ...session, request_id: "request-1" };
    case "jetkvm_session_status":
    case "jetkvm_display_capture":
    case "jetkvm_display_status":
      return session;
    case "jetkvm_input_mouse":
      return {
        ...session,
        observation_id: "observation-1",
        request_id: "request-1",
        actions: [{ type: "scroll", x: 0, y: 0, delta_y: -1 }],
      };
    case "jetkvm_input_keyboard":
      return {
        ...session,
        observation_id: "observation-1",
        request_id: "request-1",
        actions: [{ type: "chord", keys: ["ControlLeft", "KeyC"] }],
      };
    case "jetkvm_input_paste":
      return {
        ...session,
        observation_id: "observation-1",
        request_id: "request-1",
        text: "phase-five",
      };
    case "jetkvm_input_release":
      return { ...session, request_id: "request-1" };
    case "jetkvm_power_control":
      return { ...session, request_id: "request-1", action: "press_power" };
  }
}

async function phase5Rpc(
  baseUrl: string,
  stream: OpenSse,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<string> {
  const response = await post(
    baseUrl,
    stream.endpoint,
    JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  );
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("Accepted");
  return stream.nextFrame();
}

async function initializePhase5Stream(
  baseUrl: string,
  stream: OpenSse,
  id: number,
): Promise<void> {
  const frame = await phase5Rpc(baseUrl, stream, id, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "phase-5-sse-matrix", version: "1.0.0" },
  });
  expect(frame).toContain(`"id":${String(id)}`);
}

async function assertPhase5RouteSecurity(tool: JetKvmToolName): Promise<void> {
  const handler = vi.fn(async () => businessError(tool));
  const transportFactory = vi.fn(
    (
      endpoint: string,
      response: ConstructorParameters<typeof SSEServerTransport>[1],
    ) => new SSEServerTransport(endpoint, response),
  );
  const value = await startAdapter({
    handlerRegistry: completeRegistry({
      [tool]: handler,
    } as Partial<Record<JetKvmToolName, JetKvmToolHandler>>),
    transportFactory,
  });
  const missingHeaders = authorizedHeaders();
  delete missingHeaders.Authorization;
  const missingGet = await testFetch(`${value.baseUrl}/sse`, {
    headers: missingHeaders,
  });
  const missingPost = await post(
    value.baseUrl,
    "/messages?sessionId=00000000-0000-4000-8000-000000000000",
    "{}",
    missingHeaders,
  );
  const forbiddenGet = await testFetch(`${value.baseUrl}/sse`, {
    headers: { ...authorizedHeaders(), Host: "attacker.example.test" },
  });
  const forbiddenPost = await post(
    value.baseUrl,
    "/messages?sessionId=00000000-0000-4000-8000-000000000000",
    "{}",
    { ...authorizedHeaders(), Origin: "https://attacker.example.test" },
  );

  expect([missingGet.status, missingPost.status]).toEqual([401, 401]);
  expect([await missingGet.text(), await missingPost.text()]).toEqual([
    "Unauthorized",
    "Unauthorized",
  ]);
  expect([forbiddenGet.status, forbiddenPost.status]).toEqual([403, 403]);
  expect([await forbiddenGet.text(), await forbiddenPost.text()]).toEqual([
    "Forbidden",
    "Forbidden",
  ]);
  expect(transportFactory).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
}

async function assertPhase5RoutingClose(tool: JetKvmToolName): Promise<void> {
  let callCount = 0;
  const handler = vi.fn(async () => {
    callCount += 1;
    return businessError(tool, `phase-5-${tool}-${String(callCount)}`);
  });
  const firstClosed = Promise.withResolvers<void>();
  const value = await startAdapter({
    handlerRegistry: completeRegistry({
      [tool]: handler,
    } as Partial<Record<JetKvmToolName, JetKvmToolHandler>>),
    onDiagnostic: (event) => {
      if (event.code === "transport_closed") firstClosed.resolve();
    },
  });
  const first = await openSse(value.baseUrl);
  const second = await openSse(value.baseUrl);
  await initializePhase5Stream(value.baseUrl, first, 1);
  await initializePhase5Stream(value.baseUrl, second, 2);

  const call = (stream: OpenSse, id: number): Promise<string> =>
    phase5Rpc(value.baseUrl, stream, id, "tools/call", {
      name: tool,
      arguments: phase5ValidInput(tool),
    });
  expect(await call(first, 3)).toContain(`phase-5-${tool}-1`);
  expect(await call(second, 4)).toContain(`phase-5-${tool}-2`);

  first.response.destroy();
  await firstClosed.promise;
  const retired = await post(value.baseUrl, first.endpoint, "{}");
  expect(retired.status).toBe(404);
  expect(await retired.text()).toBe("Not Found");
  expect(await call(second, 5)).toContain(`phase-5-${tool}-3`);
  expect(handler).toHaveBeenCalledTimes(3);
  second.response.destroy();
}

describe(PHASE_5_SSE_SUITE, () => {
  for (const cell of PHASE_5_SSE_CELLS) {
    const testName = `${cell.tool} ${cell.requirement}`;
    const identity = `${PHASE_5_SSE_SUITE} > ${testName}`;
    it(
      testName,
      {
        meta: {
          focused_assertion_ids: [cell.focusedAssertionId],
          focused_test_identity: identity,
        },
      },
      async () => {
        try {
          if (cell.requirement === "branch:sse-route-security") {
            await assertPhase5RouteSecurity(cell.tool);
          } else if (cell.requirement === "branch:sse-routing-close") {
            await assertPhase5RoutingClose(cell.tool);
          } else {
            throw new Error(
              `Unexpected Phase 5 requirement ${cell.requirement}`,
            );
          }
          PHASE_5_SSE_RESULTS.push({
            focused_assertion_id: cell.focusedAssertionId,
            test_identity: identity,
            result: "pass",
          });
        } catch (error) {
          PHASE_5_SSE_RESULTS.push({
            focused_assertion_id: cell.focusedAssertionId,
            test_identity: identity,
            result: "fail",
          });
          throw error;
        }
      },
    );
  }

  afterAll(() => {
    expect(PHASE_5_SSE_CELLS).toHaveLength(20);
    validateFocusedAssertionExecutions("phase_5", PHASE_5_SSE_RESULTS);
  });
});

const PHASE_5_STORY_CONTRACT_SUITE = "Phase 5 supplemental story contracts";

describe(PHASE_5_STORY_CONTRACT_SUITE, () => {
  const testName = "transport reconnect preserves application session";
  const identity = `${PHASE_5_STORY_CONTRACT_SUITE} > ${testName}`;
  it(
    testName,
    {
      meta: {
        story_contract_ids: ["contract:transport-session-independence"],
        story_test_identity: identity,
      },
    },
    async () => {
      let logicalSession: string | null = null;
      const connectHandler = vi.fn(async () => {
        logicalSession = "application-session-1";
        return businessError("jetkvm_session_connect", "transport-connect");
      });
      const statusHandler = vi.fn(async () => {
        expect(logicalSession).toBe("application-session-1");
        return businessError("jetkvm_session_status", "transport-status");
      });
      const firstClosed = Promise.withResolvers<void>();
      const value = await startAdapter({
        handlerRegistry: completeRegistry({
          jetkvm_session_connect: connectHandler,
          jetkvm_session_status: statusHandler,
        }),
        onDiagnostic: (event) => {
          if (event.code === "transport_closed") firstClosed.resolve();
        },
      });
      const first = await openSse(value.baseUrl);
      await initializePhase5Stream(value.baseUrl, first, 1);
      expect(
        await phase5Rpc(value.baseUrl, first, 2, "tools/call", {
          name: "jetkvm_session_connect",
          arguments: phase5ValidInput("jetkvm_session_connect"),
        }),
      ).toContain("transport-connect");
      first.response.destroy();
      await firstClosed.promise;

      const replacement = await openSse(value.baseUrl);
      await initializePhase5Stream(value.baseUrl, replacement, 3);
      expect(
        await phase5Rpc(value.baseUrl, replacement, 4, "tools/call", {
          name: "jetkvm_session_status",
          arguments: phase5ValidInput("jetkvm_session_status"),
        }),
      ).toContain("transport-status");
      expect(connectHandler).toHaveBeenCalledOnce();
      expect(statusHandler).toHaveBeenCalledOnce();
      replacement.response.destroy();
    },
  );
});
