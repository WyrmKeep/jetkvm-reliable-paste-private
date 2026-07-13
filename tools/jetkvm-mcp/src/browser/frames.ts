import { createHash, timingSafeEqual } from "node:crypto";

import type {
  BrowserCaptureImage,
  ObservationGeometry,
} from "../planes/BrowserPlane.js";
import {
  parseCaptureBridgeRequest,
  parseCaptureBridgeResult,
  type CaptureBridgeRequest,
  type CaptureBridgeResult,
} from "./bridgeProtocol.js";

export const JPEG_MAX_BYTES = 2 * 1024 * 1024;
export const PNG_MAX_BYTES = 8 * 1024 * 1024;

export interface ValidatedFrameMetadata {
  readonly frameId: string;
  readonly capturedAt: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly rotation: 0;
  readonly geometry: ObservationGeometry;
  readonly format: "jpeg" | "png";
  readonly sha256: string;
  readonly byteLength: number;
  readonly displayGeneration: number;
}

export interface ValidatedCaptureFrame {
  /** Byte-free metadata safe for observations, errors, and logs. */
  readonly metadata: ValidatedFrameMetadata;
  /** The only authorized in-process image byte container. */
  readonly image: BrowserCaptureImage;
}

function assertAspectPreservingDimensions(
  result: CaptureBridgeResult,
  request: CaptureBridgeRequest,
): void {
  if (
    result.image_width > request.max_width ||
    result.image_height > request.max_height
  ) {
    throw new RangeError(
      "Captured image dimensions exceed the requested bound.",
    );
  }
  if (
    result.image_width > result.source_width ||
    result.image_height > result.source_height
  ) {
    throw new RangeError(
      "Captured image dimensions may not upscale the source.",
    );
  }
  const scale = Math.min(
    1,
    request.max_width / result.source_width,
    request.max_height / result.source_height,
  );
  const expectedWidth = Math.max(1, Math.floor(result.source_width * scale));
  const expectedHeight = Math.max(1, Math.floor(result.source_height * scale));
  if (
    result.image_width !== expectedWidth ||
    result.image_height !== expectedHeight
  ) {
    throw new RangeError(
      "Captured image dimensions distort the source aspect ratio.",
    );
  }
}

export function materializeCaptureFrame(
  rawResult: CaptureBridgeResult,
  rawRequest: CaptureBridgeRequest,
): ValidatedCaptureFrame {
  const request = parseCaptureBridgeRequest(rawRequest);
  if (
    typeof rawResult === "object" &&
    rawResult !== null &&
    "byte_length" in rawResult &&
    typeof rawResult.byte_length === "number"
  ) {
    const cap = request.format === "jpeg" ? JPEG_MAX_BYTES : PNG_MAX_BYTES;
    if (rawResult.byte_length > cap) {
      throw new RangeError("Captured frame exceeds its byte limit.");
    }
  }
  const result = parseCaptureBridgeResult(rawResult);
  if (result.operation_id !== request.operation_id) {
    throw new TypeError("Captured frame operation correlation is invalid.");
  }
  if (result.format !== request.format) {
    throw new TypeError("Captured frame format does not match the request.");
  }
  const byteCap = result.format === "jpeg" ? JPEG_MAX_BYTES : PNG_MAX_BYTES;
  if (result.byte_length > byteCap) {
    throw new RangeError("Captured frame exceeds its byte limit.");
  }
  assertAspectPreservingDimensions(result, request);
  if (result.base64.length === 0 || result.base64.length % 4 !== 0) {
    throw new TypeError("Captured frame base64 is not canonical.");
  }
  const decoded = Buffer.from(result.base64, "base64");
  if (decoded.toString("base64") !== result.base64) {
    throw new TypeError("Captured frame base64 is not canonical.");
  }
  const bytes = new Uint8Array(
    decoded.buffer,
    decoded.byteOffset,
    decoded.byteLength,
  );
  if (bytes.byteLength !== result.byte_length) {
    throw new TypeError(
      "Captured frame byte length does not match its receipt.",
    );
  }
  const actualHash = createHash("sha256").update(decoded).digest();
  const receiptHash = Buffer.from(result.sha256, "hex");
  if (
    actualHash.byteLength !== receiptHash.byteLength ||
    !timingSafeEqual(actualHash, receiptHash)
  ) {
    throw new TypeError("Captured frame SHA-256 does not match its receipt.");
  }
  return {
    metadata: {
      frameId: `${result.channel_generation}:${result.frame_sequence}`,
      capturedAt: result.captured_at,
      sourceWidth: result.source_width,
      sourceHeight: result.source_height,
      imageWidth: result.image_width,
      imageHeight: result.image_height,
      rotation: 0,
      geometry: {
        contentX: result.geometry.x,
        contentY: result.geometry.y,
        contentWidth: result.geometry.width,
        contentHeight: result.geometry.height,
      },
      format: result.format,
      sha256: result.sha256,
      byteLength: result.byte_length,
      displayGeneration: result.display_generation,
    },
    image: {
      mimeType: result.mime_type,
      bytes,
    },
  };
}
