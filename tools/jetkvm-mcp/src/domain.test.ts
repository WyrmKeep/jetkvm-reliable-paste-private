import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CAPABILITY_NAMES,
  JETKVM_TOOL_NAMES,
  PERMISSION_NAMES,
  type CapabilitySnapshot,
  type DisplayCaptureResult,
  type KeyboardAction,
  type MutationState,
  type PhysicalKey,
  type SessionConnectInput,
  type SessionConnectResult,
  type Success,
  type ToolError,
} from "./domain.js";

const exactToolNames = [
  "jetkvm_display_capture",
  "jetkvm_display_status",
  "jetkvm_input_keyboard",
  "jetkvm_input_mouse",
  "jetkvm_input_paste",
  "jetkvm_input_release",
  "jetkvm_power_control",
  "jetkvm_session_connect",
  "jetkvm_session_reconnect",
  "jetkvm_session_status",
] as const;

describe("canonical domain contracts", () => {
  it("exports the exact sorted ten-tool inventory", () => {
    expect(JETKVM_TOOL_NAMES).toEqual(exactToolNames);
    expect([...JETKVM_TOOL_NAMES]).toEqual([...JETKVM_TOOL_NAMES].sort());
    expect(JETKVM_TOOL_NAMES).toHaveLength(10);
    expect(JETKVM_TOOL_NAMES).not.toContain("computer_screenshot");
    expect(JETKVM_TOOL_NAMES).not.toContain("computer_actions");
    expect(JETKVM_TOOL_NAMES).not.toContain("computer_paste_text");
    expect(JETKVM_TOOL_NAMES).not.toContain("computer_status");
    expect(JETKVM_TOOL_NAMES).not.toContain("computer_release_input");
  });

  it("exports the exact permission and capability inventories", () => {
    expect(PERMISSION_NAMES).toEqual([
      "session.connect",
      "session.status",
      "session.reconnect",
      "session.takeover",
      "display.capture",
      "display.status",
      "input.mouse",
      "input.keyboard",
      "input.paste",
      "input.release",
      "power.control",
    ]);
    expect(CAPABILITY_NAMES).toEqual([
      "session_status",
      "display_capture",
      "display_status",
      "mouse",
      "absolute_pointer",
      "keyboard",
      "reliable_paste",
      "input_release",
      "power_control",
      "edid_read",
    ]);
  });

  it("keeps connect target-free and places issued session identity in the envelope", () => {
    const input: SessionConnectInput = {
      request_id: "request-1",
      timeout_ms: 1_000,
    };
    const capabilities: CapabilitySnapshot = Object.fromEntries(
      CAPABILITY_NAMES.map((name) => [name, true]),
    ) as unknown as CapabilitySnapshot;
    const result: SessionConnectResult = {
      request_id: input.request_id,
      outcome: "applied",
      verification: "device_ack_only",
      safe_to_retry: false,
      required_next_step: "none",
      state: "ready",
      connection_epoch: 1,
      display_generation: 2,
      takeover_performed: false,
      fresh_capture_required: true,
      permissions: ["session.connect"],
      capabilities,
    };
    const envelope: Success<SessionConnectResult> = {
      ok: true,
      tool: "jetkvm_session_connect",
      operation_id: "operation-1",
      session_id: "session-1",
      session_generation: 1,
      duration_ms: 5,
      result,
    };

    expect(Object.keys(input).sort()).toEqual(["request_id", "timeout_ms"]);
    expect(envelope.session_id).toBe("session-1");
    expect(envelope.result).not.toHaveProperty("session_id");
    expect(envelope.result).not.toHaveProperty("session_generation");
  });

  it("exposes only physical keyboard actions", () => {
    const key: PhysicalKey = "ControlLeft";
    const action: KeyboardAction = { type: "chord", keys: [key, "KeyC"] };
    expect(action).toEqual({ type: "chord", keys: ["ControlLeft", "KeyC"] });
    expectTypeOf<KeyboardAction>().not.toMatchTypeOf<{
      type: "type";
      text: string;
    }>();
    expectTypeOf<PhysicalKey>().not.toEqualTypeOf<string>();
  });

  it("keeps capture bytes outside the public capture result", () => {
    const capture: DisplayCaptureResult = {
      observation_id: "observation-1",
      connection_epoch: 1,
      display_generation: 2,
      frame_id: "frame-1",
      captured_at: "2026-07-13T00:00:00.000Z",
      source_width: 1920,
      source_height: 1080,
      image_width: 1280,
      image_height: 720,
      rotation: 0,
      geometry: {
        content_x: 0,
        content_y: 0,
        content_width: 1280,
        content_height: 720,
      },
      image: {
        content_index: 1,
        mime_type: "image/jpeg",
        sha256: "a".repeat(64),
        byte_length: 4,
      },
    };
    expect(capture.image).not.toHaveProperty("data");
    expect(capture.image).not.toHaveProperty("bytes");
    expect(capture.image).not.toHaveProperty("base64");
  });

  it("types exact common mutation, success, and error envelopes", () => {
    expectTypeOf<MutationState>().toHaveProperty("required_next_step");
    expectTypeOf<Success<unknown>>().toHaveProperty("session_generation");
    expectTypeOf<Success<unknown>["session_id"]>().toEqualTypeOf<string>();
    expectTypeOf<
      Success<unknown>["session_generation"]
    >().toEqualTypeOf<number>();
    expectTypeOf<ToolError["session_id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ToolError["session_generation"]>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<ToolError>().toHaveProperty("error");
    expectTypeOf<ToolError["error"]["details"]>().toHaveProperty(
      "downstream_stage",
    );
  });
});
