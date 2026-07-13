import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  CaptureBridgeRequest,
  CaptureBridgeResult,
} from "./bridgeProtocol.js";
import {
  JPEG_MAX_BYTES,
  PNG_MAX_BYTES,
  materializeCaptureFrame,
} from "./frames.js";

const request: CaptureBridgeRequest = {
  operation_id: "capture-1",
  expected_lifecycle_generation: 2,
  expected_channel_generation: 3,
  timeout_ms: 1_000,
  format: "png",
  max_width: 1280,
  max_height: 720,
};

function resultFor(bytes: Uint8Array): CaptureBridgeResult {
  return {
    operation_id: request.operation_id,
    lifecycle_generation: 2,
    channel_generation: 3,
    display_generation: 4,
    frame_sequence: 7,
    captured_at: "2026-07-13T00:00:00.000Z",
    source_width: 1920,
    source_height: 1080,
    image_width: 1280,
    image_height: 720,
    rotation: 0,
    geometry: { x: 0, y: 0, width: 1280, height: 720 },
    format: "png",
    mime_type: "image/png",
    byte_length: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64: Buffer.from(bytes).toString("base64"),
  };
}

describe("materializeCaptureFrame", () => {
  it("returns bounded authorized bytes separately from byte-free metadata", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const frame = materializeCaptureFrame(resultFor(bytes), request);

    expect(frame.metadata).toEqual({
      frameId: "3:7",
      capturedAt: "2026-07-13T00:00:00.000Z",
      sourceWidth: 1920,
      sourceHeight: 1080,
      imageWidth: 1280,
      imageHeight: 720,
      rotation: 0,
      geometry: {
        contentX: 0,
        contentY: 0,
        contentWidth: 1280,
        contentHeight: 720,
      },
      format: "png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: 3,
      displayGeneration: 4,
    });
    expect(frame.image).toEqual({ mimeType: "image/png", bytes });
    expect(JSON.stringify(frame.metadata)).not.toContain("AQID");
    expect(Object.keys(frame.image).sort()).toEqual(["bytes", "mimeType"]);
  });

  it("rejects noncanonical base64, byte-count mismatch, and hash mismatch", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = resultFor(bytes);
    expect(() =>
      materializeCaptureFrame({ ...result, base64: "AQID\n" }, request),
    ).toThrow(/base64/i);
    expect(() =>
      materializeCaptureFrame({ ...result, byte_length: 4 }, request),
    ).toThrow(/length/i);
    expect(() =>
      materializeCaptureFrame({ ...result, sha256: "0".repeat(64) }, request),
    ).toThrow(/SHA-256/i);
  });

  it("rejects cropping, upscaling, wrong bounds, and aspect distortion", () => {
    const result = resultFor(new Uint8Array([1, 2, 3]));
    expect(() =>
      materializeCaptureFrame(
        {
          ...result,
          image_width: 1281,
          geometry: { x: 0, y: 0, width: 1281, height: 720 },
        },
        request,
      ),
    ).toThrow(/bound/i);
    expect(() =>
      materializeCaptureFrame(
        {
          ...result,
          source_width: 1000,
          source_height: 500,
          image_width: 1001,
          image_height: 500,
          geometry: { x: 0, y: 0, width: 1001, height: 500 },
        },
        { ...request, max_width: 1920, max_height: 1080 },
      ),
    ).toThrow(/upscale/i);
    expect(() =>
      materializeCaptureFrame(
        {
          ...result,
          image_height: 719,
          geometry: { x: 0, y: 0, width: 1280, height: 719 },
        },
        request,
      ),
    ).toThrow(/aspect/i);
  });

  it("enforces the exact pre-base64 JPEG and PNG byte caps", () => {
    const pngBoundary = new Uint8Array(PNG_MAX_BYTES);
    expect(() =>
      materializeCaptureFrame(resultFor(pngBoundary), request),
    ).not.toThrow();
    const pngOver = new Uint8Array(PNG_MAX_BYTES + 1);
    expect(() => materializeCaptureFrame(resultFor(pngOver), request)).toThrow(
      /byte limit/i,
    );

    const jpegBoundary = new Uint8Array(JPEG_MAX_BYTES);
    const jpegRequest = { ...request, format: "jpeg" as const };
    const jpegResult = {
      ...resultFor(jpegBoundary),
      format: "jpeg" as const,
      mime_type: "image/jpeg" as const,
    };
    expect(() =>
      materializeCaptureFrame(jpegResult, jpegRequest),
    ).not.toThrow();
    const jpegOver = new Uint8Array(JPEG_MAX_BYTES + 1);
    expect(() =>
      materializeCaptureFrame(
        {
          ...jpegResult,
          byte_length: jpegOver.byteLength,
          sha256: createHash("sha256").update(jpegOver).digest("hex"),
          base64: Buffer.from(jpegOver).toString("base64"),
        },
        jpegRequest,
      ),
    ).toThrow(/byte limit/i);
  });
});
