import { describe, expect, it } from "vitest";
import { createStructuredLogger, redactStructuredData } from "./logger.js";

function requireRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a record");
  }
}

describe("structured redacting logger", () => {
  it("writes deterministic one-line structured records to the injected sink", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line),
      now: () => new Date("2026-07-13T12:00:00.000Z"),
    });

    logger.info("session.connected", { sessionId: "opaque", generation: 2 });

    expect(lines).toEqual([
      '{"timestamp":"2026-07-13T12:00:00.000Z","level":"info","event":"session.connected","fields":{"sessionId":"opaque","generation":2}}\n',
    ]);
  });

  it.each([
    ["URL", { targetUrl: "https://operator:secret@jetkvm.lan/ui?token=x" }],
    ["bearer", { authorization: "Bearer abc.def.ghi" }],
    ["cookie", { headers: { cookie: "session=private" } }],
    ["credential", { password: "device-password", apiToken: "token-value" }],
    ["proof", { leaseProof: "proof-value" }],
    ["SDP", { answerSdp: "v=0\r\na=fingerprint:secret" }],
    ["ICE", { iceCandidate: "candidate:1 1 UDP 1 192.0.2.1 123 typ host" }],
    ["frame", { frameBytes: Buffer.from("private-frame") }],
    ["image", { screenshotBase64: "cHJpdmF0ZS1pbWFnZQ==" }],
    ["paste", { pastePayload: "private pasted text" }],
  ])("never emits %s material", (_label, fields) => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line),
      now: () => new Date(0),
    });

    logger.warn("operation.failed", fields);

    const output = lines.join("");
    expect(output).toContain("[REDACTED]");
    for (const forbidden of [
      "jetkvm.lan",
      "operator:secret",
      "abc.def.ghi",
      "session=private",
      "device-password",
      "token-value",
      "proof-value",
      "fingerprint:secret",
      "192.0.2.1",
      "private-frame",
      "cHJpdmF0ZS1pbWFnZQ==",
      "private pasted text",
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });

  it("redacts sensitive strings even under innocent field names and inside errors", () => {
    const redacted = redactStructuredData({
      note: "request failed for https://jetkvm.lan/private",
      reason: new Error("authorization Bearer super-secret failed"),
      network: "candidate:7 1 udp 1 10.0.0.2 5000 typ host",
      offer: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-",
      content: "data:image/jpeg;base64,cHJpdmF0ZQ==",
    });
    const output = JSON.stringify(redacted);

    expect(output).not.toMatch(
      /jetkvm|super-secret|10\.0\.0\.2|127\.0\.0\.1|cHJpdmF0ZQ/,
    );
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("at ");
  });

  it("redacts credential assignments and every Error message to stable diagnostics", () => {
    const redacted = redactStructuredData({
      note: "JETKVM_CREDENTIAL=super-secret",
      detail: "password: hunter2",
      reason: new Error("apparently harmless but unclassified downstream text"),
    });

    expect(redacted).toEqual({
      note: "[REDACTED]",
      detail: "[REDACTED]",
      reason: { name: "Error", message: "[REDACTED]" },
    });
    expect(JSON.stringify(redacted)).not.toMatch(
      /super-secret|hunter2|downstream/,
    );
  });

  it("recursively sanitizes serialized JSON and malformed quoted sensitive keys", () => {
    const serialized = JSON.stringify({
      status: "still-useful",
      nested: JSON.stringify({
        password: "json-password",
        authorization: "json-authorization",
        cookie: "json-cookie",
        refreshToken: "json-token",
        callbackURL: "https://json-url.invalid/private",
        values: [JSON.stringify({ password: "array-password" })],
      }),
    });
    const malformed = String.raw`{\"password\":\"broken-password\",\"authorization\":\"broken-authorization\",\"cookie\":\"broken-cookie\",\"token\":\"broken-token\",\"URL\":\"https://broken-url.invalid`;
    const fields = { serialized, malformed };
    const redacted = redactStructuredData(fields);
    requireRecord(redacted);
    if (
      typeof redacted.serialized !== "string" ||
      typeof redacted.malformed !== "string"
    ) {
      throw new TypeError("Expected redacted strings");
    }
    const outer: unknown = JSON.parse(redacted.serialized);
    requireRecord(outer);
    if (typeof outer.status !== "string" || typeof outer.nested !== "string") {
      throw new TypeError("Expected serialized outer fields");
    }
    const nested: unknown = JSON.parse(outer.nested);
    requireRecord(nested);
    if (!Array.isArray(nested.values) || typeof nested.values[0] !== "string") {
      throw new TypeError("Expected a nested serialized array value");
    }

    expect(outer.status).toBe("still-useful");
    expect(nested).toMatchObject({
      password: "[REDACTED]",
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      refreshToken: "[REDACTED]",
      callbackURL: "[REDACTED]",
    });
    expect(JSON.parse(nested.values[0])).toEqual({
      password: "[REDACTED]",
    });
    expect(redacted.malformed).toBe("[REDACTED]");

    const lines: string[] = [];
    createStructuredLogger({ write: (line) => lines.push(line) }).info(
      "serialized.received",
      fields,
    );
    for (const output of [JSON.stringify(redacted), lines.join("")]) {
      expect(output).not.toMatch(
        /json-password|json-authorization|json-cookie|json-token|json-url|array-password|broken-password|broken-authorization|broken-cookie|broken-token|broken-url/,
      );
    }
  });

  it("allowlists Error names while keeping every message stably redacted", () => {
    const malicious = new Error("message-secret");
    malicious.name = "Bearer name-secret";

    const fields = {
      malicious,
      standard: new TypeError("type-message-secret"),
    };
    const redacted = redactStructuredData(fields);

    expect(redacted).toEqual({
      malicious: { name: "Error", message: "[REDACTED]" },
      standard: { name: "TypeError", message: "[REDACTED]" },
    });
    const lines: string[] = [];
    createStructuredLogger({ write: (line) => lines.push(line) }).error(
      "operation.failed",
      fields,
    );
    for (const output of [JSON.stringify(redacted), lines.join("")]) {
      expect(output).not.toMatch(
        /name-secret|message-secret|type-message-secret/,
      );
    }
  });

  it("redacts nested MCP images and binary data containers by shape", () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef,
    ]).toString("base64");
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0xca, 0xfe, 0xba, 0xbe,
    ]).toString("base64");
    const circular: Record<string, unknown> = { data: "business-data" };
    circular.items = [[circular]];
    const fields = {
      content: [
        { type: "image", data: png, mimeType: "image/png" },
        [{ type: "image", data: jpeg, mimeType: "image/jpeg" }],
      ],
      binary: {
        data: Buffer.from("binary-secret"),
        encoding: "raw",
      },
      business: {
        data: "quarterly-report",
        content: "status-ready",
      },
      circular,
    };

    const redacted = redactStructuredData(fields);

    expect(redacted).toEqual({
      content: [
        {
          type: "image",
          data: "[REDACTED]",
          mimeType: "image/png",
        },
        [
          {
            type: "image",
            data: "[REDACTED]",
            mimeType: "image/jpeg",
          },
        ],
      ],
      binary: {
        data: "[REDACTED]",
        encoding: "raw",
      },
      business: {
        data: "quarterly-report",
        content: "status-ready",
      },
      circular: {
        data: "business-data",
        items: [["[REDACTED]"]],
      },
    });

    const lines: string[] = [];
    createStructuredLogger({ write: (line) => lines.push(line) }).info(
      "capture.complete",
      fields,
    );
    for (const output of [JSON.stringify(redacted), lines.join("")]) {
      expect(output).not.toContain(png);
      expect(output).not.toContain(jpeg);
      expect(output).not.toContain("binary-secret");
    }
  });

  it("preserves allowlisted operational metadata without mutating the input", () => {
    const input = Object.freeze({
      operationId: "op-123",
      sessionGeneration: 4,
      outcome: "not_sent",
      counts: Object.freeze({ dispatched: 0, queued: 2 }),
      safeToRetry: true,
      detail: null,
    });

    expect(redactStructuredData(input)).toEqual(input);
  });

  it("redacts circular references, binary values, and unsafe event names", () => {
    const cyclic: Record<string, unknown> = { operationId: "op-1" };
    cyclic.self = cyclic;
    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line),
    });

    logger.error("https://jetkvm.lan", {
      cyclic,
      bytes: new Uint8Array([115, 101, 99, 114, 101, 116]),
    });

    expect(lines.join("")).not.toContain("jetkvm.lan");
    expect(lines.join("")).not.toContain("secret");
    expect(lines.join("")).toContain("[REDACTED]");
  });

  it("contains no helper capable of bypassing redaction with raw text", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line),
    });

    expect(Object.keys(logger).sort()).toEqual([
      "debug",
      "error",
      "info",
      "warn",
    ]);
    expect(() =>
      logger.info(
        "event",
        "raw https://jetkvm.lan" as unknown as Record<string, unknown>,
      ),
    ).toThrowError("Structured log fields must be a plain object");
    expect(lines).toEqual([]);
  });
});
