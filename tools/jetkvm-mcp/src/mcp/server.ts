import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { JETKVM_TOOL_NAMES, type JetKvmToolName } from "../domain.js";
import {
  TOOL_CATALOGUE,
  TOOL_CATALOGUE_BY_NAME,
  type ToolCatalogueEntry,
} from "./toolCatalogue.js";

export type JetKvmToolHandler = (
  input: unknown,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
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
            inputSchema: publishedInputSchema(entry),
            outputSchema: {
              ...toJsonSchemaCompat(entry.outputSchema, {
                strictUnions: true,
                pipeStrategy: "output",
              }),
              type: "object" as const,
            },
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

    const result = await handler(input.data, extra);
    const output = await entry.outputSchema.safeParseAsync(
      result.structuredContent,
    );
    if (!output.success) {
      throw new McpError(
        ErrorCode.InternalError,
        `Invalid handler result for ${name}`,
      );
    }
    return result;
  });

  return server;
}

function publishedInputSchema(
  entry: ToolCatalogueEntry,
): Record<string, unknown> {
  const schema = toJsonSchemaCompat(entry.inputSchema, {
    strictUnions: true,
    pipeStrategy: "input",
  });
  const properties = requiredRecord(schema.properties, "input properties");

  if (entry.name === "jetkvm_input_paste") {
    const text = requiredRecord(properties.text, "paste text");
    text["x-utf8-byte-max"] = 262_144;
  }

  if (entry.name === "jetkvm_input_mouse") {
    const actions = requiredRecord(properties.actions, "mouse actions");
    const items = requiredRecord(actions.items, "mouse action items");
    if (!Array.isArray(items.anyOf)) {
      throw new Error("Generated mouse schema is missing action variants");
    }
    const scroll = items.anyOf.find((candidate) => {
      if (!isRecord(candidate)) return false;
      const candidateProperties = candidate.properties;
      if (!isRecord(candidateProperties)) return false;
      const type = candidateProperties.type;
      return isRecord(type) && type.const === "scroll";
    });
    const scrollProperties = requiredRecord(
      requiredRecord(scroll, "scroll action").properties,
      "scroll properties",
    );
    const deltaY = requiredRecord(scrollProperties.delta_y, "scroll delta_y");
    deltaY.not = { const: 0 };
  }

  return schema;
}

function requiredRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Generated tool schema is missing ${description}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
