import { createHash } from "node:crypto";

import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  type CallToolResult,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAPABILITY_NAMES,
  JETKVM_TOOL_NAMES,
  type JetKvmToolName,
} from "../domain.js";
import type { DeviceRpcAdapter } from "../device/DeviceRpcAdapter.js";
import { createStructuredLogger } from "../observability/logger.js";
import { FakeBrowserPlane } from "../test-support/fakes/FakeBrowserPlane.js";
import { toMcpSuccessResult } from "./results.js";
import {
  MCP_SERVER_BUSY_ERROR_CODE,
  TOOL_HANDLER_GLOBAL_CAPACITY,
  TOOL_HANDLER_PER_PRINCIPAL_CAPACITY,
  TOOL_HANDLER_PER_SESSION_CAPACITY,
  assertHandlerRegistry,
  createMcpServer,
  type CreateMcpServerOptions,
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

function successfulConnect(takeoverPerformed = false): CallToolResult {
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
      takeover_performed: takeoverPerformed,
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
function callToolResult(envelope: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: envelope,
    content: [{ type: "text", text: JSON.stringify(envelope) }],
  };
}
function isMutableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mutableRecord(value: unknown): Record<string, unknown> {
  if (!isMutableRecord(value)) {
    throw new Error("Expected a mutable record fixture.");
  }
  return value;
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

async function connectedClient(
  registry: HandlerRegistry,
  clientId?: string,
  options?: CreateMcpServerOptions,
): Promise<Client> {
  const server = createMcpServer(registry, options);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  if (clientId !== undefined) {
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (message, options) =>
      send(message, {
        ...options,
        authInfo: {
          token: "test-token",
          clientId,
          scopes: [],
        },
      });
  }
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

  it("returns one fixed secret-free protocol error for an unknown initialized tool", async () => {
    const sentinels = [
      "Bearer unknown-tool-credential-sentinel",
      "https://unknown-tool-url.invalid/private?credential=url-sentinel",
      "paste-unknown-tool-sentinel",
      "cGFzdGUtdW5rbm93bi10b29sLWJhc2U2NC1zZW50aW5lbA==",
    ] as const;
    const unknownName = `unknown-tool ${sentinels.join(" ")}`;
    const logLines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => logLines.push(line),
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });
    const server = createMcpServer(completeRegistry());
    server.onerror = (error) => logger.error("mcp.server.error", { error });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const messages: JSONRPCMessage[] = [];
    const serializedMessages: string[] = [];
    clientTransport.onmessage = (message) => {
      messages.push(message);
      serializedMessages.push(JSON.stringify(message));
      logger.info("mcp.transport.response", { response: message });
    };
    await server.connect(serverTransport);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "unknown-tool-error-test",
          version: "1.0.0",
        },
      },
    });
    await vi.waitFor(() =>
      expect(
        messages.some((message) => "id" in message && message.id === 1),
      ).toBe(true),
    );
    await clientTransport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    messages.length = 0;
    serializedMessages.length = 0;
    logLines.length = 0;

    await clientTransport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: unknownName,
        arguments: {},
      },
    });
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    const expectedResponse = {
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: ErrorCode.InvalidParams,
        message: "Unknown tool",
      },
    };
    expect(messages).toEqual([expectedResponse]);
    expect(serializedMessages).toEqual([JSON.stringify(expectedResponse)]);
    expect(logLines).toHaveLength(1);
    const leakSurfaces = [
      JSON.stringify(messages[0]),
      serializedMessages.join(""),
      logLines.join(""),
    ];
    for (const surface of leakSurfaces) {
      expect(surface).not.toContain("cause");
      expect(surface).not.toContain("stack");
      for (const sentinel of sentinels) {
        expect(surface).not.toContain(sentinel);
      }
    }
    await server.close();
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

  it("maps a BrowserPlane capture artifact through an initialized tools/call", async () => {
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const data = Buffer.from(bytes).toString("base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const binding = {
      sessionId: "session-1",
      sessionGeneration: 1,
      connectionEpoch: 1,
      browserChannelGeneration: 1,
    };
    const ref = {
      sessionId: binding.sessionId,
      sessionGeneration: binding.sessionGeneration,
    };
    const adapter: DeviceRpcAdapter = {
      binding,
      readDisplayState: async () => {
        throw new Error("Unexpected display-state read.");
      },
      readEdid: async () => {
        throw new Error("Unexpected EDID read.");
      },
      performAtx: async () => {
        throw new Error("Unexpected ATX mutation.");
      },
    };
    const plane = new FakeBrowserPlane(adapter, undefined, {
      mimeType: "image/png",
      bytes,
    });
    plane.loadScenario({
      version: 1,
      steps: [
        {
          operation: "connect",
          result: {
            state: "ready",
            ref,
            binding,
            connectionEpoch: binding.connectionEpoch,
            browserChannelGeneration: binding.browserChannelGeneration,
            displayGeneration: 1,
          },
        },
        {
          operation: "capture",
          result: {
            observationId: "observation-png",
            sessionId: ref.sessionId,
            sessionGeneration: ref.sessionGeneration,
            connectionEpoch: binding.connectionEpoch,
            displayGeneration: 1,
            frameId: "frame-png",
            capturedAt: "2026-07-13T00:00:00.000Z",
            monotonicAgeMs: 0,
            sourceWidth: 1,
            sourceHeight: 1,
            imageWidth: 1,
            imageHeight: 1,
            rotation: 0,
            geometry: {
              contentX: 0,
              contentY: 0,
              contentWidth: 1,
              contentHeight: 1,
            },
            format: "png",
            sha256,
            byteLength: bytes.byteLength,
          },
        },
      ],
    });
    const deadline = {
      timeoutMs: 100,
      signal: new AbortController().signal,
    };
    await plane.connect(ref, deadline);
    const logLines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => logLines.push(line),
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });
    const client = await connectedClient(
      completeRegistry({
        jetkvm_display_capture: async () => {
          const artifact = await plane.capture(
            ref,
            { format: "png", maxWidth: 64, maxHeight: 64 },
            deadline,
          );
          const observation = artifact.observation;
          const envelope = {
            ok: true as const,
            tool: "jetkvm_display_capture" as const,
            operation_id: "operation-png",
            session_id: observation.sessionId,
            session_generation: observation.sessionGeneration,
            duration_ms: 1,
            result: {
              observation_id: observation.observationId,
              connection_epoch: observation.connectionEpoch,
              display_generation: observation.displayGeneration,
              frame_id: observation.frameId,
              captured_at: observation.capturedAt,
              source_width: observation.sourceWidth,
              source_height: observation.sourceHeight,
              image_width: observation.imageWidth,
              image_height: observation.imageHeight,
              rotation: observation.rotation,
              geometry: {
                content_x: observation.geometry.contentX,
                content_y: observation.geometry.contentY,
                content_width: observation.geometry.contentWidth,
                content_height: observation.geometry.contentHeight,
              },
              image: {
                content_index: 1 as const,
                mime_type: artifact.image.mimeType,
                sha256: observation.sha256,
                byte_length: observation.byteLength,
              },
            },
          };
          logger.info("capture.complete", { artifact });
          return toMcpSuccessResult(envelope, {
            bytes: artifact.image.bytes,
            mime_type: artifact.image.mimeType,
          });
        },
      }),
    );

    const result = await client.callTool({
      name: "jetkvm_display_capture",
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        format: "png",
        max_width: 64,
        max_height: 64,
        timeout_ms: 100,
      },
    });
    const content = result.content as CallToolResult["content"];

    expect(content.filter((block) => block.type === "image")).toEqual([
      { type: "image", data, mimeType: "image/png" },
    ]);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      result: {
        observation_id: "observation-png",
        image: {
          content_index: 1,
          mime_type: "image/png",
          sha256,
          byte_length: bytes.byteLength,
        },
      },
    });
    expect(content[0]).toEqual({
      type: "text",
      text: JSON.stringify(result.structuredContent),
    });
    const structured = JSON.stringify(result.structuredContent);
    const text = content[0]?.type === "text" ? content[0].text : "";
    const logs = logLines.join("");
    const planeEvents = JSON.stringify(plane.events());
    for (const byteFreeSurface of [structured, text, logs, planeEvents]) {
      expect(byteFreeSurface).not.toContain(data);
      expect(byteFreeSurface).not.toContain('"bytes"');
      expect(byteFreeSurface).not.toContain('"base64"');
    }
    expect(() => plane.assertExhausted()).not.toThrow();
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

  it("domain-separates every non-null accepted principal without canonical aliases", async () => {
    const observedPrincipals: (string | null)[] = [];
    const handler: JetKvmToolHandler = async (_input, context) => {
      observedPrincipals.push(context.principalId);
      return businessError("jetkvm_session_connect");
    };
    const formerlyHashed = "alice~x";
    const formerlyCanonical = `principal-${createHash("sha256")
      .update(formerlyHashed)
      .digest("hex")
      .slice(0, 32)}`;
    const firstClient = await connectedClient(
      completeRegistry({ jetkvm_session_connect: handler }),
      formerlyHashed,
    );
    const secondClient = await connectedClient(
      completeRegistry({ jetkvm_session_connect: handler }),
      formerlyCanonical,
    );

    await firstClient.callTool({
      name: "jetkvm_session_connect",
      arguments: { request_id: "request-principal-a", timeout_ms: 100 },
    });
    await secondClient.callTool({
      name: "jetkvm_session_connect",
      arguments: { request_id: "request-principal-b", timeout_ms: 100 },
    });

    expect(observedPrincipals).toHaveLength(2);
    expect(observedPrincipals[0]).toMatch(/^principal-[a-f0-9]{64}$/);
    expect(observedPrincipals[1]).toMatch(/^principal-[a-f0-9]{64}$/);
    expect(observedPrincipals[0]).not.toBe(observedPrincipals[1]);
    expect(observedPrincipals).not.toContain(formerlyHashed);
    expect(observedPrincipals).not.toContain(formerlyCanonical);
  });

  it.each([
    {
      tool: "jetkvm_input_keyboard" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        observation_id: "observation-1",
        request_id: "request-actions",
        actions: [
          { type: "key_press", key: "KeyA" },
          { type: "key_press", key: "KeyB" },
        ],
        timeout_ms: 100,
      },
    },
    {
      tool: "jetkvm_input_mouse" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        observation_id: "observation-1",
        request_id: "request-actions",
        actions: [
          { type: "move", x: 1, y: 1 },
          { type: "click", x: 1, y: 1, button: "left" },
        ],
        timeout_ms: 100,
      },
    },
  ])(
    "correlates $tool success counts to the validated action list",
    async ({ tool, arguments: callArguments }) => {
      let returnedCount = 1;
      let mutateActions = true;
      const handler: JetKvmToolHandler = async (input) => {
        if (mutateActions) {
          const parsedInput = mutableRecord(input);
          if (!Array.isArray(parsedInput.actions)) {
            throw new Error("Expected parsed actions.");
          }
          parsedInput.actions.splice(1);
        }
        const result = {
          request_id: "request-actions",
          outcome: "applied",
          verification: "device_ack_only",
          safe_to_retry: false,
          required_next_step: "none",
          dispatched_action_count: returnedCount,
          completed_action_count: returnedCount,
          post_capture: null,
          ...(tool === "jetkvm_input_keyboard" ? { held_keys: [] } : {}),
        };
        return callToolResult({
          ok: true,
          tool,
          operation_id: "operation-actions",
          session_id: "session-1",
          session_generation: 1,
          duration_ms: 1,
          result,
        });
      };
      const client = await connectedClient(
        completeRegistry({ [tool]: handler }),
      );

      await expect(
        client.callTool({ name: tool, arguments: callArguments }),
      ).rejects.toThrow(/Invalid handler result/);
      mutateActions = false;
      returnedCount = callArguments.actions.length;
      await expect(
        client.callTool({ name: tool, arguments: callArguments }),
      ).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          result: {
            dispatched_action_count: 2,
            completed_action_count: 2,
          },
        },
      });
    },
  );

  it("correlates action error prefixes to the validated action list", async () => {
    let details = {
      failed_action_index: 1,
      dispatched_action_count: 2,
      completed_action_count: 1,
    };
    const handler: JetKvmToolHandler = async () => {
      const envelope = {
        ok: false,
        tool: "jetkvm_input_mouse",
        operation_id: "operation-action-error",
        session_id: "session-1",
        session_generation: 1,
        duration_ms: 1,
        error: {
          code: "MUTATION_OUTCOME_UNKNOWN",
          message: "Unknown action outcome.",
          phase: "execute",
          outcome: "unknown",
          verification: "none",
          safe_to_retry: false,
          required_next_step: "inspect_device_state_before_retry",
          details: {
            permission: null,
            capability: null,
            ...details,
            downstream_stage: "write",
            expected_generation: null,
            actual_generation: null,
            observation_id: "observation-1",
          },
        },
      };
      return { ...callToolResult(envelope), isError: true };
    };
    const client = await connectedClient(
      completeRegistry({ jetkvm_input_mouse: handler }),
    );
    const call = {
      name: "jetkvm_input_mouse" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        observation_id: "observation-1",
        request_id: "request-action-error",
        actions: [{ type: "move", x: 1, y: 1 }],
        timeout_ms: 100,
      },
    };

    await expect(client.callTool(call)).rejects.toThrow(
      /Invalid handler result/,
    );
    details = {
      failed_action_index: 0,
      dispatched_action_count: 1,
      completed_action_count: 0,
    };
    await expect(client.callTool(call)).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          details: {
            failed_action_index: 0,
            dispatched_action_count: 1,
            completed_action_count: 0,
          },
        },
      },
    });
  });

  it("enforces exact reconnect request, session, and generation correlation", async () => {
    let overrides: Record<string, unknown> = {};
    let mutateIdentifiers = false;
    const handler: JetKvmToolHandler = async (input) => {
      if (mutateIdentifiers) {
        const parsedInput = mutableRecord(input);
        parsedInput.session_id = "session-other";
        parsedInput.session_generation = 6;
        parsedInput.request_id = "request-other";
      }
      const baseResult = {
        request_id: "request-reconnect",
        outcome: "applied",
        verification: "device_ack_only",
        safe_to_retry: false,
        required_next_step: "none",
        previous_session_generation: 7,
        new_session_generation: 8,
        connection_epoch: 2,
        state: "ready",
        takeover_performed: false,
        fresh_capture_required: true,
      };
      const resultOverrides =
        overrides.result === undefined ? {} : mutableRecord(overrides.result);
      const result = {
        ...baseResult,
        ...resultOverrides,
      };
      return callToolResult({
        ok: true,
        tool: "jetkvm_session_reconnect",
        operation_id: "operation-reconnect",
        session_id: "session-1",
        session_generation: 8,
        duration_ms: 1,
        ...overrides,
        result,
      });
    };
    const client = await connectedClient(
      completeRegistry({ jetkvm_session_reconnect: handler }),
    );
    const call = {
      name: "jetkvm_session_reconnect" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 7,
        request_id: "request-reconnect",
        takeover: false,
        timeout_ms: 100,
      },
    };

    mutateIdentifiers = true;
    overrides = {
      session_id: "session-other",
      session_generation: 7,
      result: {
        request_id: "request-other",
        previous_session_generation: 6,
        new_session_generation: 7,
      },
    };
    await expect(client.callTool(call)).rejects.toThrow(
      /Invalid handler result/,
    );
    mutateIdentifiers = false;

    for (const invalidOverrides of [
      { result: { request_id: "request-other" } },
      { result: { previous_session_generation: 6 } },
      { result: { new_session_generation: 7 }, session_generation: 7 },
      { session_generation: 9 },
      { session_id: "session-other" },
      { result: { takeover_performed: true } },
    ]) {
      overrides = invalidOverrides;
      await expect(client.callTool(call)).rejects.toThrow(
        /Invalid handler result/,
      );
    }
    overrides = {};
    await expect(client.callTool(call)).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        session_id: "session-1",
        session_generation: 8,
        result: {
          request_id: "request-reconnect",
          previous_session_generation: 7,
          new_session_generation: 8,
        },
      },
    });
  });

  it("correlates paste normalization evidence against the pre-handler text snapshot", async () => {
    const originalText = "\uFEFFCafe\u0301\r\n";
    const normalizedText = "Café\n";
    const evidenceFor = (text: string) => ({
      original_byte_count: Buffer.byteLength(text, "utf8"),
      normalized_byte_count: Buffer.byteLength(
        text
          .replace(/^\uFEFF/, "")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .normalize("NFC"),
        "utf8",
      ),
      normalized_sha256: createHash("sha256")
        .update(
          text
            .replace(/^\uFEFF/, "")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .normalize("NFC"),
          "utf8",
        )
        .digest("hex"),
    });
    let mutateText = true;
    const handler: JetKvmToolHandler = async (input) => {
      if (mutateText) {
        mutableRecord(input).text = "x";
      }
      const evidence = evidenceFor(mutateText ? "x" : originalText);
      return callToolResult({
        ok: true,
        tool: "jetkvm_input_paste",
        operation_id: "operation-paste-evidence",
        session_id: "session-1",
        session_generation: 1,
        duration_ms: 1,
        result: {
          request_id: "request-paste-evidence",
          outcome: "applied",
          verification: "device_ack_only",
          safe_to_retry: false,
          required_next_step: "none",
          ...evidence,
          accepted_at: "2026-07-13T00:00:00.000Z",
          completed_at: "2026-07-13T00:00:01.000Z",
          terminal_state: "succeeded",
          measured_chars_per_second: null,
          post_capture: null,
        },
      });
    };
    const client = await connectedClient(
      completeRegistry({ jetkvm_input_paste: handler }),
    );
    const call = {
      name: "jetkvm_input_paste" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        observation_id: "observation-1",
        request_id: "request-paste-evidence",
        text: originalText,
        timeout_ms: 100,
      },
    };

    await expect(client.callTool(call)).rejects.toThrow(
      /Invalid handler result/,
    );
    mutateText = false;
    await expect(client.callTool(call)).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        result: {
          original_byte_count: Buffer.byteLength(originalText, "utf8"),
          normalized_byte_count: Buffer.byteLength(normalizedText, "utf8"),
          normalized_sha256: createHash("sha256")
            .update(normalizedText, "utf8")
            .digest("hex"),
        },
      },
    });
  });

  it("correlates paste error progress to normalized UTF-8 bytes", async () => {
    let mutateText = true;
    let progress = {
      failed_action_index: 8,
      dispatched_action_count: 9,
      completed_action_count: 8,
    };
    const handler: JetKvmToolHandler = async (input) => {
      if (mutateText) {
        mutableRecord(input).text = "\uFEFFA😀e\u0301\r\nZ";
      }
      const envelope = {
        ok: false,
        tool: "jetkvm_input_paste",
        operation_id: "operation-paste-progress",
        session_id: "session-1",
        session_generation: 1,
        duration_ms: 1,
        error: {
          code: "MUTATION_OUTCOME_UNKNOWN",
          message: "Paste progress is unknown.",
          phase: "execute",
          outcome: "unknown",
          verification: "none",
          safe_to_retry: false,
          required_next_step: "inspect_device_state_before_retry",
          details: {
            permission: null,
            capability: null,
            ...progress,
            downstream_stage: "write",
            expected_generation: null,
            actual_generation: null,
            observation_id: "observation-1",
          },
        },
      };
      return { ...callToolResult(envelope), isError: true };
    };
    const client = await connectedClient(
      completeRegistry({ jetkvm_input_paste: handler }),
    );
    const call = {
      name: "jetkvm_input_paste" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        observation_id: "observation-1",
        request_id: "request-paste-progress",
        text: "\uFEFFA😀e\u0301\r\n",
        timeout_ms: 100,
      },
    };

    await expect(client.callTool(call)).rejects.toThrow(
      /Invalid handler result/,
    );
    mutateText = false;
    progress = {
      failed_action_index: 6,
      dispatched_action_count: 7,
      completed_action_count: 6,
    };
    await expect(client.callTool(call)).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          details: {
            failed_action_index: 6,
            dispatched_action_count: 7,
            completed_action_count: 6,
          },
        },
      },
    });
    progress = {
      failed_action_index: 0,
      dispatched_action_count: 7,
      completed_action_count: 6,
    };
    await expect(client.callTool(call)).rejects.toThrow(
      /Invalid handler result/,
    );
  });

  it("correlates capture format, bounds, and no-upscale geometry against the request snapshot", async () => {
    const bytes = Uint8Array.of(1);
    const data = Buffer.from(bytes).toString("base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let mode:
      | "mutated_request"
      | "out_of_bounds"
      | "upscaled"
      | "aspect_mismatch"
      | "valid" = "mutated_request";
    const handler: JetKvmToolHandler = async (input) => {
      if (mode === "mutated_request") {
        const parsedInput = mutableRecord(input);
        parsedInput.format = "jpeg";
        parsedInput.max_width = 128;
        parsedInput.max_height = 128;
      }
      const sourceWidth =
        mode === "upscaled" ? 32 : mode === "aspect_mismatch" ? 100 : 100;
      const sourceHeight =
        mode === "upscaled" ? 32 : mode === "aspect_mismatch" ? 50 : 100;
      const imageWidth = mode === "mutated_request" ? 100 : 64;
      const imageHeight = mode === "mutated_request" ? 100 : 64;
      const contentX = mode === "out_of_bounds" ? 1 : 0;
      const mimeType = mode === "mutated_request" ? "image/jpeg" : "image/png";
      const envelope = {
        ok: true,
        tool: "jetkvm_display_capture",
        operation_id: "operation-capture-correlation",
        session_id: "session-1",
        session_generation: 1,
        duration_ms: 1,
        result: {
          observation_id: "observation-capture-correlation",
          connection_epoch: 1,
          display_generation: 1,
          frame_id: "frame-capture-correlation",
          captured_at: "2026-07-13T00:00:00.000Z",
          source_width: sourceWidth,
          source_height: sourceHeight,
          image_width: imageWidth,
          image_height: imageHeight,
          rotation: 0,
          geometry: {
            content_x: contentX,
            content_y: 0,
            content_width: imageWidth,
            content_height: imageHeight,
          },
          image: {
            content_index: 1,
            mime_type: mimeType,
            sha256,
            byte_length: bytes.byteLength,
          },
        },
      };
      return {
        structuredContent: envelope,
        content: [
          { type: "text" as const, text: JSON.stringify(envelope) },
          { type: "image" as const, data, mimeType },
        ],
      };
    };
    const client = await connectedClient(
      completeRegistry({ jetkvm_display_capture: handler }),
    );
    const call = {
      name: "jetkvm_display_capture" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        format: "png",
        max_width: 64,
        max_height: 64,
        timeout_ms: 100,
      },
    };

    await expect(client.callTool(call)).rejects.toThrow(
      /Invalid handler result/,
    );
    for (const invalidMode of [
      "out_of_bounds",
      "upscaled",
      "aspect_mismatch",
    ] as const) {
      mode = invalidMode;
      await expect(client.callTool(call)).rejects.toThrow(
        /Invalid handler result/,
      );
    }
    mode = "valid";
    await expect(client.callTool(call)).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        result: {
          source_width: 100,
          source_height: 100,
          image_width: 64,
          image_height: 64,
          image: { mime_type: "image/png" },
        },
      },
    });
  });

  it.each([
    {
      tool: "jetkvm_input_keyboard" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        observation_id: "observation-1",
        request_id: "request-post-capture",
        actions: [{ type: "key_press", key: "KeyA" }],
        timeout_ms: 100,
      },
    },
    {
      tool: "jetkvm_input_mouse" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        observation_id: "observation-1",
        request_id: "request-post-capture",
        actions: [{ type: "move", x: 1, y: 1 }],
        timeout_ms: 100,
      },
    },
    {
      tool: "jetkvm_input_paste" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        observation_id: "observation-1",
        request_id: "request-post-capture",
        text: "x",
        timeout_ms: 100,
      },
    },
  ])(
    "validates invariant-only $tool post-capture geometry",
    async ({ tool, arguments: callArguments }) => {
      const postCaptureBytes = Uint8Array.of(1);
      const postCaptureData = Buffer.from(postCaptureBytes).toString("base64");
      const postCaptureSha256 = createHash("sha256")
        .update(postCaptureBytes)
        .digest("hex");
      let validGeometry = false;
      const handler: JetKvmToolHandler = async () => {
        const postCapture = {
          observation_id: "observation-post-capture",
          connection_epoch: 1,
          display_generation: 1,
          frame_id: "frame-post-capture",
          captured_at: "2026-07-13T00:00:00.000Z",
          source_width: validGeometry ? 64 : 32,
          source_height: validGeometry ? 64 : 32,
          image_width: 64,
          image_height: 64,
          rotation: 0,
          geometry: {
            content_x: 0,
            content_y: 0,
            content_width: 64,
            content_height: 64,
          },
          image: {
            content_index: 1,
            mime_type: "image/png",
            sha256: postCaptureSha256,
            byte_length: 1,
          },
        };
        const common = {
          request_id: "request-post-capture",
          outcome: "applied",
          verification: "device_ack_only",
          safe_to_retry: false,
          required_next_step: "none",
          post_capture: postCapture,
        };
        const result =
          tool === "jetkvm_input_keyboard"
            ? {
                ...common,
                dispatched_action_count: 1,
                completed_action_count: 1,
                held_keys: [],
              }
            : tool === "jetkvm_input_mouse"
              ? {
                  ...common,
                  dispatched_action_count: 1,
                  completed_action_count: 1,
                }
              : {
                  ...common,
                  original_byte_count: 1,
                  normalized_byte_count: 1,
                  normalized_sha256: createHash("sha256")
                    .update("x", "utf8")
                    .digest("hex"),
                  accepted_at: "2026-07-13T00:00:00.000Z",
                  completed_at: "2026-07-13T00:00:01.000Z",
                  terminal_state: "succeeded",
                  measured_chars_per_second: null,
                };
        const envelope = {
          ok: true,
          tool,
          operation_id: "operation-post-capture",
          session_id: "session-1",
          session_generation: 1,
          duration_ms: 1,
          result,
        };
        return {
          structuredContent: envelope,
          content: [
            { type: "text" as const, text: JSON.stringify(envelope) },
            {
              type: "image" as const,
              data: postCaptureData,
              mimeType: "image/png",
            },
          ],
        };
      };
      const client = await connectedClient(
        completeRegistry({ [tool]: handler }),
      );

      await expect(
        client.callTool({ name: tool, arguments: callArguments }),
      ).rejects.toThrow(/Invalid handler result/);
      validGeometry = true;
      await expect(
        client.callTool({ name: tool, arguments: callArguments }),
      ).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          result: {
            post_capture: {
              source_width: 64,
              source_height: 64,
              image_width: 64,
              image_height: 64,
            },
          },
        },
      });
    },
  );

  it("correlates power action against the pre-handler request snapshot", async () => {
    let mutateAction = true;
    const handler: JetKvmToolHandler = async (input) => {
      if (mutateAction) {
        mutableRecord(input).action = "press_reset";
      }
      const action = mutateAction ? "press_reset" : "press_power";
      return callToolResult({
        ok: true,
        tool: "jetkvm_power_control",
        operation_id: "operation-power-correlation",
        session_id: "session-1",
        session_generation: 1,
        duration_ms: 1,
        result: {
          request_id: "request-power-correlation",
          outcome: "applied",
          verification: "device_ack_only",
          safe_to_retry: false,
          required_next_step: "none",
          action,
          wire_action: action === "press_reset" ? "reset" : "power-short",
          fixed_press_ms: 200,
          serial_sequence_completed: true,
          atx_led_observation: {
            power: null,
            hdd: null,
            observed_at: null,
            freshness: "unknown",
          },
        },
      });
    };
    const client = await connectedClient(
      completeRegistry({ jetkvm_power_control: handler }),
    );
    const call = {
      name: "jetkvm_power_control" as const,
      arguments: {
        session_id: "session-1",
        session_generation: 1,
        request_id: "request-power-correlation",
        action: "press_power",
        timeout_ms: 100,
      },
    };

    await expect(client.callTool(call)).rejects.toThrow(
      /Invalid handler result/,
    );
    mutateAction = false;
    await expect(client.callTool(call)).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        result: {
          action: "press_power",
          wire_action: "power-short",
        },
      },
    });
  });

  it("does not let a connect handler manufacture takeover from a mutated request", async () => {
    let mutateTakeover = true;
    const handler: JetKvmToolHandler = async (input) => {
      if (mutateTakeover) {
        mutableRecord(input).takeover = true;
      }
      return successfulConnect(mutateTakeover);
    };
    const client = await connectedClient(
      completeRegistry({ jetkvm_session_connect: handler }),
    );
    const call = {
      name: "jetkvm_session_connect" as const,
      arguments: {
        request_id: "request-1",
        takeover: false,
        timeout_ms: 100,
      },
    };

    await expect(client.callTool(call)).rejects.toThrow(
      /Invalid handler result/,
    );
    mutateTakeover = false;
    await expect(client.callTool(call)).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        result: { takeover_performed: false },
      },
    });
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

  it("preflights empty or exact-ten handler registries without server effects", () => {
    expect(() => assertHandlerRegistry({})).not.toThrow();
    expect(() => assertHandlerRegistry(completeRegistry())).not.toThrow();
    expect(() =>
      assertHandlerRegistry({
        jetkvm_session_connect: async () =>
          businessError("jetkvm_session_connect"),
      }),
    ).toThrow(/empty or contain all ten/i);
    expect(() =>
      assertHandlerRegistry({
        ...completeRegistry(),
        not_a_jetkvm_tool: async () => businessError("jetkvm_session_connect"),
      } as HandlerRegistry),
    ).toThrow(/unknown tool/i);
    const nonFunction = completeRegistry();
    Object.defineProperty(nonFunction, "jetkvm_session_status", {
      configurable: true,
      enumerable: true,
      value: undefined,
    });
    expect(() => assertHandlerRegistry(nonFunction)).toThrow(
      /missing canonical tool/i,
    );
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

  it("bounds one principal without starving another and recovers completed slots", async () => {
    expect(TOOL_HANDLER_PER_PRINCIPAL_CAPACITY).toBeLessThan(
      TOOL_HANDLER_GLOBAL_CAPACITY,
    );
    const blocked = Promise.withResolvers<void>();
    const handler = vi.fn(async () => {
      await blocked.promise;
      return businessError("jetkvm_session_connect");
    });
    const registry = completeRegistry({ jetkvm_session_connect: handler });
    const principalA = await connectedClient(registry, "principal-a");
    const principalB = await connectedClient(registry, "principal-b");
    const activeA = Array.from(
      { length: TOOL_HANDLER_PER_PRINCIPAL_CAPACITY },
      (_, index) =>
        principalA.callTool({
          name: "jetkvm_session_connect",
          arguments: { request_id: `principal-a-${index}`, timeout_ms: 100 },
        }),
    );
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledTimes(
        TOOL_HANDLER_PER_PRINCIPAL_CAPACITY,
      ),
    );

    const principalOverload = await principalA
      .callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "principal-a-overload", timeout_ms: 100 },
      })
      .catch((error: unknown) => error);
    expect(principalOverload).toMatchObject({
      code: MCP_SERVER_BUSY_ERROR_CODE,
    });
    expect(principalOverload).toMatchObject({
      message: "MCP error -32002: Server busy",
    });
    expect(String(principalOverload)).toContain("Server busy");
    expect(String(principalOverload)).not.toContain("principal-a-overload");
    expect(handler).toHaveBeenCalledTimes(TOOL_HANDLER_PER_PRINCIPAL_CAPACITY);

    const activeB = principalB.callTool({
      name: "jetkvm_session_connect",
      arguments: { request_id: "principal-b-accepted", timeout_ms: 100 },
    });
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledTimes(
        TOOL_HANDLER_PER_PRINCIPAL_CAPACITY + 1,
      ),
    );

    blocked.resolve();
    await Promise.all([...activeA, activeB]);
    await expect(
      principalA.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "principal-a-recovered", timeout_ms: 100 },
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("enforces a shared global handler cap across server instances with no queue", async () => {
    const blocked = Promise.withResolvers<void>();
    const handler = vi.fn(async () => {
      await blocked.promise;
      return businessError("jetkvm_session_connect");
    });
    const registry = completeRegistry({ jetkvm_session_connect: handler });
    const principalCount =
      TOOL_HANDLER_GLOBAL_CAPACITY / TOOL_HANDLER_PER_PRINCIPAL_CAPACITY;
    expect(Number.isInteger(principalCount)).toBe(true);
    const clients = await Promise.all(
      Array.from({ length: principalCount }, (_, index) =>
        connectedClient(registry, `global-principal-${index}`),
      ),
    );
    const active = clients.flatMap((client, principalIndex) =>
      Array.from(
        { length: TOOL_HANDLER_PER_PRINCIPAL_CAPACITY },
        (_, callIndex) =>
          client.callTool({
            name: "jetkvm_session_connect",
            arguments: {
              request_id: `global-${principalIndex}-${callIndex}`,
              timeout_ms: 100,
            },
          }),
      ),
    );
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledTimes(TOOL_HANDLER_GLOBAL_CAPACITY),
    );

    const overloaded = await connectedClient(registry, "global-overload");
    const globalOverload = await overloaded
      .callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "secret-overload-input", timeout_ms: 100 },
      })
      .catch((error: unknown) => error);
    expect(globalOverload).toMatchObject({
      code: MCP_SERVER_BUSY_ERROR_CODE,
    });
    expect(globalOverload).toMatchObject({
      message: "MCP error -32002: Server busy",
    });
    expect(String(globalOverload)).toContain("Server busy");
    expect(String(globalOverload)).not.toContain("secret-overload-input");
    expect(handler).toHaveBeenCalledTimes(TOOL_HANDLER_GLOBAL_CAPACITY);

    blocked.resolve();
    await Promise.all(active);
  });

  it("caps one session across tools and releases every slot after completion", async () => {
    const blocked = Promise.withResolvers<void>();
    const statusHandler = vi.fn(async () => {
      await blocked.promise;
      return businessError("jetkvm_session_status");
    });
    const pasteHandler = vi.fn(async () => businessError("jetkvm_input_paste"));
    const registry = completeRegistry({
      jetkvm_session_status: statusHandler,
      jetkvm_input_paste: pasteHandler,
    });
    const client = await connectedClient(registry, "session-principal");
    const active = Array.from(
      { length: TOOL_HANDLER_PER_SESSION_CAPACITY },
      () =>
        client.callTool({
          name: "jetkvm_session_status",
          arguments: {
            session_id: "session-cap",
            session_generation: 1,
            timeout_ms: 100,
          },
        }),
    );
    await vi.waitFor(() =>
      expect(statusHandler).toHaveBeenCalledTimes(
        TOOL_HANDLER_PER_SESSION_CAPACITY,
      ),
    );

    const secret = "Bearer-secret-paste-body";
    await expect(
      client.callTool({
        name: "jetkvm_input_paste",
        arguments: {
          session_id: "session-cap",
          session_generation: 1,
          observation_id: "observation-1",
          request_id: "paste-overload",
          text: secret,
          timeout_ms: 100,
        },
      }),
    ).rejects.toMatchObject({
      code: MCP_SERVER_BUSY_ERROR_CODE,
      message: expect.not.stringContaining(secret),
    });
    expect(pasteHandler).not.toHaveBeenCalled();

    blocked.resolve();
    await Promise.all(active);
    await expect(
      client.callTool({
        name: "jetkvm_input_paste",
        arguments: {
          session_id: "session-cap",
          session_generation: 1,
          observation_id: "observation-1",
          request_id: "paste-recovered",
          text: "safe",
          timeout_ms: 100,
        },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(pasteHandler).toHaveBeenCalledOnce();
  });

  it("aborts every active invocation on transport close and recovers shared slots", async () => {
    const observedSignals: AbortSignal[] = [];
    let shouldBlock = true;
    const handler = vi.fn(
      async (
        _input: unknown,
        context: { signal: AbortSignal },
      ): Promise<CallToolResult> => {
        observedSignals.push(context.signal);
        if (shouldBlock && !context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        }
        return businessError("jetkvm_session_connect");
      },
    );
    const registry = completeRegistry({ jetkvm_session_connect: handler });
    const server = createMcpServer(registry);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({
      name: "server-lifetime-test",
      version: "1.0.0",
    });
    openClients.push(client);
    await client.connect(clientTransport);
    const pending = [
      client.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "lifetime-a", timeout_ms: 100 },
      }),
      client.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "lifetime-b", timeout_ms: 100 },
      }),
    ];
    await vi.waitFor(() => expect(observedSignals).toHaveLength(2));

    await client.close();
    await vi.waitFor(() =>
      expect(observedSignals.every((signal) => signal.aborted)).toBe(true),
    );
    await Promise.allSettled(pending);

    shouldBlock = false;
    const replacement = await connectedClient(registry);
    await expect(
      replacement.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "lifetime-recovered", timeout_ms: 100 },
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("releases session slots after request cancellation", async () => {
    const entered = Promise.withResolvers<void>();
    let enteredCount = 0;
    const statusHandler = vi.fn(
      async (
        _input: unknown,
        context: { signal: AbortSignal },
      ): Promise<CallToolResult> => {
        enteredCount += 1;
        if (enteredCount === TOOL_HANDLER_PER_SESSION_CAPACITY) {
          entered.resolve();
        }
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        }
        return businessError("jetkvm_session_status");
      },
    );
    const pasteHandler = vi.fn(async () => businessError("jetkvm_input_paste"));
    const registry = completeRegistry({
      jetkvm_session_status: statusHandler,
      jetkvm_input_paste: pasteHandler,
    });
    const client = await connectedClient(registry, "cancel-principal");
    const cancellations = Array.from(
      { length: TOOL_HANDLER_PER_SESSION_CAPACITY },
      () => new AbortController(),
    );
    const pending = cancellations.map((controller) =>
      client.callTool(
        {
          name: "jetkvm_session_status",
          arguments: {
            session_id: "cancel-session",
            session_generation: 1,
            timeout_ms: 100,
          },
        },
        undefined,
        { signal: controller.signal },
      ),
    );
    await entered.promise;
    for (const controller of cancellations) controller.abort();
    await Promise.allSettled(pending);
    await vi.waitFor(() =>
      expect(
        statusHandler.mock.calls.every((call) => call[1].signal.aborted),
      ).toBe(true),
    );

    await expect(
      client.callTool({
        name: "jetkvm_input_paste",
        arguments: {
          session_id: "cancel-session",
          session_generation: 1,
          observation_id: "observation-1",
          request_id: "after-cancel",
          text: "safe",
          timeout_ms: 100,
        },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(pasteHandler).toHaveBeenCalledOnce();
  });

  it("releases session slots after handler rejection without exposing error text", async () => {
    let shouldReject = true;
    const secret = "https://operator:password@example.test Bearer-secret";
    const handler = vi.fn(async () => {
      if (shouldReject) throw new Error(secret);
      return businessError("jetkvm_session_status");
    });
    const registry = completeRegistry({ jetkvm_session_status: handler });
    const client = await connectedClient(registry, "reject-principal");
    for (
      let index = 0;
      index < TOOL_HANDLER_PER_SESSION_CAPACITY + 1;
      index += 1
    ) {
      const rejection = await client
        .callTool({
          name: "jetkvm_session_status",
          arguments: {
            session_id: "reject-session",
            session_generation: 1,
            timeout_ms: 100,
          },
        })
        .catch((error: unknown) => error);
      expect(String(rejection)).toContain("Tool handler failed");
      expect(String(rejection)).not.toContain(secret);
    }
    expect(handler).toHaveBeenCalledTimes(
      TOOL_HANDLER_PER_SESSION_CAPACITY + 1,
    );

    shouldReject = false;
    await expect(
      client.callTool({
        name: "jetkvm_session_status",
        arguments: {
          session_id: "reject-session",
          session_generation: 1,
          timeout_ms: 100,
        },
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("fail-closes a duplicate active JSON-RPC ID and cancels the original", async () => {
    const observedSignals: AbortSignal[] = [];
    const handler = vi.fn(
      async (
        _input: unknown,
        context: { signal: AbortSignal },
      ): Promise<CallToolResult> => {
        observedSignals.push(context.signal);
        if (handler.mock.calls.length === 1 && !context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        }
        return businessError("jetkvm_session_connect");
      },
    );
    const server = createMcpServer(
      completeRegistry({ jetkvm_session_connect: handler }),
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const messages: JSONRPCMessage[] = [];
    clientTransport.onmessage = (message) => messages.push(message);
    await server.connect(serverTransport);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "duplicate-id-test", version: "1.0.0" },
      },
    });
    await vi.waitFor(() =>
      expect(
        messages.some((message) => "id" in message && message.id === 1),
      ).toBe(true),
    );
    await clientTransport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const duplicateCall = {
      jsonrpc: "2.0" as const,
      id: 77,
      method: "tools/call" as const,
      params: {
        name: "jetkvm_session_connect",
        arguments: { request_id: "duplicate-id", timeout_ms: 100 },
      },
    };
    await clientTransport.send(duplicateCall);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await clientTransport.send(duplicateCall);
    await vi.waitFor(() =>
      expect(
        messages.some(
          (message) =>
            "id" in message &&
            message.id === 77 &&
            "error" in message &&
            message.error.code === MCP_SERVER_BUSY_ERROR_CODE,
        ),
      ).toBe(true),
    );
    expect(handler).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(observedSignals[0]?.aborted).toBe(true));

    await clientTransport.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 77, reason: "cancel duplicate ID" },
    });
    await vi.waitFor(() => expect(observedSignals[0]?.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(
        messages.filter((message) => "id" in message && message.id === 77),
      ).toHaveLength(2),
    );
    expect(
      messages
        .filter((message) => "id" in message && message.id === 77)
        .every((message) => "error" in message),
    ).toBe(true);

    await clientTransport.send(duplicateCall);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        messages.filter((message) => "id" in message && message.id === 77),
      ).toHaveLength(3),
    );
    expect(
      messages.filter(
        (message) =>
          "id" in message && message.id === 77 && "result" in message,
      ),
    ).toHaveLength(1);
    await server.close();
  });

  it("shares every admission cap across cloned registries with one stable key", async () => {
    const admissionKey = {};
    let blocked = Promise.withResolvers<void>();
    const handler = vi.fn(async () => {
      await blocked.promise;
      return businessError("jetkvm_session_connect");
    });
    const registry = () =>
      completeRegistry({ jetkvm_session_connect: handler });

    const principalClients = await Promise.all([
      connectedClient(registry(), "shared-principal", { admissionKey }),
      connectedClient(registry(), "shared-principal", { admissionKey }),
    ]);
    const principalActive = Array.from(
      { length: TOOL_HANDLER_PER_PRINCIPAL_CAPACITY },
      (_, index) =>
        principalClients[index % principalClients.length]!.callTool({
          name: "jetkvm_session_connect",
          arguments: {
            request_id: `shared-principal-${index}`,
            timeout_ms: 100,
          },
        }),
    );
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledTimes(
        TOOL_HANDLER_PER_PRINCIPAL_CAPACITY,
      ),
    );
    await expect(
      principalClients[0]!.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "shared-principal-overload", timeout_ms: 100 },
      }),
    ).rejects.toMatchObject({ code: MCP_SERVER_BUSY_ERROR_CODE });
    blocked.resolve();
    await Promise.all(principalActive);

    blocked = Promise.withResolvers<void>();
    handler.mockClear();
    const globalClients = await Promise.all(
      Array.from({ length: TOOL_HANDLER_GLOBAL_CAPACITY }, (_, index) =>
        connectedClient(registry(), `shared-global-${index}`, {
          admissionKey,
        }),
      ),
    );
    const globalActive = globalClients.map((client, index) =>
      client.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: `shared-global-${index}`, timeout_ms: 100 },
      }),
    );
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledTimes(TOOL_HANDLER_GLOBAL_CAPACITY),
    );
    const sharedOverload = await connectedClient(
      registry(),
      "shared-global-overload",
      { admissionKey },
    );
    await expect(
      sharedOverload.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "shared-global-overload", timeout_ms: 100 },
      }),
    ).rejects.toMatchObject({ code: MCP_SERVER_BUSY_ERROR_CODE });

    const isolated = await connectedClient(registry(), "isolated-principal", {
      admissionKey: {},
    });
    const isolatedActive = isolated.callTool({
      name: "jetkvm_session_connect",
      arguments: { request_id: "isolated-accepted", timeout_ms: 100 },
    });
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledTimes(TOOL_HANDLER_GLOBAL_CAPACITY + 1),
    );
    blocked.resolve();
    await Promise.all([...globalActive, isolatedActive]);
  });

  it("shares session caps across cloned registries and isolates lifetime aborts", async () => {
    const admissionKey = {};
    const lifetimeA = new AbortController();
    const lifetimeB = new AbortController();
    const signalsA: AbortSignal[] = [];
    const signalsB: AbortSignal[] = [];
    const handlerFor =
      (signals: AbortSignal[]): JetKvmToolHandler =>
      async (_input, context) => {
        signals.push(context.signal);
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        }
        return businessError("jetkvm_session_status");
      };
    const clientA = await connectedClient(
      completeRegistry({
        jetkvm_session_status: handlerFor(signalsA),
      }),
      "shared-session",
      { admissionKey, lifetimeSignal: lifetimeA.signal },
    );
    const clientB = await connectedClient(
      completeRegistry({
        jetkvm_session_status: handlerFor(signalsB),
      }),
      "shared-session",
      { admissionKey, lifetimeSignal: lifetimeB.signal },
    );
    const statusArguments = {
      session_id: "shared-session-id",
      session_generation: 1,
      timeout_ms: 100,
    };
    const activeA = clientA.callTool({
      name: "jetkvm_session_status",
      arguments: statusArguments,
    });
    const activeB = clientB.callTool({
      name: "jetkvm_session_status",
      arguments: statusArguments,
    });
    await vi.waitFor(() =>
      expect(signalsA.length + signalsB.length).toBe(
        TOOL_HANDLER_PER_SESSION_CAPACITY,
      ),
    );
    await expect(
      clientB.callTool({
        name: "jetkvm_session_status",
        arguments: statusArguments,
      }),
    ).rejects.toMatchObject({ code: MCP_SERVER_BUSY_ERROR_CODE });
    await expect(
      clientB.callTool({
        name: "jetkvm_session_status",
        arguments: { ...statusArguments, session_generation: 2 },
      }),
    ).rejects.toMatchObject({ code: MCP_SERVER_BUSY_ERROR_CODE });
    const distinctSessionActive = clientB.callTool({
      name: "jetkvm_session_status",
      arguments: { ...statusArguments, session_id: "distinct-session-id" },
    });
    await vi.waitFor(() =>
      expect(signalsA.length + signalsB.length).toBe(
        TOOL_HANDLER_PER_SESSION_CAPACITY + 1,
      ),
    );

    lifetimeA.abort();
    await vi.waitFor(() => expect(signalsA[0]?.aborted).toBe(true));
    expect(signalsB[0]?.aborted).toBe(false);
    await Promise.allSettled([activeA]);
    const replacementLifetime = new AbortController();
    const replacementSignals: AbortSignal[] = [];
    const replacement = await connectedClient(
      completeRegistry({
        jetkvm_session_status: handlerFor(replacementSignals),
      }),
      "shared-session",
      { admissionKey, lifetimeSignal: replacementLifetime.signal },
    );
    const replacementActive = replacement.callTool({
      name: "jetkvm_session_status",
      arguments: statusArguments,
    });
    await vi.waitFor(() => expect(replacementSignals).toHaveLength(1));

    lifetimeB.abort();
    replacementLifetime.abort();
    await Promise.allSettled([
      activeB,
      distinctSessionActive,
      replacementActive,
    ]);
  });

  it("keeps close pending until aborted handlers finish cleanup and release admission", async () => {
    const admissionKey = {};
    const cleanup = Promise.withResolvers<void>();
    const observedSignals: AbortSignal[] = [];
    const handler = vi.fn(
      async (
        _input: unknown,
        context: { signal: AbortSignal },
      ): Promise<CallToolResult> => {
        observedSignals.push(context.signal);
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        }
        await cleanup.promise;
        return businessError("jetkvm_session_status");
      },
    );
    const server = createMcpServer(
      completeRegistry({ jetkvm_session_status: handler }),
      { admissionKey },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({
      name: "close-drain-test",
      version: "1.0.0",
    });
    openClients.push(client);
    await client.connect(clientTransport);
    const statusArguments = {
      session_id: "close-drain-session",
      session_generation: 1,
      timeout_ms: 100,
    };
    const active = Array.from(
      { length: TOOL_HANDLER_PER_SESSION_CAPACITY },
      () =>
        client.callTool({
          name: "jetkvm_session_status",
          arguments: statusArguments,
        }),
    );
    const activeSettled = Promise.allSettled(active);
    await vi.waitFor(() =>
      expect(observedSignals).toHaveLength(TOOL_HANDLER_PER_SESSION_CAPACITY),
    );

    let closeSettled = false;
    const firstClose = server.close();
    const secondClose = server.close();
    expect(secondClose).toBe(firstClose);
    void firstClose.then(() => {
      closeSettled = true;
    });
    await vi.waitFor(() =>
      expect(observedSignals.every((signal) => signal.aborted)).toBe(true),
    );
    expect(closeSettled).toBe(false);

    const replacement = await connectedClient(completeRegistry(), undefined, {
      admissionKey,
    });
    await expect(
      replacement.callTool({
        name: "jetkvm_session_status",
        arguments: statusArguments,
      }),
    ).rejects.toMatchObject({ code: MCP_SERVER_BUSY_ERROR_CODE });

    cleanup.resolve();
    await Promise.all([firstClose, secondClose, activeSettled]);
    expect(closeSettled).toBe(true);
    await expect(
      replacement.callTool({
        name: "jetkvm_session_status",
        arguments: statusArguments,
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("preserves a transport close rejection only after handler cleanup releases admission", async () => {
    const admissionKey = {};
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let enteredCount = 0;
    let abortedCount = 0;
    const handler = vi.fn(
      async (
        _input: unknown,
        context: { signal: AbortSignal },
      ): Promise<CallToolResult> => {
        enteredCount += 1;
        if (enteredCount === TOOL_HANDLER_PER_SESSION_CAPACITY)
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
        abortedCount += 1;
        if (abortedCount === TOOL_HANDLER_PER_SESSION_CAPACITY)
          aborted.resolve();
        await cleanup.promise;
        return businessError("jetkvm_session_status");
      },
    );
    const server = createMcpServer(
      completeRegistry({ jetkvm_session_status: handler }),
      { admissionKey },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const closeError = new Error("transport close failed");
    serverTransport.close = vi
      .fn()
      .mockRejectedValueOnce(closeError)
      .mockResolvedValue(undefined);
    await server.connect(serverTransport);
    const client = new Client({
      name: "close-error-drain-test",
      version: "1.0.0",
    });
    openClients.push(client);
    await client.connect(clientTransport);
    const statusArguments = {
      session_id: "close-error-drain-session",
      session_generation: 1,
      timeout_ms: 100,
    };
    const active = Array.from(
      { length: TOOL_HANDLER_PER_SESSION_CAPACITY },
      () =>
        client.callTool({
          name: "jetkvm_session_status",
          arguments: statusArguments,
        }),
    );
    await entered.promise;

    let closeRejected = false;
    const close = server.close();
    void close.catch(() => {
      closeRejected = true;
    });
    await aborted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeRejected).toBe(false);

    const replacement = await connectedClient(completeRegistry(), undefined, {
      admissionKey,
    });
    await expect(
      replacement.callTool({
        name: "jetkvm_session_status",
        arguments: statusArguments,
      }),
    ).rejects.toMatchObject({ code: MCP_SERVER_BUSY_ERROR_CODE });

    cleanup.resolve();
    await expect(close).rejects.toBe(closeError);
    await Promise.allSettled(active);
    await expect(
      replacement.callTool({
        name: "jetkvm_session_status",
        arguments: statusArguments,
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("never admits pre-aborted lifetime or request signals", async () => {
    const admissionKey = {};
    const handler = vi.fn(async () => businessError("jetkvm_session_connect"));
    const lifetime = new AbortController();
    lifetime.abort();
    const lifetimeClient = await connectedClient(
      completeRegistry({ jetkvm_session_connect: handler }),
      undefined,
      { admissionKey, lifetimeSignal: lifetime.signal },
    );
    await expect(
      lifetimeClient.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "pre-aborted-lifetime", timeout_ms: 100 },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.ConnectionClosed });
    expect(handler).not.toHaveBeenCalled();

    const liveClient = await connectedClient(
      completeRegistry({ jetkvm_session_connect: handler }),
      undefined,
      { admissionKey },
    );
    const requestCancellation = new AbortController();
    requestCancellation.abort();
    await expect(
      liveClient.callTool(
        {
          name: "jetkvm_session_connect",
          arguments: { request_id: "pre-aborted-request", timeout_ms: 100 },
        },
        undefined,
        { signal: requestCancellation.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(handler).not.toHaveBeenCalled();

    const duringParse = new AbortController();
    const pending = liveClient.callTool(
      {
        name: "jetkvm_session_connect",
        arguments: { request_id: "cancel-during-parse", timeout_ms: 100 },
      },
      undefined,
      { signal: duringParse.signal },
    );
    duringParse.abort();
    await expect(pending).rejects.toMatchObject({
      code: ErrorCode.RequestTimeout,
    });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();

    await expect(
      liveClient.callTool({
        name: "jetkvm_session_connect",
        arguments: { request_id: "post-cancel-reuse", timeout_ms: 100 },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(handler).toHaveBeenCalledOnce();
  });
});
