import { createHash } from "node:crypto";

import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAPABILITY_NAMES,
  JETKVM_TOOL_NAMES,
  type JetKvmToolName,
} from "../domain.js";
import {
  createMcpServer,
  type HandlerRegistry,
  type JetKvmToolHandler,
} from "./server.js";
import { GENERATED_JSON_SCHEMA_DOCUMENTS } from "./schemas.js";

const openClients: Client[] = [];

function businessError(tool: JetKvmToolName): CallToolResult {
  const isRead =
    tool === "jetkvm_display_capture" ||
    tool === "jetkvm_display_status" ||
    tool === "jetkvm_session_status";
  const payload = {
    ok: false as const,
    tool,
    operation_id: "operation-1",
    session_id: null,
    session_generation: null,
    duration_ms: 0,
    error: {
      code: "CONFIG_INVALID" as const,
      message: "deterministic test error",
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

function successfulConnect(): CallToolResult {
  const capabilities = Object.fromEntries(
    CAPABILITY_NAMES.map((name) => [name, true]),
  );
  const payload = {
    ok: true as const,
    tool: "jetkvm_session_connect" as const,
    operation_id: "operation-success",
    session_id: "session-1",
    session_generation: 1,
    duration_ms: 1,
    result: {
      request_id: "request-1",
      outcome: "applied" as const,
      verification: "device_ack_only" as const,
      safe_to_retry: false as const,
      required_next_step: "none" as const,
      state: "ready" as const,
      connection_epoch: 1,
      display_generation: 1,
      takeover_performed: false,
      fresh_capture_required: true,
      permissions: ["session.connect" as const],
      capabilities,
    },
  };
  return {
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

async function connectedClient(registry: HandlerRegistry): Promise<Client> {
  const server = createMcpServer(registry);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "server-contract-test", version: "1.0.0" });
  openClients.push(client);
  await client.connect(clientTransport);
  return client;
}

afterEach(async () => {
  await Promise.all(
    openClients.splice(0).map(async (client) => client.close()),
  );
});

describe("createMcpServer", () => {
  it("registers no production tools for an empty registry", async () => {
    const client = await connectedClient({});

    await expect(client.listTools()).resolves.toEqual({ tools: [] });
  });

  it("registers exactly the canonical ten tools in stable order for a complete registry", async () => {
    const client = await connectedClient(completeRegistry());

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(JETKVM_TOOL_NAMES);
    expect(listed.tools).toHaveLength(10);
    for (const tool of listed.tools) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.outputSchema).toMatchObject({
        anyOf: expect.any(Array),
      });
    }
    const mouseSchema = listed.tools.find(
      (tool) => tool.name === "jetkvm_input_mouse",
    )?.inputSchema;
    const pasteSchema = listed.tools.find(
      (tool) => tool.name === "jetkvm_input_paste",
    )?.inputSchema;
    expect(JSON.stringify(mouseSchema)).toContain('"not":{"const":0}');
    expect(JSON.stringify(pasteSchema)).toContain('"x-utf8-byte-max":262144');
  });

  it("publishes the exact shared generated and tracked result documents", async () => {
    const client = await connectedClient(completeRegistry());
    const listed = await client.listTools();

    for (const tool of listed.tools) {
      const fileName = `${tool.name}.result.schema.json`;
      const tracked = JSON.parse(
        readFileSync(
          new URL(`../../schemas/${fileName}`, import.meta.url),
          "utf8",
        ),
      );
      expect(tool.outputSchema).toEqual(
        GENERATED_JSON_SCHEMA_DOCUMENTS[fileName],
      );
      expect(tool.outputSchema).toEqual(tracked);
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }
  });

  it("dispatches schema-valid calls only to the injected handler", async () => {
    const handler = vi.fn(async (_input: unknown) =>
      businessError("jetkvm_session_connect"),
    );
    const client = await connectedClient(
      completeRegistry({ jetkvm_session_connect: handler }),
    );

    const result = await client.callTool({
      name: "jetkvm_session_connect",
      arguments: { request_id: "request-1", timeout_ms: 100 },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual({
      request_id: "request-1",
      takeover: false,
      timeout_ms: 100,
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false },
    });
  });

  it("maps an authorized PNG capture end to end without duplicating image bytes", async () => {
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const data = Buffer.from(bytes).toString("base64");
    const envelope = {
      ok: true as const,
      tool: "jetkvm_display_capture" as const,
      operation_id: "operation-png",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 1,
      result: {
        observation_id: "observation-png",
        connection_epoch: 1,
        display_generation: 1,
        frame_id: "frame-png",
        captured_at: "2026-07-13T00:00:00.000Z",
        source_width: 1,
        source_height: 1,
        image_width: 1,
        image_height: 1,
        rotation: 0 as const,
        geometry: {
          content_x: 0,
          content_y: 0,
          content_width: 1,
          content_height: 1,
        },
        image: {
          content_index: 1,
          mime_type: "image/png" as const,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byte_length: bytes.byteLength,
        },
      },
    };
    const client = await connectedClient(
      completeRegistry({
        jetkvm_display_capture: async () => ({
          structuredContent: envelope,
          content: [
            { type: "text", text: JSON.stringify(envelope) },
            { type: "image", data, mimeType: "image/png" },
          ],
        }),
      }),
    );

    const result = await client.callTool({
      name: "jetkvm_display_capture",
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        format: "png",
        timeout_ms: 100,
      },
    });

    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(envelope) },
      { type: "image", data, mimeType: "image/png" },
    ]);
    expect(result.structuredContent).toEqual(envelope);
    expect(JSON.stringify(result.structuredContent)).not.toContain(data);
  });

  it("passes only the application-owned allowlisted handler context", async () => {
    const observed = Promise.withResolvers<Record<string, unknown>>();
    const handler = vi.fn(
      async (_input: unknown, context: Record<string, unknown>) => {
        observed.resolve(context);
        return businessError("jetkvm_session_connect");
      },
    );
    const client = await connectedClient(
      completeRegistry({ jetkvm_session_connect: handler }),
    );

    await client.callTool({
      name: "jetkvm_session_connect",
      arguments: { request_id: "request-1", timeout_ms: 100 },
    });

    const context = await observed.promise;
    expect(Object.keys(context).sort()).toEqual([
      "correlationId",
      "principalId",
      "signal",
    ]);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.principalId).toBeNull();
    expect(context.correlationId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(context).not.toHaveProperty("authInfo");
    expect(context).not.toHaveProperty("requestInfo");
    expect(context).not.toHaveProperty("sessionId");
    expect(context).not.toHaveProperty("requestId");
    expect(context).not.toHaveProperty("sendNotification");
    expect(context).not.toHaveProperty("sendRequest");
  });

  it("rejects schema-invalid calls before invoking a handler", async () => {
    const handler = vi.fn(async (_input: unknown) =>
      businessError("jetkvm_session_connect"),
    );
    const client = await connectedClient(
      completeRegistry({ jetkvm_session_connect: handler }),
    );

    await expect(
      client.callTool({
        name: "jetkvm_session_connect",
        arguments: {
          request_id: "request-1",
          timeout_ms: 99,
          unexpected: true,
        },
      }),
    ).rejects.toThrow(/Invalid arguments/);

    expect(handler).not.toHaveBeenCalled();
  });

  it("turns an invalid handler result into a protocol error", async () => {
    const invalidResult: CallToolResult = {
      structuredContent: {},
      content: [{ type: "text", text: "{}" }],
    };
    const client = await connectedClient(
      completeRegistry({
        jetkvm_session_connect: async () => invalidResult,
      }),
    );

    await expect(
      client.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "request-1", timeout_ms: 100 },
      }),
    ).rejects.toThrow(/Invalid handler result/);
  });

  it.each([
    {
      name: "an error without isError true",
      mutate: (result: CallToolResult) => ({ ...result, isError: undefined }),
    },
    {
      name: "an error with isError false",
      mutate: (result: CallToolResult) => ({ ...result, isError: false }),
    },
    {
      name: "mismatched text content",
      mutate: (result: CallToolResult) => ({
        ...result,
        content: [{ type: "text" as const, text: "secret bearer value" }],
      }),
    },
    {
      name: "arbitrary extra content",
      mutate: (result: CallToolResult) => ({
        ...result,
        content: [
          ...result.content,
          { type: "text" as const, text: "unexpected" },
        ],
      }),
    },
    {
      name: "an unauthorized image",
      mutate: (result: CallToolResult) => ({
        ...result,
        content: [
          ...result.content,
          {
            type: "image" as const,
            data: Buffer.from("secret").toString("base64"),
            mimeType: "image/jpeg" as const,
          },
        ],
      }),
    },
  ])("rejects $name from a handler", async ({ mutate }) => {
    const client = await connectedClient(
      completeRegistry({
        jetkvm_session_connect: async () =>
          mutate(businessError("jetkvm_session_connect")),
      }),
    );

    await expect(
      client.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "request-1", timeout_ms: 100 },
      }),
    ).rejects.toThrow(/Invalid handler result/);
  });

  it("rejects isError true on a success result", async () => {
    const client = await connectedClient(
      completeRegistry({
        jetkvm_session_connect: async () => ({
          ...successfulConnect(),
          isError: true,
        }),
      }),
    );

    await expect(
      client.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "request-1", timeout_ms: 100 },
      }),
    ).rejects.toThrow(/Invalid handler result/);
  });

  it("uses protocol errors for unknown or inactive tools", async () => {
    const activeClient = await connectedClient(completeRegistry());
    await expect(
      activeClient.callTool({ name: "not_a_jetkvm_tool", arguments: {} }),
    ).rejects.toThrow(/Unknown tool/);

    const inactiveClient = await connectedClient({});
    await expect(
      inactiveClient.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "request-1", timeout_ms: 100 },
      }),
    ).rejects.toThrow(/not active/);
  });

  it("rejects a partial registry rather than exposing incomplete production behavior", () => {
    expect(() =>
      createMcpServer({
        jetkvm_session_connect: async () =>
          businessError("jetkvm_session_connect"),
      }),
    ).toThrow(/empty or contain all ten/i);
  });

  it("rejects a ten-key registry containing a non-handler value", () => {
    const registry = completeRegistry();
    Object.defineProperty(registry, "jetkvm_session_status", {
      configurable: true,
      enumerable: true,
      value: undefined,
    });

    expect(() => createMcpServer(registry)).toThrow(/missing canonical tool/i);
  });

  it("rejects handler names outside the canonical catalogue", () => {
    const registry = {
      ...completeRegistry(),
      not_a_jetkvm_tool: async () => businessError("jetkvm_session_connect"),
    } as HandlerRegistry;

    expect(() => createMcpServer(registry)).toThrow(/unknown tool/i);
  });
});
