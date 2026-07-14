import assert from "node:assert/strict";
import test from "node:test";

import {
  LiveStepBindings,
  assertPrivateEnvironmentFile,
  assertHardwareCallExpectation,
  compareSafeBaselines,
  sanitizeToolEvidence,
} from "./hardware-release-driver.mjs";

function successResult(overrides = {}) {
  return {
    content: [{ type: "text", text: "not persisted" }],
    structuredContent: {
      ok: true,
      tool: "jetkvm_input_keyboard",
      operation_id: "secret-operation-id",
      session_id: "secret-session-id",
      session_generation: 9,
      duration_ms: 4,
      result: {
        request_id: "secret-request-id",
        outcome: "applied",
        verification: "device_ack_only",
        required_next_step: "none",
        dispatched_action_count: 2,
        completed_action_count: 2,
      },
      ...overrides,
    },
  };
}

test("sanitizes MCP results to hashes, bounded facts, and image digests", () => {
  const result = successResult();
  result.content.push({
    type: "image",
    mimeType: "image/png",
    data: Buffer.from("private-image").toString("base64"),
  });
  const evidence = sanitizeToolEvidence(result);
  const serialized = JSON.stringify(evidence);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.dispatched_action_count, 2);
  assert.equal(evidence.images[0].byte_length, 13);
  assert.match(evidence.images[0].sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(serialized, /secret|not persisted|private-image/u);
});

test("binds duplicate request IDs to their first session and observation", () => {
  const bindings = new LiveStepBindings("run-1");
  const firstState = {
    session: { id: "session-a", generation: 7 },
    observation: { id: "observation-a" },
  };
  const step = {
    id: "duplicate-initial",
    input: {
      request_id: "opaque-request",
      session_id: "opaque-session",
      session_generation: 1,
      observation_id: "opaque-observation",
      timeout_ms: 1000,
    },
  };
  const first = bindings.adapt(step, firstState);
  const second = bindings.adapt(
    {
      ...step,
      id: "duplicate-same",
      input: { ...step.input, timeout_ms: 1000 },
    },
    {
      session: { id: "session-b", generation: 8 },
      observation: { id: "observation-b" },
    },
  );
  assert.equal(second.request_id, first.request_id);
  assert.equal(second.session_id, "session-a");
  assert.equal(second.session_generation, 7);
  assert.equal(second.observation_id, "observation-a");
  assert.equal(first.timeout_ms, 30_000);
  const changed = bindings.adapt(
    {
      ...step,
      id: "duplicate-changed",
      input: { ...step.input, timeout_ms: 2000 },
    },
    firstState,
  );
  assert.equal(changed.timeout_ms, 30_001);
});

test("binds stale requests to the previous session and observation", () => {
  const bindings = new LiveStepBindings("run-stale");
  const stale = bindings.adapt(
    {
      id: "stale-keyboard-old-observation",
      input: {
        request_id: "stale-request",
        session_id: "placeholder",
        session_generation: 1,
        observation_id: "placeholder",
        timeout_ms: 1000,
      },
    },
    {
      session: { id: "session-current", generation: 9 },
      previousSession: { id: "session-previous", generation: 8 },
      observation: { id: "observation-current" },
      previousObservation: { id: "observation-previous" },
    },
  );
  assert.equal(stale.session_id, "session-previous");
  assert.equal(stale.session_generation, 8);
  assert.equal(stale.observation_id, "observation-previous");
});

test("accepts protocol schema rejection and named public errors only", () => {
  assert.doesNotThrow(() =>
    assertHardwareCallExpectation(
      {
        id: "reject-zero-scroll",
        expect: "The whole request is schema-rejected.",
      },
      undefined,
      Object.assign(new Error("Invalid params"), { code: -32602 }),
    ),
  );
  assert.doesNotThrow(() =>
    assertHardwareCallExpectation(
      {
        id: "inspect-old-generation",
        expect: "The old generation is taken_over.",
      },
      { ok: false, error: { code: "SESSION_TAKEN_OVER" } },
      undefined,
    ),
  );
  assert.throws(() =>
    assertHardwareCallExpectation(
      { id: "unexpected", expect: "success" },
      { ok: false, error: { code: "CONTROL_BUSY" } },
      undefined,
    ),
  );
  assert.throws(() =>
    assertHardwareCallExpectation(
      {
        id: "reject-zero-scroll",
        expect: "The whole request is schema-rejected.",
      },
      undefined,
      new Error("Timed out"),
    ),
  );
});

test("compares every safe baseline field and permits generation advance", () => {
  const baseline = {
    candidate_revision: "a".repeat(40),
    display: { width: 1920, height: 1080 },
    layout: { klid: "00000809" },
    lock_keys: { caps: false, num: true, scroll: false },
    atx: { extension: true, serial_ready: true },
    browser: { executable_sha256: "b".repeat(64) },
    fixture: { sha256: "c".repeat(64) },
    host_online: true,
    held_input: { keys: 0, buttons: 0 },
    session_generation: 7,
  };
  const restored = structuredClone(baseline);
  restored.session_generation = 8;
  assert.equal(compareSafeBaselines(baseline, restored).result, "pass");
  restored.lock_keys.caps = true;
  assert.throws(() => compareSafeBaselines(baseline, restored), /lock_keys/u);
});

test("rejects group-readable protected environment files", () => {
  assert.doesNotThrow(() =>
    assertPrivateEnvironmentFile({ mode: 0o100600 }, "safe"),
  );
  assert.throws(
    () => assertPrivateEnvironmentFile({ mode: 0o100640 }, "unsafe"),
    /owner-only/u,
  );
});
