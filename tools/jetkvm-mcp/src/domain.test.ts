import { readFile } from "node:fs/promises";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CAPABILITY_NAMES,
  JETKVM_TOOL_NAMES,
  PERMISSION_NAMES,
  type CapabilitySnapshot,
  type AtxLedObservation,
  type DisplayCaptureResult,
  type DefinitiveMutationState,
  type KeyboardAction,
  type MutationState,
  type InputPasteResult,
  type InputReleaseResult,
  type PhysicalKey,
  type ObservedFact,
  type SessionConnectInput,
  type SessionConnectResult,
  type PowerControlResult,
  type Success,
  type ToolError,
} from "./domain.js";
import { TOOL_RESULT_PAYLOAD_SCHEMAS } from "./mcp/schemas.js";

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

  it("limits public observed facts to canonical event or none provenance", () => {
    type NullableNumberFact = ObservedFact<number | null, null>;
    expectTypeOf<NullableNumberFact["source"]>().toEqualTypeOf<
      "cached_event" | "none"
    >();
    expectTypeOf<
      Extract<NullableNumberFact, { source: "none" }>["value"]
    >().toEqualTypeOf<null>();
    expectTypeOf<
      Extract<NullableNumberFact, { source: "cached_event" }>["observed_at"]
    >().toEqualTypeOf<string>();

    const eventFact = {
      value: "present",
      observed_at: "2026-07-13T00:00:00.000Z",
      age_ms: 0,
      freshness: "fresh",
      source: "cached_event",
    } as const;
    const noneFact = {
      value: null,
      observed_at: null,
      age_ms: null,
      freshness: "unknown",
      source: "none",
    } as const;
    const displayStatus = {
      signal: eventFact,
      native_resolution: noneFact,
      fps: noneFact,
      edid: {
        status: "unsupported",
        read_completed: false,
        reason: "edid_read_capability_absent",
        observed_at: null,
        data: null,
      },
    } as const;

    expect(
      TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_display_status.safeParse(displayStatus)
        .success,
    ).toBe(true);
    expect(
      TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_display_status.safeParse({
        ...displayStatus,
        signal: { ...eventFact, source: "cached_snapshot" },
      }).success,
    ).toBe(false);
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
    expect(capture.image.content_index).toBe(1);
    expectTypeOf<
      DisplayCaptureResult["image"]["content_index"]
    >().toEqualTypeOf<1>();
    expect(capture.image).not.toHaveProperty("data");
    expect(capture.image).not.toHaveProperty("bytes");
    expect(capture.image).not.toHaveProperty("base64");
    expect(
      TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_display_capture.safeParse(capture)
        .success,
    ).toBe(true);
    expect(
      TOOL_RESULT_PAYLOAD_SCHEMAS.jetkvm_display_capture.safeParse({
        ...capture,
        image: { ...capture.image, content_index: 2 },
      }).success,
    ).toBe(false);
  });

  it("keeps every generated display-capture content index schema at exact const 1", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL(
          "../schemas/jetkvm_display_capture.result.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;
    const contentIndexSchemas: unknown[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (Object.hasOwn(record, "content_index")) {
        contentIndexSchemas.push(record.content_index);
      }
      Object.values(record).forEach(visit);
    };

    visit(schema);
    expect(contentIndexSchemas.length).toBeGreaterThan(0);
    expect(contentIndexSchemas).toEqual(
      contentIndexSchemas.map(() => ({ type: "number", const: 1 })),
    );
  });

  it("narrows successful paste to the correlated succeeded lifecycle", () => {
    const result: InputPasteResult = {
      request_id: "request-1",
      outcome: "applied",
      verification: "device_ack_only",
      safe_to_retry: false,
      required_next_step: "none",
      original_byte_count: 5,
      normalized_byte_count: 5,
      normalized_sha256: "b".repeat(64),
      accepted_at: "2026-07-13T00:00:00.000Z",
      completed_at: "2026-07-13T00:00:01.000Z",
      terminal_state: "succeeded",
      measured_chars_per_second: 91,
      post_capture: null,
    };
    expect(result).toMatchObject({
      accepted_at: expect.any(String),
      completed_at: expect.any(String),
      terminal_state: "succeeded",
    });
    expectTypeOf<InputPasteResult["accepted_at"]>().toEqualTypeOf<string>();
    expectTypeOf<InputPasteResult["completed_at"]>().toEqualTypeOf<string>();
    expectTypeOf<
      InputPasteResult["terminal_state"]
    >().toEqualTypeOf<"succeeded">();
  });

  it("models emergency release success as fully verified literals", () => {
    const result: InputReleaseResult = {
      request_id: "request-release",
      outcome: "applied",
      verification: "device_state_verified",
      safe_to_retry: false,
      required_next_step: "none",
      mutation_gate_closed: true,
      deferred_producers_joined: true,
      paste_terminal: "cancelled",
      ordinary_leases_zero: true,
      keyboard_zero: true,
      pointer_zero: true,
      generation_drained: true,
    };
    expect(result).toEqual({
      request_id: "request-release",
      outcome: "applied",
      verification: "device_state_verified",
      safe_to_retry: false,
      required_next_step: "none",
      mutation_gate_closed: true,
      deferred_producers_joined: true,
      paste_terminal: "cancelled",
      ordinary_leases_zero: true,
      keyboard_zero: true,
      pointer_zero: true,
      generation_drained: true,
    });
    expectTypeOf<InputReleaseResult["outcome"]>().toEqualTypeOf<
      "applied" | "already_applied"
    >();
    expectTypeOf<
      InputReleaseResult["verification"]
    >().toEqualTypeOf<"device_state_verified">();
    expectTypeOf<
      InputReleaseResult["mutation_gate_closed"]
    >().toEqualTypeOf<true>();
    expectTypeOf<InputReleaseResult["paste_terminal"]>().toEqualTypeOf<
      "cancelled" | "inactive"
    >();
    expectTypeOf<false>().not.toMatchTypeOf<
      InputReleaseResult["mutation_gate_closed"]
    >();
    expectTypeOf<"unknown">().not.toMatchTypeOf<
      InputReleaseResult["paste_terminal"]
    >();
    expectTypeOf<"not_sent">().not.toMatchTypeOf<
      InputReleaseResult["outcome"]
    >();
  });

  it("keeps sibling mutation successes definitive and power mappings correlated", () => {
    expectTypeOf<DefinitiveMutationState["outcome"]>().toEqualTypeOf<
      "applied" | "already_applied"
    >();
    expectTypeOf<InputPasteResult["outcome"]>().toEqualTypeOf<
      DefinitiveMutationState["outcome"]
    >();
    expectTypeOf<
      PowerControlResult["verification"]
    >().toEqualTypeOf<"device_ack_only">();
    expectTypeOf<
      Extract<PowerControlResult, { action: "hold_power" }>["wire_action"]
    >().toEqualTypeOf<"power-long">();
    expectTypeOf<
      Extract<PowerControlResult, { action: "press_reset" }>["fixed_press_ms"]
    >().toEqualTypeOf<200>();
    expectTypeOf<
      PowerControlResult["serial_sequence_completed"]
    >().toEqualTypeOf<true>();
  });

  it("discriminates observed and unknown ATX LED facts", () => {
    const observed: AtxLedObservation = {
      power: true,
      hdd: null,
      observed_at: "2026-07-13T00:00:00.000Z",
      freshness: "fresh",
    };
    const unknown: AtxLedObservation = {
      power: null,
      hdd: null,
      observed_at: null,
      freshness: "unknown",
    };
    const result: PowerControlResult = {
      request_id: "request-2",
      outcome: "applied",
      verification: "device_ack_only",
      safe_to_retry: false,
      required_next_step: "none",
      action: "press_power",
      wire_action: "power-short",
      fixed_press_ms: 200,
      serial_sequence_completed: true,
      atx_led_observation: unknown,
    };
    expect(observed).toMatchObject({
      observed_at: expect.any(String),
      freshness: "fresh",
    });
    expect(result.atx_led_observation).toEqual({
      power: null,
      hdd: null,
      observed_at: null,
      freshness: "unknown",
    });
    expectTypeOf<
      Extract<AtxLedObservation, { freshness: "unknown" }>["observed_at"]
    >().toEqualTypeOf<null>();
    expectTypeOf<
      Extract<
        AtxLedObservation,
        { freshness: "fresh" | "stale" }
      >["observed_at"]
    >().toEqualTypeOf<string>();
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
