import { createHash } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type CancelledNotification,
} from "@modelcontextprotocol/sdk/types.js";

import { JETKVM_TOOL_NAMES, type JetKvmToolName } from "../domain.js";
import { validateAndMapMcpResult } from "./results.js";
import { GENERATED_JSON_SCHEMA_DOCUMENTS } from "./schemas.js";
import { TOOL_CATALOGUE, TOOL_CATALOGUE_BY_NAME } from "./toolCatalogue.js";

export type JetKvmHandlerContext = Readonly<{
  signal: AbortSignal;
  principalId: string | null;
  correlationId: string;
}>;

export const MCP_SERVER_BUSY_ERROR_CODE = -32_002;
export const TOOL_HANDLER_GLOBAL_CAPACITY = 8;
export const TOOL_HANDLER_PER_PRINCIPAL_CAPACITY = 4;
export const TOOL_HANDLER_PER_SESSION_CAPACITY = 2;

class ServerBusyError extends Error {
  readonly code = MCP_SERVER_BUSY_ERROR_CODE;

  constructor() {
    super("Server busy");
    this.name = "ServerBusyError";
  }
}

class RequestCancelledError extends Error {
  readonly code = ErrorCode.ConnectionClosed;

  constructor() {
    super("Request cancelled");
    this.name = "RequestCancelledError";
  }
}

export type JetKvmToolHandler = (
  input: unknown,
  context: JetKvmHandlerContext,
) => CallToolResult | Promise<CallToolResult>;

export type HandlerRegistry = Readonly<
  Partial<Record<JetKvmToolName, JetKvmToolHandler>>
>;

export type CreateMcpServerOptions = Readonly<{
  admissionKey?: object;
  lifetimeSignal?: AbortSignal;
}>;

type AdmissionToken = {
  readonly principalKey: string;
  readonly sessionKey: string | null;
  released: boolean;
};

class ToolHandlerAdmission {
  #active = 0;
  readonly #byPrincipal = new Map<string, number>();
  readonly #bySession = new Map<string, number>();

