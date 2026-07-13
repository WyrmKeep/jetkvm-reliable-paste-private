import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ERROR_CODES, type ErrorCode } from "../errors.js";

import type {
  DisplayCaptureResult,
  JetKvmToolName,
  Success,
  ToolError,
} from "../domain.js";
import {
  displayCaptureResultSchema,
  TOOL_RESULT_SCHEMAS,
  toolErrorSchema,
} from "./schemas.js";

export type AuthorizedImage = {
  readonly bytes: Uint8Array;
  readonly mime_type: "image/jpeg" | "image/png";
};

export const PUBLIC_ERROR_MESSAGES = {
  CONFIG_INVALID: "The server configuration is invalid.",
  AUTH_FAILED: "Authentication failed.",
  AUTH_RATE_LIMITED: "Authentication is temporarily rate limited.",
  AUTH_EXPIRED: "Authentication has expired.",
  PERMISSION_DENIED: "The required permission was not granted.",
  OBSERVE_ONLY: "The current policy permits observation only.",
  SAFETY_DENIED: "The requested operation was denied by safety policy.",
  CAPABILITY_MISSING: "The required device capability is unavailable.",
  UNSUPPORTED_UI_VERSION: "The JetKVM UI version is unsupported.",
  FIRMWARE_INCOMPATIBLE: "The JetKVM firmware is incompatible.",
  BROWSER_UNSUPPORTED: "The configured browser is unsupported.",
  SESSION_NOT_FOUND: "The device session was not found.",
  STALE_SESSION_GENERATION: "The device session generation is stale.",
  SESSION_TAKEN_OVER: "The device session was taken over.",
  CONTROL_BUSY: "The configured device is controlled by another session.",
  SESSION_DRAINED: "The device session has been drained.",
  DEVICE_UNREACHABLE: "The configured device is unreachable.",
  CONNECTION_LOST: "The device connection was lost.",
  DOWNSTREAM_MALFORMED_RESPONSE: "The device returned a malformed response.",
  VIDEO_UNAVAILABLE: "Video is unavailable.",
  VIDEO_STALLED: "Video has stalled.",
  FRAME_TIMEOUT: "Timed out waiting for a fresh frame.",
  STALE_OBSERVATION: "The observation is stale.",
  OBSERVATION_CONSUMED: "The observation was already consumed.",
  DISPLAY_CHANGED: "The display changed after the observation.",
  EDID_READ_FAILED: "The display EDID read failed.",
  DISPLAY_STATUS_STALE: "The display status is stale.",
  INVALID_COORDINATE: "The requested coordinate is invalid.",
  INVALID_KEY: "The requested key is invalid.",
  UNSUPPORTED_SCROLL_AXIS: "The requested scroll axis is unsupported.",
  PASTE_BUSY: "A reliable paste operation is already active.",
  PASTE_REJECTED: "The reliable paste operation was rejected.",
  PASTE_FAILED: "The reliable paste operation failed.",
  PASTE_CANCELLED: "The reliable paste operation was cancelled.",
  EVENT_GAP: "The device input event stream has a gap.",
  POWER_ACTION_REJECTED: "The power action was rejected.",
  ATX_EXTENSION_INACTIVE: "The ATX extension is inactive.",
  ATX_SERIAL_UNAVAILABLE: "The ATX serial connection is unavailable.",
  ATX_BUSY: "Another ATX action is active.",
  POWER_STATE_UNVERIFIED: "The device power state could not be verified.",
  CANCELLED: "The operation was cancelled.",
  DEADLINE_EXCEEDED: "The operation deadline was exceeded.",
  MUTATION_OUTCOME_UNKNOWN: "The mutation outcome is unknown.",
  PARTIAL_VERIFICATION:
    "The mutation was acknowledged but only partially verified.",
  REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT:
    "The request ID was already used with different input.",
} as const satisfies Record<ErrorCode, string>;

if (Object.keys(PUBLIC_ERROR_MESSAGES).length !== ERROR_CODES.length) {
  throw new Error("Public error message catalogue is incomplete.");
}

type ImageMetadata = DisplayCaptureResult["image"];
const postCaptureCarrierSchema = z
  .object({ post_capture: displayCaptureResultSchema.nullable() })
  .passthrough();

function imageMetadataFor(
  tool: JetKvmToolName,
  result: unknown,
): ImageMetadata | null {
  switch (tool) {
    case "jetkvm_display_capture":
      return displayCaptureResultSchema.parse(result).image;
    case "jetkvm_input_keyboard":
    case "jetkvm_input_mouse":
    case "jetkvm_input_paste":
      return postCaptureCarrierSchema.parse(result).post_capture?.image ?? null;
    case "jetkvm_display_status":
    case "jetkvm_input_release":
    case "jetkvm_power_control":
    case "jetkvm_session_connect":
    case "jetkvm_session_reconnect":
    case "jetkvm_session_status":
      return null;
  }
}

