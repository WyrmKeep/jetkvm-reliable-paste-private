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

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateIndependentLegacySseBearerCredential,
  DisposableSecret,
  type IndependentLegacySseBearerCredential,
} from "../browser/auth.js";
import { parseLegacySsePolicy, type LegacySseConfigInput } from "../config.js";
import { JETKVM_TOOL_NAMES, type JetKvmToolName } from "../domain.js";
import type {
  HandlerRegistry,
  JetKvmHandlerContext,
  JetKvmToolHandler,
} from "./server.js";
import {
  installBoundedSseWriter,
  LegacySseAdapter,
  type LegacySseAdapterOptions,
} from "./legacySse.js";

const AUTHORITY = "mcp.example.test";
const ORIGIN = "https://client.example.test";
const TOKEN = "test-only-bearer";
const PRINCIPAL = "operator-a";

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
    ...(body.length === 0 || init.headers?.["Content-Length"] !== undefined
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

afterEach(async () => {
  await Promise.all(running.splice(0).map(closeRunning));
});

describe("legacy SSE adapter", () => {
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
    expect(value.server.headersTimeout).toBe(10_000);
    expect(value.server.requestTimeout).toBe(30_000);
    expect(value.server.keepAliveTimeout).toBe(5_000);
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
      const socket = await connectRaw(port);
      socket.write("GET /sse HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      await waitForSocketClose(socket, 500);
    } finally {
      await adapter.close();
      await closeServer(server);
    }
  });

  it("expires incomplete TLS handshakes no later than the header bound", async () => {
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
      await waitForSocketClose(socket, 500);
    } finally {
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
    expect(authenticateBearer).toHaveBeenCalledTimes(2);
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
    const streamClosed = Promise.withResolvers<void>();
    const { baseUrl } = await startAdapter({
      policy: {
        maxResponseMessageBytes: 262_144,
        maxResponseBufferedBytes: 262_144,
        responseBackpressureTimeoutMs: 20,
      },
      transportFactory: (endpoint, response) => {
        transport = new SSEServerTransport(endpoint, response);
        return transport;
      },
      onDiagnostic: (event) => {
        if (event.code === "transport_closed") streamClosed.resolve();
      },
    });
    const stream = await openSse(baseUrl);
    stream.response.pause();

    await transport!.send({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { data: "x".repeat(300_000) },
    });
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

  it("rejects a body larger than 1 MiB without dispatch", async () => {
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
        "Content-Length": String(1_048_577),
      },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Request body too large");
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