  tryAcquire(
    principalKey: string,
    sessionKey: string | null,
  ): AdmissionToken | null {
    const principalCount = this.#byPrincipal.get(principalKey) ?? 0;
    const sessionCount =
      sessionKey === null ? 0 : (this.#bySession.get(sessionKey) ?? 0);
    if (
      this.#active >= TOOL_HANDLER_GLOBAL_CAPACITY ||
      principalCount >= TOOL_HANDLER_PER_PRINCIPAL_CAPACITY ||
      (sessionKey !== null && sessionCount >= TOOL_HANDLER_PER_SESSION_CAPACITY)
    ) {
      return null;
    }
    this.#active += 1;
    this.#byPrincipal.set(principalKey, principalCount + 1);
    if (sessionKey !== null) {
      this.#bySession.set(sessionKey, sessionCount + 1);
    }
    return { principalKey, sessionKey, released: false };
  }

  release(token: AdmissionToken): void {
    if (token.released) return;
    token.released = true;
    this.#active -= 1;
    const principalCount = this.#byPrincipal.get(token.principalKey);
    if (principalCount === 1) {
      this.#byPrincipal.delete(token.principalKey);
    } else if (principalCount !== undefined) {
      this.#byPrincipal.set(token.principalKey, principalCount - 1);
    }
    if (token.sessionKey === null) return;
    const sessionCount = this.#bySession.get(token.sessionKey);
    if (sessionCount === 1) {
      this.#bySession.delete(token.sessionKey);
    } else if (sessionCount !== undefined) {
      this.#bySession.set(token.sessionKey, sessionCount - 1);
    }
  }
}

const ADMISSION_BY_REGISTRY = new WeakMap<object, ToolHandlerAdmission>();

export function assertHandlerRegistry(handlerRegistry: HandlerRegistry): void {
  const registeredEntries = Object.entries(handlerRegistry);
  for (const [name, handler] of registeredEntries) {
    if (!Object.hasOwn(TOOL_CATALOGUE_BY_NAME, name)) {
      throw new Error(`Handler registry contains unknown tool: ${name}`);
    }
    if (typeof handler !== "function") {
      throw new Error(`Handler registry is missing canonical tool: ${name}`);
    }
  }
  if (
    registeredEntries.length !== 0 &&
    registeredEntries.length !== JETKVM_TOOL_NAMES.length
  ) {
    throw new Error(
      "Handler registry must be empty or contain all ten canonical tools",
    );
  }
}

export function createMcpServer(
  handlerRegistry: HandlerRegistry = {},
  options: CreateMcpServerOptions = {},
): Server {
  assertHandlerRegistry(handlerRegistry);
  const registeredEntries = Object.entries(handlerRegistry);
  const admissionKey = options.admissionKey ?? handlerRegistry;

  let admission = ADMISSION_BY_REGISTRY.get(admissionKey);
  if (admission === undefined) {
    admission = new ToolHandlerAdmission();
    ADMISSION_BY_REGISTRY.set(admissionKey, admission);
  }

  const server = new Server(
    { name: "jetkvm-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const lifetimeController = new AbortController();
  const activeInvocationControllers = new Set<AbortController>();
  const activeInvocationSettlements = new Set<Promise<void>>();
  const invocationControllersByRequestId = new Map<
    string,
    Set<AbortController>
  >();
  let closing = false;
  let drainPromise: Promise<void> | undefined;
  const detachExternalLifetime = () =>
    options.lifetimeSignal?.removeEventListener(
      "abort",
      onExternalLifetimeAbort,
    );
  const abortActiveInvocations = () => {
    if (!lifetimeController.signal.aborted) lifetimeController.abort();
    for (const controller of activeInvocationControllers) controller.abort();
    activeInvocationControllers.clear();
    invocationControllersByRequestId.clear();
  };
  const beginClosing = (): Promise<void> => {
    if (drainPromise !== undefined) return drainPromise;
    closing = true;
    detachExternalLifetime();
    abortActiveInvocations();
    drainPromise = Promise.all([...activeInvocationSettlements]).then(
      () => undefined,
    );
    return drainPromise;
  };
  const onExternalLifetimeAbort = () => {
    void beginClosing();
  };
  if (options.lifetimeSignal?.aborted) {
    void beginClosing();
  } else {
    options.lifetimeSignal?.addEventListener("abort", onExternalLifetimeAbort, {
      once: true,
    });
  }
  let downstreamCloseHandler: (() => void) | undefined;
  let downstreamCloseDispatched = false;
  const lifetimeCloseHandler = () => {
    void beginClosing().then(() => {
      if (downstreamCloseDispatched) return;
      downstreamCloseDispatched = true;
      downstreamCloseHandler?.();
    });
  };
  Object.defineProperty(server, "onclose", {
    configurable: true,
    get: () => lifetimeCloseHandler,
    set: (handler: (() => void) | undefined) => {
      if (handler !== lifetimeCloseHandler) downstreamCloseHandler = handler;
    },
  });
  const sdkClose = server.close.bind(server);
  let serverClosePromise: Promise<void> | undefined;
  server.close = () => {
    if (serverClosePromise !== undefined) return serverClosePromise;
    const drain = beginClosing();
    serverClosePromise = (async () => {
      await sdkClose();
      await drain;
    })();
    return serverClosePromise;
  };

  const sdkOnCancel = Reflect.get(server, "_oncancel");
  if (typeof sdkOnCancel !== "function") {
    throw new Error("Installed MCP SDK is missing cancellation dispatch.");
  }
  Reflect.set(server, "_oncancel", (notification: CancelledNotification) => {
    const requestId = notification.params.requestId;
    if (requestId !== undefined) {
      const requestKey = canonicalRequestId(requestId);
      for (const controller of invocationControllersByRequestId.get(
        requestKey,
      ) ?? []) {
        controller.abort();
      }
    }
    Reflect.apply(sdkOnCancel, server, [notification]);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools:
      registeredEntries.length === 0
        ? []
        : TOOL_CATALOGUE.map((entry) => ({
            name: entry.name,
            title: entry.title,
            description: entry.description,
            inputSchema:
              GENERATED_JSON_SCHEMA_DOCUMENTS[
                `${entry.name}.input.schema.json`
              ],
            outputSchema:
              GENERATED_JSON_SCHEMA_DOCUMENTS[
                `${entry.name}.result.schema.json`
              ],
          })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (closing || lifetimeController.signal.aborted || extra.signal.aborted) {
      throw new RequestCancelledError();
    }
    const name = request.params.name;
    if (!Object.hasOwn(TOOL_CATALOGUE_BY_NAME, name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    if (registeredEntries.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Tool is not active: ${name}`,
      );
    }

    const toolName = name as JetKvmToolName;
    const entry = TOOL_CATALOGUE_BY_NAME[toolName];
    const input = await entry.inputSchema.safeParseAsync(
      request.params.arguments ?? {},
    );
    if (closing || lifetimeController.signal.aborted || extra.signal.aborted) {
      throw new RequestCancelledError();
    }
    if (!input.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for ${name}`,
      );
    }
    const handler = handlerRegistry[toolName];
    if (typeof handler !== "function") {
      throw new McpError(
        ErrorCode.InternalError,
        `Handler is not active: ${name}`,
      );
    }
    if (closing || lifetimeController.signal.aborted || extra.signal.aborted) {
      throw new RequestCancelledError();
    }

    const principalId = sanitizedPrincipalId(extra.authInfo?.clientId);
    const requestKey = canonicalRequestId(extra.requestId);
    const duplicateControllers =
      invocationControllersByRequestId.get(requestKey);
    if (duplicateControllers !== undefined) {
      for (const controller of duplicateControllers) controller.abort();
      throw new ServerBusyError();
    }
    const token = admission.tryAcquire(
      principalId ?? "anonymous",
      sessionAdmissionKey(principalId, input.data),
    );
    if (token === null) {
      throw new ServerBusyError();
    }
    const invocationController = new AbortController();
    activeInvocationControllers.add(invocationController);
    invocationControllersByRequestId.set(
      requestKey,
      new Set([invocationController]),
    );
    const invocationSettlement = Promise.withResolvers<void>();
    activeInvocationSettlements.add(invocationSettlement.promise);
    try {
      const correlationSnapshot = createCallCorrelationSnapshot(
        toolName,
        input.data,
      );
      const context: JetKvmHandlerContext = Object.freeze({
        signal: AbortSignal.any([
          extra.signal,
          invocationController.signal,
          lifetimeController.signal,
        ]),
        principalId,
        correlationId: correlationIdFor(extra.requestId),
      });
      if (context.signal.aborted) throw new RequestCancelledError();
      let result: CallToolResult;
      try {
        result = await handler(input.data, context);
      } catch {
        if (context.signal.aborted) throw new RequestCancelledError();
        throw new McpError(
          ErrorCode.InternalError,
          `Tool handler failed for ${name}`,
        );
      }
      if (context.signal.aborted) throw new RequestCancelledError();
      try {
        const mapped = validateAndMapMcpResult(toolName, result);
        validateCallResultCorrelation(toolName, correlationSnapshot, mapped);
        return mapped;
      } catch {
        throw new McpError(
          ErrorCode.InternalError,
          `Invalid handler result for ${name}`,
        );
      }
    } finally {
      const requestControllers =
        invocationControllersByRequestId.get(requestKey);
      requestControllers?.delete(invocationController);
      if (requestControllers?.size === 0) {
        invocationControllersByRequestId.delete(requestKey);
      }
      activeInvocationControllers.delete(invocationController);
      if (!invocationController.signal.aborted) invocationController.abort();
      admission.release(token);
      activeInvocationSettlements.delete(invocationSettlement.promise);
      invocationSettlement.resolve();
    }
  });

  return server;
}

function sessionAdmissionKey(
  principalId: string | null,
  input: unknown,
): string | null {
  if (!isRecord(input) || typeof input.session_id !== "string") {
    return null;
  }
  return createHash("sha256")
    .update("jetkvm-mcp:handler-session:v2\u0000", "utf8")
    .update(principalId ?? "anonymous", "utf8")
    .update("\u0000", "utf8")
    .update(input.session_id, "utf8")
    .digest("hex");
}
function canonicalRequestId(requestId: string | number): string {
  const canonical =
    typeof requestId === "number"
      ? `number:${requestId}`
      : `string:${requestId}`;
  return createHash("sha256")
    .update("jetkvm-mcp:jsonrpc-request:v1\u0000", "utf8")
    .update(canonical, "utf8")
    .digest("hex");
}

function sanitizedPrincipalId(principalId: string | undefined): string | null {
  if (principalId === undefined) return null;
  const digest = createHash("sha256")
    .update("jetkvm-mcp:principal:v1\u0000", "utf8")
    .update(`${Buffer.byteLength(principalId, "utf8")}\u0000`, "utf8")
    .update(principalId, "utf8")
    .digest("hex");
  return `principal-${digest}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
type CallCorrelationSnapshot = Readonly<{
  sessionId: string | null;
  sessionGeneration: number | null;
  requestId: string | null;
  takeover: boolean | null;
  actionCount: number | null;
  captureFormat: "jpeg" | "png" | null;
  captureMaxWidth: number | null;
  captureMaxHeight: number | null;
  powerAction: "press_power" | "hold_power" | "press_reset" | null;
  pasteOriginalByteCount: number | null;
  pasteNormalizedByteCount: number | null;
  pasteNormalizedSha256: string | null;
}>;

const PASTE_PROGRESS_ERROR_CODES: Readonly<Record<string, true>> =
  Object.freeze({
    MUTATION_OUTCOME_UNKNOWN: true,
    PASTE_FAILED: true,
    PASTE_CANCELLED: true,
    EVENT_GAP: true,
  });

function createCallCorrelationSnapshot(
  tool: JetKvmToolName,
  input: unknown,
): CallCorrelationSnapshot {
  if (!isRecord(input)) {
    throw new Error("Invalid parsed call correlation input.");
  }
  let pasteOriginalByteCount: number | null = null;
  let pasteNormalizedByteCount: number | null = null;
  let pasteNormalizedSha256: string | null = null;
  if (tool === "jetkvm_input_paste") {
    if (typeof input.text !== "string") {
      throw new Error("Invalid parsed paste correlation input.");
    }
    const normalizedText = (
      input.text.startsWith("\uFEFF") ? input.text.slice(1) : input.text
    )
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .normalize("NFC");
    pasteOriginalByteCount = Buffer.byteLength(input.text, "utf8");
    pasteNormalizedByteCount = Buffer.byteLength(normalizedText, "utf8");
    pasteNormalizedSha256 = createHash("sha256")
      .update(normalizedText, "utf8")
      .digest("hex");
    if (
      pasteOriginalByteCount < 1 ||
      pasteNormalizedByteCount < 1 ||
      pasteNormalizedByteCount > 262_144
    ) {
      throw new Error("Invalid parsed paste correlation bounds.");
    }
  }

  return Object.freeze({
    sessionId: typeof input.session_id === "string" ? input.session_id : null,
    sessionGeneration:
      typeof input.session_generation === "number"
        ? input.session_generation
        : null,
    requestId: typeof input.request_id === "string" ? input.request_id : null,
    takeover: typeof input.takeover === "boolean" ? input.takeover : null,
    actionCount: Array.isArray(input.actions) ? input.actions.length : null,
    captureFormat:
      input.format === "jpeg" || input.format === "png" ? input.format : null,
    captureMaxWidth:
      typeof input.max_width === "number" ? input.max_width : null,
    captureMaxHeight:
      typeof input.max_height === "number" ? input.max_height : null,
    powerAction:
      input.action === "press_power" ||
      input.action === "hold_power" ||
      input.action === "press_reset"
        ? input.action
        : null,
    pasteOriginalByteCount,
    pasteNormalizedByteCount,
    pasteNormalizedSha256,
  });
}

type CaptureGeometryFacts = Readonly<{
  image: Record<string, unknown>;
  imageWidth: number;
  imageHeight: number;
}>;

function validateCaptureGeometry(capture: unknown): CaptureGeometryFacts {
  if (!isRecord(capture)) {
    throw new Error("Invalid handler result correlation.");
  }
  const image = capture.image;
  const geometry = capture.geometry;
  if (!isRecord(image) || !isRecord(geometry)) {
    throw new Error("Invalid handler result correlation.");
  }
  const sourceWidth = capture.source_width;
  const sourceHeight = capture.source_height;
  const imageWidth = capture.image_width;
  const imageHeight = capture.image_height;
  const rotation = capture.rotation;
  const contentX = geometry.content_x;
  const contentY = geometry.content_y;
  const contentWidth = geometry.content_width;
  const contentHeight = geometry.content_height;
  if (
    typeof sourceWidth !== "number" ||
    !Number.isSafeInteger(sourceWidth) ||
    sourceWidth < 1 ||
    sourceWidth > 1_920 ||
    typeof sourceHeight !== "number" ||
    !Number.isSafeInteger(sourceHeight) ||
    sourceHeight < 1 ||
    sourceHeight > 1_080 ||
    typeof imageWidth !== "number" ||
    !Number.isSafeInteger(imageWidth) ||
    imageWidth < 1 ||
    imageWidth > 1_920 ||
    typeof imageHeight !== "number" ||
    !Number.isSafeInteger(imageHeight) ||
    imageHeight < 1 ||
    imageHeight > 1_080 ||
    (rotation !== 0 &&
      rotation !== 90 &&
      rotation !== 180 &&
      rotation !== 270) ||
    typeof contentX !== "number" ||
    !Number.isSafeInteger(contentX) ||
    contentX < 0 ||
    typeof contentY !== "number" ||
    !Number.isSafeInteger(contentY) ||
    contentY < 0 ||
    typeof contentWidth !== "number" ||
    !Number.isSafeInteger(contentWidth) ||
    contentWidth < 1 ||
    contentWidth > 1_920 ||
    typeof contentHeight !== "number" ||
    !Number.isSafeInteger(contentHeight) ||
    contentHeight < 1 ||
    contentHeight > 1_080 ||
    (image.mime_type !== "image/jpeg" && image.mime_type !== "image/png")
  ) {
    throw new Error("Invalid handler result correlation.");
  }
  const rotatedSourceWidth =
    rotation === 90 || rotation === 270 ? sourceHeight : sourceWidth;
  const rotatedSourceHeight =
    rotation === 90 || rotation === 270 ? sourceWidth : sourceHeight;
  if (
    contentWidth > imageWidth ||
    contentHeight > imageHeight ||
    contentX > imageWidth - contentWidth ||
    contentY > imageHeight - contentHeight ||
    contentWidth > rotatedSourceWidth ||
    contentHeight > rotatedSourceHeight ||
    BigInt(contentWidth) * BigInt(rotatedSourceHeight) !==
      BigInt(contentHeight) * BigInt(rotatedSourceWidth)
  ) {
    throw new Error("Invalid handler result correlation.");
  }
  return Object.freeze({ image, imageWidth, imageHeight });
}

function validateCallResultCorrelation(
  tool: JetKvmToolName,
  snapshot: CallCorrelationSnapshot,
  mapped: CallToolResult,
): void {
  if (!isRecord(mapped.structuredContent)) {
    throw new Error("Invalid handler result correlation.");
  }
  const envelope = mapped.structuredContent;
  if (envelope.ok === true) {
    if (!isRecord(envelope.result)) {
      throw new Error("Invalid handler result correlation.");
    }
    const result = envelope.result;
    if (
      snapshot.requestId !== null &&
      result.request_id !== snapshot.requestId
    ) {
      throw new Error("Invalid handler result correlation.");
    }
    if (tool === "jetkvm_session_reconnect") {
      if (
        envelope.session_id !== snapshot.sessionId ||
        result.previous_session_generation !== snapshot.sessionGeneration ||
        typeof result.previous_session_generation !== "number" ||
        typeof result.new_session_generation !== "number" ||
        result.new_session_generation <= result.previous_session_generation ||
        envelope.session_generation !== result.new_session_generation
      ) {
        throw new Error("Invalid handler result correlation.");
      }
    } else if (
      tool !== "jetkvm_session_connect" &&
      (envelope.session_id !== snapshot.sessionId ||
        envelope.session_generation !== snapshot.sessionGeneration)
    ) {
      throw new Error("Invalid handler result correlation.");
    }
    if (
      (tool === "jetkvm_session_connect" ||
        tool === "jetkvm_session_reconnect") &&
      result.takeover_performed === true &&
      snapshot.takeover !== true
    ) {
      throw new Error("Invalid handler result correlation.");
    }

    if (tool === "jetkvm_input_paste") {
      if (
        snapshot.pasteOriginalByteCount === null ||
        snapshot.pasteNormalizedByteCount === null ||
        snapshot.pasteNormalizedSha256 === null ||
        result.original_byte_count !== snapshot.pasteOriginalByteCount ||
        result.normalized_byte_count !== snapshot.pasteNormalizedByteCount ||
        result.normalized_sha256 !== snapshot.pasteNormalizedSha256
      ) {
        throw new Error("Invalid handler result correlation.");
      }
    }
    if (
      tool === "jetkvm_power_control" &&
      result.action !== snapshot.powerAction
    ) {
      throw new Error("Invalid handler result correlation.");
    }
    if (tool === "jetkvm_display_capture") {
      const capture = validateCaptureGeometry(result);
      if (
        snapshot.captureFormat === null ||
        snapshot.captureMaxWidth === null ||
        snapshot.captureMaxHeight === null ||
        capture.image.mime_type !==
          (snapshot.captureFormat === "png" ? "image/png" : "image/jpeg") ||
        capture.imageWidth > snapshot.captureMaxWidth ||
        capture.imageHeight > snapshot.captureMaxHeight
      ) {
        throw new Error("Invalid handler result correlation.");
      }
    }
    if (
      (tool === "jetkvm_input_keyboard" ||
        tool === "jetkvm_input_mouse" ||
        tool === "jetkvm_input_paste") &&
      result.post_capture !== null
    ) {
      validateCaptureGeometry(result.post_capture);
    }
    if (
      (tool === "jetkvm_input_keyboard" || tool === "jetkvm_input_mouse") &&
      (snapshot.actionCount === null ||
        result.dispatched_action_count !== snapshot.actionCount ||
        result.completed_action_count !== snapshot.actionCount)
    ) {
      throw new Error("Invalid handler result correlation.");
    }
    return;
  }

  if (!isRecord(envelope.error)) {
    throw new Error("Invalid handler result correlation.");
  }
  const error = envelope.error;
  const errorDetails = error.details;
  if (!isRecord(errorDetails)) {
    throw new Error("Invalid handler result correlation.");
  }
  const details = errorDetails;
  if (
    tool === "jetkvm_input_paste" &&
    typeof error.code === "string" &&
    Object.hasOwn(PASTE_PROGRESS_ERROR_CODES, error.code)
  ) {
    const requestedCount = snapshot.pasteNormalizedByteCount;
    if (
      requestedCount === null ||
      typeof details.dispatched_action_count !== "number" ||
      typeof details.completed_action_count !== "number" ||
      details.completed_action_count < 0 ||
      details.dispatched_action_count < details.completed_action_count ||
      details.dispatched_action_count > requestedCount ||
      details.failed_action_index !==
        (details.completed_action_count < requestedCount
          ? details.completed_action_count
          : null)
    ) {
      throw new Error("Invalid handler result correlation.");
    }
    return;
  }

  if (tool !== "jetkvm_input_keyboard" && tool !== "jetkvm_input_mouse") {
    return;
  }
  const expectedActionCount = snapshot.actionCount;
  if (expectedActionCount === null) {
    throw new Error("Invalid handler result correlation.");
  }
  if (error.outcome === "unknown") {
    if (
      typeof details.failed_action_index !== "number" ||
      typeof details.dispatched_action_count !== "number" ||
      typeof details.completed_action_count !== "number" ||
      details.completed_action_count !== details.failed_action_index ||
      details.dispatched_action_count !== details.failed_action_index + 1 ||
      details.dispatched_action_count > expectedActionCount
    ) {
      throw new Error("Invalid handler result correlation.");
    }
    return;
  }
  if (
    (error.outcome === "applied" || error.outcome === "already_applied") &&
    (details.failed_action_index !== null ||
      details.dispatched_action_count !== expectedActionCount ||
      details.completed_action_count !== expectedActionCount)
  ) {
    throw new Error("Invalid handler result correlation.");
  }
}

function correlationIdFor(requestId: string | number): string {
  const canonical =
    typeof requestId === "number"
      ? `number:${requestId}`
      : `string:${requestId}`;
  return `mcp-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}
