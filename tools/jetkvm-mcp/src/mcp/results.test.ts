import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  CapabilitySnapshot,
  DisplayCaptureResult,
  Success,
  ToolError,
} from "../domain.js";
import { CAPABILITY_NAMES } from "../domain.js";
import {
  PUBLIC_ERROR_MESSAGES,
  toMcpErrorResult,
  toMcpSuccessResult,
  validateAndMapMcpResult,
  type AuthorizedImage,
} from "./results.js";

const imageBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const imageBase64 = Buffer.from(imageBytes).toString("base64");
const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
const authorizedImage: AuthorizedImage = {
  bytes: imageBytes,
  mime_type: "image/jpeg",
};
const capture: DisplayCaptureResult = {
  observation_id: "observation-1",
  connection_epoch: 1,
  display_generation: 2,
  frame_id: "frame-1",
  captured_at: "2026-07-13T00:00:00.000Z",
  source_width: 6,
  source_height: 1,
  image_width: 6,
  image_height: 1,
  rotation: 0,
  geometry: {
    content_x: 0,
    content_y: 0,
    content_width: 6,
    content_height: 1,
  },
  image: {
    content_index: 1,
    mime_type: "image/jpeg",
    sha256: imageSha256,
    byte_length: imageBytes.byteLength,
  },
};
const captureEnvelope: Success<DisplayCaptureResult> = {
  ok: true,
  tool: "jetkvm_display_capture",
  operation_id: "operation-1",
  session_id: "session-1",
  session_generation: 1,
  duration_ms: 5,
  result: capture,
};

function captureEnvelopeWithImage(
  bytes: Uint8Array,
  mimeType: "image/jpeg" | "image/png",
): Success<DisplayCaptureResult> {
  return {
    ...captureEnvelope,
    result: {
      ...captureEnvelope.result,
      image: {
        content_index: 1,
        mime_type: mimeType,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byte_length: bytes.byteLength,
      },
    },
  };
}

function inboundImageResult(
  envelope: Success<DisplayCaptureResult>,
  data: string,
  mimeType: "image/jpeg" | "image/png",
) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(envelope) },
      { type: "image" as const, data, mimeType },
    ],
    structuredContent: envelope,
  };
}

function countBase64Decodes(calls: readonly (readonly unknown[])[]): number {
  return calls.filter((call) => call[1] === "base64").length;
}

