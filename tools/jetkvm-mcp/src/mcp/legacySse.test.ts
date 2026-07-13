import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DisposableSecret,
  type LegacySseBearerCredential,
} from "../browser/auth.js";
import { parseLegacySsePolicy, type LegacySseConfigInput } from "../config.js";
import { JETKVM_TOOL_NAMES, type JetKvmToolName } from "../domain.js";
import type {
  HandlerRegistry,
  JetKvmHandlerContext,
  JetKvmToolHandler,
} from "./server.js";
import { LegacySseAdapter, type LegacySseAdapterOptions } from "./legacySse.js";

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
  readonly credential: LegacySseBearerCredential;
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
  const credential = {
    principalId: PRINCIPAL,
    secret: DisposableSecret.fromUtf8(TOKEN),
  } satisfies LegacySseBearerCredential;
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
  const server = createServer((request, response) => {
    void adapter.handleRequest(request, response);
  });
  adapter.attachServer(server);
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
  };
  running.push(value);
  return value;
}

async function closeRunning(value: RunningAdapter): Promise<void> {
  await value.adapter.close();
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
  readonly body?: string;
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
    expect(context.principalId).toBe(PRINCIPAL);
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
    ["HTTPS policy on plaintext", { scheme: "https" as const }, "0.0.0.0"],
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

  it("fails closed if attached listener deadlines are weakened", async () => {
    const authenticateBearer = vi.fn(() => ({ principalId: PRINCIPAL }));
    const transportFactory = vi.fn(
      (
        endpoint: string,
        response: ConstructorParameters<typeof SSEServerTransport>[1],
      ) => new SSEServerTransport(endpoint, response),
    );
    const value = await startAdapter({
      authenticateBearer,
      transportFactory,
    });
    value.server.headersTimeout = 0;

    const response = await testFetch(`${value.baseUrl}/sse`, {
      headers: authorizedHeaders(),
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    expect(authenticateBearer).not.toHaveBeenCalled();
    expect(transportFactory).not.toHaveBeenCalled();
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
    let transport: SSEServerTransport | undefined;
    const streamClosed = Promise.withResolvers<void>();
    const { baseUrl } = await startAdapter({
      policy: {
        maxResponseBufferedBytes: 1_048_576,
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

    vi.useFakeTimers();
    try {
      const sends = Array.from({ length: 12 }, (_, index) =>
        transport!.send({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { data: `${index}:${"x".repeat(60_000)}` },
        }),
      );
      await Promise.all(sends);
      await vi.advanceTimersByTimeAsync(20);
      await streamClosed.promise;
    } finally {
      vi.useRealTimers();
    }

    await expect(
      transport!.send({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { data: "after-deadline" },
      }),
    ).rejects.toThrow("Not connected");
    stream.response.destroy();
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

  it("rejects a body larger than 1 MiB without dispatch", async () => {
    const handler = vi.fn(async (_input: unknown) =>
      businessError("jetkvm_session_connect"),
    );
    const { baseUrl } = await startAdapter({
      handlerRegistry: completeRegistry({ jetkvm_session_connect: handler }),
    });
    const stream = await openSse(baseUrl);

    const response = await post(
      baseUrl,
      stream.endpoint,
      `"${"x".repeat(1_048_576)}"`,
    );

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
