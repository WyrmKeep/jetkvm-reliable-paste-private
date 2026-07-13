import { createHash } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
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

export type JetKvmToolHandler = (
  input: unknown,
  context: JetKvmHandlerContext,
) => CallToolResult | Promise<CallToolResult>;

export type HandlerRegistry = Readonly<
  Partial<Record<JetKvmToolName, JetKvmToolHandler>>
>;

export function createMcpServer(handlerRegistry: HandlerRegistry = {}): Server {
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

  const server = new Server(
    { name: "jetkvm-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

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

    const context: JetKvmHandlerContext = Object.freeze({
      signal: extra.signal,
      principalId: sanitizedPrincipalId(extra.authInfo?.clientId),
      correlationId: correlationIdFor(extra.requestId),
    });
    let result: CallToolResult;
    try {
      result = await handler(input.data, context);
    } catch {
      throw new McpError(
        ErrorCode.InternalError,
        `Tool handler failed for ${name}`,
      );
    }
    try {
      const mapped = validateAndMapMcpResult(toolName, result);
      validateCallResultCorrelation(toolName, input.data, mapped);
      return mapped;
    } catch {
      throw new McpError(
        ErrorCode.InternalError,
        `Invalid handler result for ${name}`,
      );
    }
  });

  return server;
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

function validateCallResultCorrelation(
  tool: JetKvmToolName,
  input: unknown,
  mapped: CallToolResult,
): void {
  if (!isRecord(input) || !isRecord(mapped.structuredContent)) {
    throw new Error("Invalid handler result correlation.");
  }
  const envelope = mapped.structuredContent;
  if (envelope.ok === true) {
    if (!isRecord(envelope.result)) {
      throw new Error("Invalid handler result correlation.");
    }
    const result = envelope.result;
    if (
      typeof input.request_id === "string" &&
      result.request_id !== input.request_id
    ) {
      throw new Error("Invalid handler result correlation.");
    }
    if (tool === "jetkvm_session_reconnect") {
      if (
        envelope.session_id !== input.session_id ||
        result.previous_session_generation !== input.session_generation ||
        typeof result.new_session_generation !== "number" ||
        result.new_session_generation <=
          (result.previous_session_generation as number) ||
        envelope.session_generation !== result.new_session_generation
      ) {
        throw new Error("Invalid handler result correlation.");
      }
    } else if (
      tool !== "jetkvm_session_connect" &&
      (envelope.session_id !== input.session_id ||
        envelope.session_generation !== input.session_generation)
    ) {
      throw new Error("Invalid handler result correlation.");
    }
  }

  if (tool !== "jetkvm_input_keyboard" && tool !== "jetkvm_input_mouse") {
    return;
  }
  if (!Array.isArray(input.actions)) {
    throw new Error("Invalid handler result correlation.");
  }
  const expectedActionCount = input.actions.length;
  if (envelope.ok === true) {
    const result = envelope.result as Record<string, unknown>;
    if (
      result.dispatched_action_count !== expectedActionCount ||
      result.completed_action_count !== expectedActionCount
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