describe("MCP result mapping", () => {
  it("maps non-image successes to identical structured and compact text content", () => {
    const capabilities = Object.fromEntries(
      CAPABILITY_NAMES.map((name) => [name, true]),
    ) as unknown as CapabilitySnapshot;
    const envelope = {
      ok: true,
      tool: "jetkvm_session_connect",
      operation_id: "operation-2",
      session_id: "session-2",
      session_generation: 1,
      duration_ms: 10,
      result: {
        request_id: "request-2",
        outcome: "applied",
        verification: "device_ack_only",
        safe_to_retry: false,
        required_next_step: "none",
        state: "ready",
        connection_epoch: 1,
        display_generation: 1,
        takeover_performed: false,
        fresh_capture_required: true,
        permissions: ["session.connect"],
        capabilities,
      },
    } as const;

    const mapped = toMcpSuccessResult(envelope);
    expect(mapped.isError).toBeUndefined();
    expect(mapped.structuredContent).toEqual(envelope);
    expect(mapped.content).toEqual([
      { type: "text", text: JSON.stringify(envelope) },
    ]);
  });

  it("places screenshot bytes only in the authorized MCP image block", () => {
    const mapped = toMcpSuccessResult(captureEnvelope, authorizedImage);
    expect(mapped.content).toEqual([
      { type: "text", text: JSON.stringify(captureEnvelope) },
      { type: "image", data: imageBase64, mimeType: "image/jpeg" },
    ]);
    expect(mapped.structuredContent).toEqual(captureEnvelope);

    const serializedStructured = JSON.stringify(mapped.structuredContent);
    const textContent = mapped.content[0];
    expect(textContent?.type).toBe("text");
    if (textContent?.type !== "text") throw new Error("expected text content");
    expect(serializedStructured).not.toContain(imageBase64);
    expect(textContent.text).not.toContain(imageBase64);
    expect(JSON.stringify(captureEnvelope)).not.toContain(imageBase64);
    expect(JSON.stringify(mapped.content[1])).toContain(imageBase64);
  });

  it("requires exact authorized image metadata and canonical MIME", () => {
    expect(() => toMcpSuccessResult(captureEnvelope)).toThrow(
      "Image content is required by result metadata.",
    );
    expect(() =>
      toMcpSuccessResult(captureEnvelope, {
        bytes: Uint8Array.from([1, 2, 3]),
        mime_type: "image/jpeg",
      }),
    ).toThrow("Image content does not match result metadata.");
    expect(() =>
      toMcpSuccessResult(captureEnvelope, {
        bytes: imageBytes,
        mime_type: "image/png",
      }),
    ).toThrow("Image content does not match result metadata.");
    for (const image of [
      { ...capture.image, sha256: "0".repeat(64) },
      { ...capture.image, byte_length: imageBytes.byteLength + 1 },
    ]) {
      expect(() =>
        toMcpSuccessResult(
          {
            ...captureEnvelope,
            result: { ...captureEnvelope.result, image },
          },
          authorizedImage,
        ),
      ).toThrow("Image content does not match result metadata.");
    }
    expect(() =>
      toMcpSuccessResult(
        {
          ...captureEnvelope,
          result: {
            ...captureEnvelope.result,
            image: { ...capture.image, content_index: 0 },
          },
        } as never,
        authorizedImage,
      ),
    ).toThrow("Invalid tool success envelope.");
  });

  it("maps authorized PNG content with exact digest, length, index, and isolation", () => {
    const pngEnvelope = {
      ...captureEnvelope,
      result: {
        ...captureEnvelope.result,
        image: {
          ...captureEnvelope.result.image,
          mime_type: "image/png" as const,
        },
      },
    };
    const mapped = toMcpSuccessResult(pngEnvelope, {
      bytes: imageBytes,
      mime_type: "image/png",
    });

    expect(mapped.content).toEqual([
      { type: "text", text: JSON.stringify(pngEnvelope) },
      { type: "image", data: imageBase64, mimeType: "image/png" },
    ]);
    expect(mapped.structuredContent).toEqual(pngEnvelope);
    expect(JSON.stringify(mapped.structuredContent)).not.toContain(imageBase64);
  });

  it("accepts an empty canonical image permitted by the tracked schema", () => {
    const bytes = Buffer.alloc(0);
    const envelope = captureEnvelopeWithImage(bytes, "image/jpeg");

    const mapped = validateAndMapMcpResult(
      "jetkvm_display_capture",
      inboundImageResult(envelope, "", "image/jpeg"),
    );

    expect(mapped.content).toHaveLength(2);
    expect(mapped.content[1]).toEqual({
      type: "image",
      data: "",
      mimeType: "image/jpeg",
    });
    expect(mapped.structuredContent).toEqual(envelope);
  });

  it.each([
    ["image/jpeg", 2 * 1024 * 1024],
    ["image/png", 8 * 1024 * 1024],
  ] as const)("accepts the exact %s byte maximum", (mimeType, maximum) => {
    const bytes = Buffer.alloc(maximum);
    const envelope = captureEnvelopeWithImage(bytes, mimeType);
    const data = bytes.toString("base64");

    const mapped = validateAndMapMcpResult(
      "jetkvm_display_capture",
      inboundImageResult(envelope, data, mimeType),
    );

    expect(mapped.content).toHaveLength(2);
    expect(mapped.content[1]).toMatchObject({
      type: "image",
      data,
      mimeType,
    });
    expect(envelope.result.image).toEqual({
      content_index: 1,
      mime_type: mimeType,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_length: maximum,
    });
  });

  it("rejects encoded data over the MIME maximum before decoding", () => {
    const maximum = 2 * 1024 * 1024;
    const bytes = Buffer.alloc(maximum);
    const envelope = captureEnvelopeWithImage(bytes, "image/jpeg");
    const maximumEncodedLength = 4 * Math.ceil(maximum / 3);
    const oversized = "A".repeat(maximumEncodedLength + 1);
    const fromSpy = vi.spyOn(Buffer, "from");

    try {
      expect(() =>
        validateAndMapMcpResult(
          "jetkvm_display_capture",
          inboundImageResult(envelope, oversized, "image/jpeg"),
        ),
      ).toThrow("Invalid handler result.");
      expect(countBase64Decodes(fromSpy.mock.calls)).toBe(0);
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("rejects huge encoded data for a one-byte claim before decoding", () => {
    const bytes = Uint8Array.of(0);
    const envelope = captureEnvelopeWithImage(bytes, "image/png");
    const huge = "A".repeat(4 * Math.ceil((2 * 1024 * 1024) / 3));
    const fromSpy = vi.spyOn(Buffer, "from");

    try {
      expect(() =>
        validateAndMapMcpResult(
          "jetkvm_display_capture",
          inboundImageResult(envelope, huge, "image/png"),
        ),
      ).toThrow("Invalid handler result.");
      expect(countBase64Decodes(fromSpy.mock.calls)).toBe(0);
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("rejects noncanonical base64 padding before decoding", () => {
    const bytes = Uint8Array.of(0xff);
    const envelope = captureEnvelopeWithImage(bytes, "image/jpeg");
    const fromSpy = vi.spyOn(Buffer, "from");

    try {
      expect(() =>
        validateAndMapMcpResult(
          "jetkvm_display_capture",
          inboundImageResult(envelope, "/x==", "image/jpeg"),
        ),
      ).toThrow("Invalid handler result.");
      expect(countBase64Decodes(fromSpy.mock.calls)).toBe(0);
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("rejects decoded image length and digest mismatches", () => {
    const oneByte = Uint8Array.of(0);
    const oneByteEnvelope = captureEnvelopeWithImage(oneByte, "image/jpeg");
    expect(() =>
      validateAndMapMcpResult(
        "jetkvm_display_capture",
        inboundImageResult(oneByteEnvelope, "AAA=", "image/jpeg"),
      ),
    ).toThrow("Image content does not match result metadata.");

    expect(() =>
      validateAndMapMcpResult(
        "jetkvm_display_capture",
        inboundImageResult(oneByteEnvelope, "/w==", "image/jpeg"),
      ),
    ).toThrow("Image content does not match result metadata.");
  });

  it("decodes canonical image data exactly once and preserves its identity", () => {
    const bytes = Uint8Array.of(0, 1, 2, 3);
    const envelope = captureEnvelopeWithImage(bytes, "image/png");
    const data = Buffer.from(bytes).toString("base64");
    const fromSpy = vi.spyOn(Buffer, "from");

    try {
      const mapped = validateAndMapMcpResult(
        "jetkvm_display_capture",
        inboundImageResult(envelope, data, "image/png"),
      );
      expect(countBase64Decodes(fromSpy.mock.calls)).toBe(1);
      expect(mapped.content).toEqual([
        { type: "text", text: JSON.stringify(envelope) },
        { type: "image", data, mimeType: "image/png" },
      ]);
      expect(mapped.structuredContent).toEqual(envelope);
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("rejects image bytes for results without image metadata", () => {
    const envelope = {
      ok: true,
      tool: "jetkvm_input_release",
      operation_id: "operation-3",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 2,
      result: {
        request_id: "request-3",
        outcome: "applied",
        verification: "device_state_verified",
        safe_to_retry: false,
        required_next_step: "none",
        mutation_gate_closed: true,
        deferred_producers_joined: true,
        paste_terminal: "inactive",
        ordinary_leases_zero: true,
        keyboard_zero: true,
        pointer_zero: true,
        generation_drained: true,
      },
    } as const;
    expect(() => toMcpSuccessResult(envelope, authorizedImage)).toThrow(
      "Image content is not authorized for this result.",
    );
  });

  it("rejects image data smuggled into structured results", () => {
    const smuggled = {
      ...captureEnvelope,
      result: {
        ...captureEnvelope.result,
        image: { ...captureEnvelope.result.image, data: imageBase64 },
      },
    };
    expect(() => toMcpSuccessResult(smuggled, authorizedImage)).toThrow(
      "Invalid tool success envelope.",
    );
  });

  it("maps actionable errors identically to structured content and compact text", () => {
    const envelope: ToolError = {
      ok: false,
      tool: "jetkvm_input_mouse",
      operation_id: "operation-4",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 3,
      error: {
        code: "CONNECTION_LOST",
        message: "The device connection was lost.",
        phase: "execute",
        outcome: "unknown",
        verification: "none",
        safe_to_retry: false,
        required_next_step: "inspect_device_state_before_retry",
        details: {
          permission: null,
          capability: null,
          failed_action_index: 0,
          dispatched_action_count: 1,
          completed_action_count: 0,
          downstream_stage: "write",
          expected_generation: 1,
          actual_generation: null,
          observation_id: "observation-1",
        },
      },
    };
    const mapped = toMcpErrorResult(envelope);
    expect(mapped.isError).toBe(true);
    expect(mapped.structuredContent).toEqual(envelope);
    expect(mapped.content).toEqual([
      { type: "text", text: JSON.stringify(mapped.structuredContent) },
    ]);
    expect(JSON.stringify(mapped)).not.toContain(imageBase64);
  });

  it("publishes the canonical admission-capacity error message", () => {
    expect(PUBLIC_ERROR_MESSAGES.ADMISSION_CAPACITY_EXCEEDED).toBe(
      "The request ledger is at admission capacity.",
    );
  });

  it("replaces handler-controlled error messages with stable code-specific public text", () => {
    const secret =
      "https://admin:password@example.test Authorization: Bearer top-secret cookie=session";
    const envelope: ToolError = {
      ok: false,
      tool: "jetkvm_input_mouse",
      operation_id: "operation-unsafe",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 3,
      error: {
        code: "MUTATION_OUTCOME_UNKNOWN",
        message: secret,
        phase: "execute",
        outcome: "unknown",
        verification: "none",
        safe_to_retry: false,
        required_next_step: "inspect_device_state_before_retry",
        details: {
          permission: null,
          capability: null,
          failed_action_index: 0,
          dispatched_action_count: 1,
          completed_action_count: 0,
          downstream_stage: "write",
          expected_generation: 1,
          actual_generation: null,
          observation_id: "observation-1",
        },
      },
    };

    const mapped = toMcpErrorResult(envelope);
    expect(mapped.structuredContent).toMatchObject({
      error: {
        code: "MUTATION_OUTCOME_UNKNOWN",
        message: PUBLIC_ERROR_MESSAGES.MUTATION_OUTCOME_UNKNOWN,
      },
    });
    expect(JSON.stringify(mapped)).not.toContain(secret);
    expect(mapped.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(mapped.structuredContent),
      },
    ]);
  });

  it("rejects error envelopes containing image or unknown evidence fields", () => {
    const error = {
      ok: false,
      tool: "jetkvm_display_capture",
      operation_id: "operation-5",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 1,
      error: {
        code: "FRAME_TIMEOUT",
        message: "Timed out waiting for a frame.",
        phase: "execute",
        outcome: null,
        verification: "none",
        safe_to_retry: true,
        required_next_step: "capture_then_retry",
        details: {
          permission: null,
          capability: null,
          failed_action_index: null,
          dispatched_action_count: null,
          completed_action_count: null,
          downstream_stage: "none",
          expected_generation: null,
          actual_generation: null,
          observation_id: null,
          evidence: imageBase64,
        },
      },
    };
    expect(() => toMcpErrorResult(error as never)).toThrow(
      "Invalid tool error envelope.",
    );
  });
});
