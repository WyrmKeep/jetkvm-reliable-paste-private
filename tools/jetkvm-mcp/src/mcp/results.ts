import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

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
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: true,
  };
}
