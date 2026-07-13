import { describe, expect, it } from "vitest";
import { createStructuredLogger, redactStructuredData } from "./logger.js";

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
