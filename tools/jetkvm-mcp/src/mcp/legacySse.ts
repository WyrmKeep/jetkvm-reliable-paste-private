import type { IncomingMessage, ServerResponse } from "node:http";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  evaluateLegacySseRequest,
  HttpBoundaryError,
  type LegacySseBearerCredential,
  type LegacySsePrincipal,
  type LegacySseRequestHeaders,
} from "../browser/auth.js";
import type { LegacySseSecurityPolicy } from "../config.js";
import { createMcpServer, type HandlerRegistry } from "./server.js";

const MAXIMUM_BODY_BYTES = 1_048_576;
const DEFAULT_SESSION_TTL_MS = 300_000;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LegacySseDiagnostic {
  readonly code:
    | "post_routed"
    | "transport_closed"
    | "post_transport_closed"
    | "unexpected_error";
}

export type LegacySseTransportFactory = (
  endpoint: string,
  response: ServerResponse,
) => SSEServerTransport;

export interface LegacySseAdapterOptions {
  readonly handlerRegistry?: HandlerRegistry;
  readonly securityPolicy: LegacySseSecurityPolicy;
  readonly bearerCredential?: LegacySseBearerCredential;
  readonly authorizeRequest?: (
    request: LegacySseRequestHeaders,
  ) => LegacySsePrincipal;
  readonly transportFactory?: LegacySseTransportFactory;
  readonly sessionTtlMs?: number;
  readonly now?: () => number;
  readonly onDiagnostic?: (event: LegacySseDiagnostic) => void;
}

interface RoutingEntry {
  readonly principalId: string;
  readonly transport: SSEServerTransport;
  readonly server: Server;
  expiresAt: number;
}

interface AuthenticatedIncomingMessage extends IncomingMessage {
  auth?: AuthInfo;
}

interface ReadBodyResult {
  readonly tooLarge: boolean;
  readonly text: string;
}

