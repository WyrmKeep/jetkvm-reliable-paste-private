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
      return validateAndMapMcpResult(toolName, result);
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
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principalId)) {
    return principalId;
  }
  return `principal-${createHash("sha256").update(principalId).digest("hex").slice(0, 32)}`;
}

function correlationIdFor(requestId: string | number): string {
  const canonical =
    typeof requestId === "number"
      ? `number:${requestId}`
      : `string:${requestId}`;
  return `mcp-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}