function validateSuccessEnvelope(envelope: Success<unknown>): void {
  if (!Object.hasOwn(TOOL_RESULT_SCHEMAS, envelope.tool)) {
    throw new Error("Invalid tool success envelope.");
  }
  const parsed = TOOL_RESULT_SCHEMAS[envelope.tool].safeParse(envelope);
  if (!parsed.success || !envelope.ok) {
    throw new Error("Invalid tool success envelope.");
  }
}

function matchesImageMetadata(
  image: AuthorizedImage,
  metadata: ImageMetadata,
): boolean {
  if (
    image.mime_type !== metadata.mime_type ||
    image.bytes.byteLength !== metadata.byte_length ||
    metadata.content_index !== 1
  ) {
    return false;
  }
  const actualSha256 = createHash("sha256").update(image.bytes).digest("hex");
  return actualSha256 === metadata.sha256;
}

export function toMcpSuccessResult<T>(
  envelope: Success<T>,
  image?: AuthorizedImage,
): CallToolResult {
  validateSuccessEnvelope(envelope);
  const metadata = imageMetadataFor(envelope.tool, envelope.result);
  if (metadata === null && image !== undefined) {
    throw new Error("Image content is not authorized for this result.");
  }
  if (metadata !== null && image === undefined) {
    throw new Error("Image content is required by result metadata.");
  }
  if (
    metadata !== null &&
    image !== undefined &&
    !matchesImageMetadata(image, metadata)
  ) {
    throw new Error("Image content does not match result metadata.");
  }

  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify(envelope) },
  ];
  if (image !== undefined) {
    const bytes = Buffer.from(
      image.bytes.buffer,
      image.bytes.byteOffset,
      image.bytes.byteLength,
    );
    content.push({
      type: "image",
      data: bytes.toString("base64"),
      mimeType: image.mime_type,
    });
  }
  return { content, structuredContent: envelope };
}

export function toMcpErrorResult(envelope: ToolError): CallToolResult {
  const parsed = toolErrorSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error("Invalid tool error envelope.");
  }
  const sanitized = {
    ...parsed.data,
    error: {
      ...parsed.data.error,
      message: PUBLIC_ERROR_MESSAGES[parsed.data.error.code as ErrorCode],
    },
  } as ToolError;
  return {
    content: [{ type: "text", text: JSON.stringify(sanitized) }],
    structuredContent: sanitized,
    isError: true,
  };
}

export function validateAndMapMcpResult(
  tool: JetKvmToolName,
  result: CallToolResult,
): CallToolResult {
  if (
    !isExactRecord(
      result,
      ["content", "structuredContent", "isError"],
      ["content", "structuredContent"],
    ) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("Invalid handler result.");
  }
  const parsed = TOOL_RESULT_SCHEMAS[tool].safeParse(result.structuredContent);
  if (!parsed.success || parsed.data.tool !== tool) {
    throw new Error("Invalid handler result.");
  }
  const inputText = result.content[0];
  if (
    !isExactRecord(inputText, ["type", "text"], ["type", "text"]) ||
    inputText.type !== "text" ||
    typeof inputText.text !== "string" ||
    inputText.text !== JSON.stringify(result.structuredContent)
  ) {
    throw new Error("Invalid handler result.");
  }

  if (!parsed.data.ok) {
    if (result.isError !== true || result.content.length !== 1) {
      throw new Error("Invalid handler result.");
    }
    return toMcpErrorResult(parsed.data as ToolError);
  }
  if (
    (result.isError !== undefined && result.isError !== false) ||
    result.content.length > 2
  ) {
    throw new Error("Invalid handler result.");
  }

  let image: AuthorizedImage | undefined;
  if (result.content.length === 2) {
    const imageContent = result.content[1];
    if (
      !isExactRecord(
        imageContent,
        ["type", "data", "mimeType"],
        ["type", "data", "mimeType"],
      ) ||
      imageContent.type !== "image" ||
      typeof imageContent.data !== "string" ||
      (imageContent.mimeType !== "image/jpeg" &&
        imageContent.mimeType !== "image/png") ||
      !isCanonicalBase64(imageContent.data)
    ) {
      throw new Error("Invalid handler result.");
    }
    image = {
      bytes: Buffer.from(imageContent.data, "base64"),
      mime_type: imageContent.mimeType,
    };
  }
  return toMcpSuccessResult(parsed.data as Success<unknown>, image);
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function isExactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}