export class LegacySseAdapter {
  readonly #handlerRegistry: HandlerRegistry;
  readonly #securityPolicy: LegacySseSecurityPolicy;
  readonly #bearerCredential: LegacySseBearerCredential | undefined;
  readonly #authorizeRequest: (
    request: LegacySseRequestHeaders,
  ) => LegacySsePrincipal;
  readonly #transportFactory: LegacySseTransportFactory;
  readonly #sessionTtlMs: number;
  readonly #now: () => number;
  readonly #onDiagnostic: ((event: LegacySseDiagnostic) => void) | undefined;
  readonly #entries = new Map<string, RoutingEntry>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: LegacySseAdapterOptions) {
    if (
      options.sessionTtlMs !== undefined &&
      (!Number.isSafeInteger(options.sessionTtlMs) || options.sessionTtlMs <= 0)
    ) {
      throw new Error("Legacy SSE session TTL must be a positive integer");
    }
    this.#handlerRegistry = options.handlerRegistry ?? {};
    this.#securityPolicy = options.securityPolicy;
    this.#bearerCredential = options.bearerCredential;
    this.#authorizeRequest =
      options.authorizeRequest ??
      ((request) =>
        evaluateLegacySseRequest(
          request,
          this.#securityPolicy,
          this.#bearerCredential,
        ));
    this.#transportFactory =
      options.transportFactory ??
      ((endpoint, response) => new SSEServerTransport(endpoint, response));
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#onDiagnostic = options.onDiagnostic;
  }

  async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://mcp.invalid");
      const isSseRoute = url.pathname === "/sse";
      const isMessagesRoute = url.pathname === "/messages";
      if (!isSseRoute && !isMessagesRoute) {
        sendText(response, 404, "Not Found");
        return;
      }

      const expectedMethod = isSseRoute ? "GET" : "POST";
      const principal = this.#authorize(request, expectedMethod, response);
      if (principal === undefined) return;
      if (request.method !== expectedMethod) {
        sendText(response, 405, "Method Not Allowed");
        return;
      }

      if (isSseRoute) {
        if (this.#closed) {
          sendText(response, 503, "Service Unavailable");
          return;
        }
        await this.#openStream(response, principal);
        return;
      }
      await this.#handlePost(request, response, url, principal);
    } catch {
      this.#onDiagnostic?.({ code: "unexpected_error" });
      if (!response.headersSent && !response.writableEnded) {
        sendText(response, 500, "Internal Server Error");
      }
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  #authorize(
    request: IncomingMessage,
    method: "GET" | "POST",
    response: ServerResponse,
  ): LegacySsePrincipal | undefined {
    try {
      const host = singleHeader(request, "host");
      const origin = singleHeader(request, "origin");
      const authorization = singleHeader(request, "authorization");
      const antiCsrf = singleHeader(request, "x-jetkvm-csrf");
      return this.#authorizeRequest({
        method,
        ...(host === undefined ? {} : { host }),
        ...(origin === undefined ? {} : { origin }),
        ...(authorization === undefined ? {} : { authorization }),
        ...(antiCsrf === undefined ? {} : { antiCsrf }),
      });
    } catch (error) {
      if (error instanceof HttpBoundaryError) {
        sendText(
          response,
          error.statusCode,
          error.statusCode === 401 ? "Unauthorized" : "Forbidden",
        );
        return undefined;
      }
      throw error;
    }
  }

  async #openStream(
    response: ServerResponse,
    principal: LegacySsePrincipal,
  ): Promise<void> {
    const transport = this.#transportFactory("/messages", response);
    const server = createMcpServer(this.#handlerRegistry);
    const entry: RoutingEntry = {
      principalId: principal.principalId,
      transport,
      server,
      expiresAt: this.#now() + this.#sessionTtlMs,
    };
    const sessionId = transport.sessionId;
    transport.onclose = () => {
      if (this.#entries.get(sessionId) !== entry) return;
      this.#entries.delete(sessionId);
      this.#onDiagnostic?.({ code: "transport_closed" });
    };
    this.#entries.set(sessionId, entry);

    try {
      await server.connect(transport);
    } catch (error) {
      if (this.#entries.get(sessionId) === entry)
        this.#entries.delete(sessionId);
      await transport.close();
      throw error;
    }
  }

  async #handlePost(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    principal: LegacySsePrincipal,
  ): Promise<void> {
    const sessionIds = url.searchParams.getAll("sessionId");
    if (sessionIds.length !== 1 || !SESSION_ID.test(sessionIds[0] ?? "")) {
      sendText(response, 400, "Bad Request");
      return;
    }
    const sessionId = sessionIds[0];
    if (sessionId === undefined) {
      sendText(response, 400, "Bad Request");
      return;
    }

    const entry = this.#entries.get(sessionId);
    if (entry === undefined || entry.principalId !== principal.principalId) {
      sendText(response, 404, "Not Found");
      return;
    }
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(sessionId);
      sendText(response, 404, "Not Found");
      await entry.server.close();
      return;
    }
    this.#onDiagnostic?.({ code: "post_routed" });

    if (singleHeader(request, "content-type") !== "application/json") {
      sendText(response, 400, "Invalid Content-Type");
      return;
    }
    const declaredLength = parseContentLength(
      singleHeader(request, "content-length"),
    );
    if (declaredLength !== undefined && declaredLength > MAXIMUM_BODY_BYTES) {
      request.resume();
      sendText(response, 400, "Request body too large");
      return;
    }

    const body = await readBody(request);
    if (body.tooLarge) {
      sendText(response, 400, "Request body too large");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      sendText(response, 400, "Invalid JSON");
      return;
    }
    const message = JSONRPCMessageSchema.safeParse(parsed);
    if (!message.success) {
      sendText(response, 400, "Invalid JSON-RPC message");
      return;
    }

    const authenticatedRequest = request as AuthenticatedIncomingMessage;
    authenticatedRequest.auth = {
      token: "[REDACTED]",
      clientId: principal.principalId,
      scopes: ["mcp"],
    };
    try {
      await entry.transport.handlePostMessage(
        authenticatedRequest,
        response,
        message.data,
      );
      entry.expiresAt = this.#now() + this.#sessionTtlMs;
    } catch {
      this.#onDiagnostic?.({ code: "post_transport_closed" });
      if (!response.headersSent && !response.writableEnded) {
        sendText(response, 500, "Internal Server Error");
      }
    }
  }

  async #performClose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(async (entry) => entry.server.close()));
  }
}

function singleHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBody(request: IncomingMessage): Promise<ReadBodyResult> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAXIMUM_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(bytes);
  }
  return {
    tooLarge,
    text: tooLarge ? "" : Buffer.concat(chunks, byteLength).toString("utf8"),
  };
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}
