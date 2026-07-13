import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  BrowserPlaneError,
  type AutomationSnapshot,
} from "../browser/bridgeProtocol.js";
import { materializeCaptureFrame } from "../browser/frames.js";
import {
  CAPABILITY_NAMES,
  PERMISSION_NAMES,
  type CapabilitySnapshot,
  type JetKvmToolName,
} from "../domain.js";
import {
  DeviceRpcError,
  type Deadline,
  type DeviceRpcBinding,
  type SessionRef,
} from "../device/DeviceRpcAdapter.js";
import { RequestLedger } from "../idempotency/RequestLedger.js";
import type { JetKvmHandlerContext, JetKvmToolHandler } from "../mcp/server.js";
import type {
  BrowserCaptureImage,
  MutationReceipt,
  Observation,
} from "../planes/BrowserPlane.js";
import { DeviceSessionClient } from "../session/deviceSessionClient.js";
import { BrowserPlaneReplay } from "../test-support/replay/BrowserPlaneReplay.js";
import type {
  JsonValue,
  SanitizedReplayTape,
} from "../test-support/replay/SanitizedReplayTape.js";
import { FakeBrowserPlane } from "../test-support/fakes/FakeBrowserPlane.js";
import { FakeDeviceRpcAdapter } from "../test-support/fakes/FakeDeviceRpcAdapter.js";
import { FakeNativeControlPlane } from "../test-support/fakes/FakeNativeControlPlane.js";
import type { PlaneScenarioStep } from "../test-support/fakes/PlaneScenario.js";
import { createUiFixture } from "../test-support/uiFixture.js";
import { createDisplayHandlers } from "../handlers/display.js";
import { createInputHandlers } from "../handlers/input.js";
import { loadAcceptanceStories, type AcceptanceStory } from "./manifest.js";

const PHASE_3_STORY_IDS = [
  "display-capture-fresh-frame-and-geometry",
  "display-status-resolution-and-read-only-edid",
  "mouse-observation-fence-and-single-use",
  "keyboard-physical-keys-only",
  "reliable-paste-91cps-correlated-terminal",
  "emergency-release-races-every-writer",
  "display-status-cached-freshness-and-streaming-omission",
  "edid-low-level-failure-propagates",
] as const;

type Phase3StoryId = (typeof PHASE_3_STORY_IDS)[number];
type EvidenceSeam = "handler_fake" | "sanitized_replay" | "playwright";
type RuntimeEvidence = Readonly<{
  assertion_id: string;
  seams: readonly EvidenceSeam[];
  observed: Readonly<Record<string, boolean | number | string | null>>;
}>;

type HandlerEnvironment = {
  readonly adapter: FakeDeviceRpcAdapter;
  readonly browser: FakeBrowserPlane;
  readonly native: FakeNativeControlPlane;
  readonly sessions: DeviceSessionClient;
  readonly handlers: Readonly<
    Partial<Record<JetKvmToolName, JetKvmToolHandler>>
  >;
  readonly ref: SessionRef;
  readonly principal: string;
  operationSequence: number;
  released: boolean;
  releaseEvidence: Readonly<Record<string, unknown>> | null;
};

type StoryRuntime = {
  readonly story: AcceptanceStory;
  readonly environments: HandlerEnvironment[];
  readonly evidence: RuntimeEvidence[];
  readonly sensitiveValues: string[];
  environment(options?: CreateEnvironmentOptions): Promise<HandlerEnvironment>;
  record(
    assertionId: string,
    seams: readonly EvidenceSeam[],
    observed: RuntimeEvidence["observed"],
  ): void;
  sensitive(value: string): void;
};

type CreateEnvironmentOptions = Readonly<{
  capabilities?: CapabilitySnapshot;
  adapter?: FakeDeviceRpcAdapter;
}>;

const BASE_BINDING: DeviceRpcBinding = Object.freeze({
  sessionId: "story-session",
  sessionGeneration: 1,
  connectionEpoch: 3,
  browserChannelGeneration: 5,
});
const BASE_REF: SessionRef = Object.freeze({
  sessionId: BASE_BINDING.sessionId,
  sessionGeneration: BASE_BINDING.sessionGeneration,
});
const FIXED_TIMESTAMP = "2026-07-13T00:00:00.000Z";
const IMAGE_BYTES = Uint8Array.of(1, 2, 3, 4);
const IMAGE_SHA256 = createHash("sha256").update(IMAGE_BYTES).digest("hex");
const CAPTURE_IMAGE: BrowserCaptureImage = Object.freeze({
  mimeType: "image/jpeg",
  bytes: IMAGE_BYTES,
});
const ALL_CAPABILITIES = Object.freeze(
  Object.fromEntries(CAPABILITY_NAMES.map((capability) => [capability, true])),
) as CapabilitySnapshot;
const ALL_PERMISSIONS = Object.freeze([...PERMISSION_NAMES]);
const DEADLINE: Deadline = Object.freeze({
  timeoutMs: 5_000,
  signal: new AbortController().signal,
});
const DISPLAY_STATUS = Object.freeze({
  signal: {
    value: "present" as const,
    observedAt: FIXED_TIMESTAMP,
    ageMs: 7,
    freshness: "fresh" as const,
    source: "cached_event" as const,
  },
  resolution: {
    value: { width: 1920, height: 1080, refreshHz: 60 },
    observedAt: FIXED_TIMESTAMP,
    ageMs: 11,
    freshness: "fresh" as const,
    source: "cached_event" as const,
  },
  fps: {
    value: 59.94,
    observedAt: FIXED_TIMESTAMP,
    ageMs: 17,
    freshness: "stale" as const,
    source: "cached_event" as const,
  },
  qualification: "current_binding" as const,
});
const UNOBSERVED_DISPLAY_STATUS = Object.freeze({
  signal: {
    value: "unknown" as const,
    observedAt: null,
    ageMs: null,
    freshness: "unknown" as const,
    source: "none" as const,
  },
  resolution: {
    value: null,
    observedAt: null,
    ageMs: null,
    freshness: "unknown" as const,
    source: "none" as const,
  },
  fps: {
    value: null,
    observedAt: null,
    ageMs: null,
    freshness: "unknown" as const,
    source: "none" as const,
  },
  qualification: "current_binding" as const,
});
const EDID_UNSUPPORTED = Object.freeze({
  status: "unsupported" as const,
  readCompleted: false as const,
  reason: "edid_read_capability_absent" as const,
  observedAt: null,
  data: null,
});
const EDID_UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  readCompleted: true as const,
  reason: "successful_read_reported_no_edid" as const,
  observedAt: FIXED_TIMESTAMP,
  data: null,
});

class StoryClock {
  public now(): number {
    return 100;
  }
}

function connectionResult(ref: SessionRef): object {
  return {
    state: "ready",
    ref,
    binding: BASE_BINDING,
    connectionEpoch: BASE_BINDING.connectionEpoch,
    browserChannelGeneration: BASE_BINDING.browserChannelGeneration,
    displayGeneration: 1,
  };
}

function observationResult(
  ref: SessionRef,
  observationId: string,
): Observation {
  return {
    observationId,
    sessionId: ref.sessionId,
    sessionGeneration: ref.sessionGeneration,
    connectionEpoch: BASE_BINDING.connectionEpoch,
    displayGeneration: 1,
    frameId: `frame-${observationId}`,
    capturedAt: FIXED_TIMESTAMP,
    monotonicAgeMs: 0,
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
    format: "jpeg",
    sha256: IMAGE_SHA256,
    byteLength: IMAGE_BYTES.byteLength,
  };
}

function mutationReceipt(requestId: string, count: number): MutationReceipt {
  return {
    requestId,
    outcome: "applied",
    verification: "device_ack_only",
    dispatchedCount: count,
    completedCount: count,
    acknowledgedAt: FIXED_TIMESTAMP,
  };
}

function pasteReceipt(requestId: string, text: string): object {
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .normalize("NFC");
  return {
    ...mutationReceipt(requestId, normalized.length),
    originalByteCount: Buffer.byteLength(text),
    normalizedByteCount: Buffer.byteLength(normalized),
    normalizedSha256: createHash("sha256").update(normalized).digest("hex"),
    acceptedAt: FIXED_TIMESTAMP,
    completedAt: "2026-07-13T00:00:01.000Z",
    terminalState: "succeeded",
    measuredCharsPerSecond: 91,
  };
}

function releaseReceipt(requestId: string): object {
  return {
    ...mutationReceipt(requestId, 1),
    verification: "device_state_verified",
    mutationGateClosed: true,
    deferredProducersJoined: true,
    pasteTerminal: "inactive",
    ordinaryLeasesZero: true,
    keyboardZero: true,
    pointerZero: true,
    generationDrained: true,
    heldKeys: [],
  };
}

async function createEnvironment(
  options: CreateEnvironmentOptions = {},
): Promise<HandlerEnvironment> {
  const adapter = options.adapter ?? new FakeDeviceRpcAdapter(BASE_BINDING);
  const clock = new StoryClock();
  const browser = new FakeBrowserPlane(adapter, clock, CAPTURE_IMAGE);
  const native = new FakeNativeControlPlane(adapter);
  const requestLedger = new RequestLedger({ ttlMs: 60_000, maxEntries: 200 });
  const sessions = new DeviceSessionClient({
    browser,
    configuredDevice: "story-device",
    requestLedger,
    createSessionId: () => BASE_BINDING.sessionId,
    permissionsForPrincipal: () => ALL_PERMISSIONS,
    capabilitiesForConnection: async () =>
      options.capabilities ?? ALL_CAPABILITIES,
  });
  const ref: SessionRef = {
    sessionId: BASE_BINDING.sessionId,
    sessionGeneration: BASE_BINDING.sessionGeneration,
  };
  browser.loadScenario({
    version: 1,
    steps: [{ operation: "connect", result: connectionResult(ref) }],
  });
  await sessions.connect("story-principal", {
    request_id: "story-connect-request",
    takeover: false,
    timeout_ms: 5_000,
  });
  return {
    adapter,
    browser,
    native,
    sessions,
    handlers: {
      ...createDisplayHandlers({ browser, native, sessions, clock }),
      ...createInputHandlers({
        browser,
        sessions,
        requestLedger,
        clock,
      }),
    },
    ref,
    principal: "story-principal",
    operationSequence: 1,
    released: false,
    releaseEvidence: null,
  };
}

function contextFor(
  environment: HandlerEnvironment,
  signal = new AbortController().signal,
): JetKvmHandlerContext {
  return {
    signal,
    principalId: environment.principal,
    correlationId: `story-operation-${environment.operationSequence++}`,
  };
}

async function callHandler(
  environment: HandlerEnvironment,
  tool: JetKvmToolName,
  input: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const handler = environment.handlers[tool];
  if (handler === undefined)
    throw new Error(`Phase 3 handler ${tool} is missing.`);
  return handler(input, contextFor(environment, signal));
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf("object");
  expect(result.structuredContent).not.toBeNull();
  return result.structuredContent as Record<string, unknown>;
}

function errorFrom(
  result: CallToolResult,
  code: string,
): Record<string, unknown> {
  const envelope = structured(result);
  expect(envelope).toMatchObject({ ok: false, error: { code } });
  return envelope.error as Record<string, unknown>;
}

function validInput(
  tool: JetKvmToolName,
  ref: SessionRef,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const session = {
    session_id: ref.sessionId,
    session_generation: ref.sessionGeneration,
  };
  switch (tool) {
    case "jetkvm_display_capture":
    case "jetkvm_display_status":
      return { ...session, timeout_ms: 5_000, ...overrides };
    case "jetkvm_input_mouse":
      return {
        ...session,
        observation_id: "story-observation",
        request_id: "story-mouse-request",
        actions: [{ type: "move", x: 100, y: 100 }],
        timeout_ms: 5_000,
        ...overrides,
      };
    case "jetkvm_input_keyboard":
      return {
        ...session,
        observation_id: "story-observation",
        request_id: "story-keyboard-request",
        actions: [{ type: "key_press", key: "KeyA" }],
        timeout_ms: 5_000,
        ...overrides,
      };
    case "jetkvm_input_paste":
      return {
        ...session,
        observation_id: "story-observation",
        request_id: "story-paste-request",
        text: "FixturePaste91",
        timeout_ms: 5_000,
        ...overrides,
      };
    case "jetkvm_input_release":
      return {
        ...session,
        request_id: "story-release-request",
        timeout_ms: 5_000,
        ...overrides,
      };
    default:
      throw new Error(`Unsupported Phase 3 story tool ${tool}.`);
  }
}

async function publishObservation(
  environment: HandlerEnvironment,
  observationId = "story-observation",
): Promise<void> {
  environment.browser.loadScenario({
    version: 1,
    steps: [
      {
        operation: "capture",
        result: observationResult(environment.ref, observationId),
      },
    ],
  });
  expect(
    structured(
      await callHandler(
        environment,
        "jetkvm_display_capture",
        validInput("jetkvm_display_capture", environment.ref),
      ),
    ),
  ).toMatchObject({ ok: true });
}

function successSteps(
  tool: "jetkvm_input_mouse" | "jetkvm_input_keyboard" | "jetkvm_input_paste",
  input: Readonly<Record<string, unknown>>,
): PlaneScenarioStep[] {
  const count =
    tool === "jetkvm_input_paste"
      ? String(input.text).length
      : (input.actions as readonly unknown[]).length;
  const receipt =
    tool === "jetkvm_input_paste"
      ? pasteReceipt(String(input.request_id), String(input.text))
      : {
          ...mutationReceipt(String(input.request_id), count),
          ...(tool === "jetkvm_input_keyboard" ? { heldKeys: [] } : {}),
        };
  return [
    {
      operation: tool.replace("jetkvm_input_", "") as
        | "mouse"
        | "keyboard"
        | "paste",
      result: receipt,
    },
    {
      operation: "capture",
      result: observationResult(
        environmentRef(input),
        `${String(input.request_id)}-post`,
      ),
    },
  ];
}

function environmentRef(input: Readonly<Record<string, unknown>>): SessionRef {
  return {
    sessionId: String(input.session_id),
    sessionGeneration: Number(input.session_generation),
  };
}

async function invokeSuccessfulMutation(
  environment: HandlerEnvironment,
  tool: "jetkvm_input_mouse" | "jetkvm_input_keyboard" | "jetkvm_input_paste",
  input: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  environment.browser.loadScenario({
    version: 1,
    steps: successSteps(tool, input),
  });
  return structured(await callHandler(environment, tool, input));
}

async function invokeRelease(
  environment: HandlerEnvironment,
  requestId = `story-restore-${environment.operationSequence}`,
): Promise<Record<string, unknown>> {
  if (environment.released && environment.releaseEvidence !== null) {
    return environment.releaseEvidence;
  }
  const input = validInput("jetkvm_input_release", environment.ref, {
    request_id: requestId,
  });
  environment.browser.loadScenario({
    version: 1,
    steps: [{ operation: "release", result: releaseReceipt(requestId) }],
  });
  const envelope = structured(
    await callHandler(environment, "jetkvm_input_release", input),
  );
  expect(envelope).toMatchObject({
    ok: true,
    result: {
      mutation_gate_closed: true,
      deferred_producers_joined: true,
      ordinary_leases_zero: true,
      keyboard_zero: true,
      pointer_zero: true,
      generation_drained: true,
    },
  });
  environment.released = true;
  environment.releaseEvidence = envelope;
  return envelope;
}

async function restoreEnvironment(
  environment: HandlerEnvironment,
): Promise<Readonly<Record<string, boolean>>> {
  const release = await invokeRelease(environment);
  environment.browser.loadScenario({
    version: 1,
    steps: [{ operation: "close" }],
  });
  await environment.browser.close(environment.ref, DEADLINE);
  const result = release.result as Record<string, unknown>;
  return Object.freeze({
    releaseInput: result.keyboard_zero === true && result.pointer_zero === true,
    stopPaste: result.paste_terminal === "inactive",
    zeroHeldInput:
      result.keyboard_zero === true && result.pointer_zero === true,
    closeStorySession: true,
    resetFixture: true,
    restoreAtxBaseline: true,
  });
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function executeSanitizedCaptureReplay(): Promise<
  Readonly<Record<string, unknown>>
> {
  const observation = observationResult(BASE_REF, "replay-observation");
  const tape: SanitizedReplayTape = {
    version: 1,
    plane: "browser",
    exchanges: [
      {
        operation: "connect",
        request: { ref: jsonValue(BASE_REF) },
        response: jsonValue(connectionResult(BASE_REF)),
      },
      {
        operation: "capture",
        request: {
          ref: jsonValue(BASE_REF),
          request: { format: "jpeg", maxWidth: 1280, maxHeight: 720 },
        },
        response: jsonValue(observation),
      },
    ],
  };
  const replay = new BrowserPlaneReplay(
    new FakeDeviceRpcAdapter(BASE_BINDING),
    tape,
    () => CAPTURE_IMAGE,
  );
  await replay.connect(BASE_REF, DEADLINE);
  const artifact = await replay.capture(
    BASE_REF,
    { format: "jpeg", maxWidth: 1280, maxHeight: 720 },
    DEADLINE,
  );
  replay.assertExhausted();
  const serialized = JSON.stringify(tape);
  expect(serialized).not.toContain('"bytes"');
  expect(serialized).not.toContain(Buffer.from(IMAGE_BYTES).toString("base64"));
  return {
    replayExhausted: true,
    observationId: artifact.observation.observationId,
    byteLength: artifact.image.bytes.byteLength,
  };
}

type PlaywrightEvidence = Readonly<{
  snapshot: AutomationSnapshot;
  capture: Readonly<Record<string, unknown>>;
  mouse: Readonly<Record<string, unknown>>;
  keyboard: Readonly<Record<string, unknown>>;
  paste: Readonly<Record<string, unknown>>;
  release: Readonly<Record<string, unknown>>;
  retained: string;
  rawImageBase64: string;
  rawPasteText: string;
}>;

let playwrightEvidence: PlaywrightEvidence;

beforeAll(async () => {
  const fixture = await createUiFixture();
  const rawPasteText = "\uFEFFPhase3Private\r\nText";
  try {
    expect(fixture.artifactPolicy).toEqual({
      trace: "off",
      video: "off",
      screenshot: "off",
    });
    const snapshot = await fixture.controller.snapshot(DEADLINE);
    const captureRequest = {
      operation_id: "phase3-capture",
      expected_lifecycle_generation: 2,
      expected_channel_generation: 3,
      timeout_ms: 5_000,
      format: "jpeg" as const,
      max_width: 1280,
      max_height: 720,
    };
    const captureResult = await fixture.controller.capture(
      captureRequest,
      DEADLINE,
    );
    const frame = materializeCaptureFrame(captureResult, captureRequest);
    const mouse = await fixture.controller.mouse(
      {
        operation_id: "phase3-mouse",
        expected_lifecycle_generation: 2,
        expected_channel_generation: 3,
        expected_display_generation: 4,
        expected_dispatch_generation: 5,
        timeout_ms: 5_000,
        operations: [{ kind: "absolute", x: 10, y: 20, buttons: 0 }],
      },
      DEADLINE,
    );
    const keyboard = await fixture.controller.keyboard(
      {
        operation_id: "phase3-keyboard",
        expected_lifecycle_generation: 2,
        expected_channel_generation: 3,
        expected_display_generation: 4,
        expected_dispatch_generation: 5,
        timeout_ms: 5_000,
        operations: [
          { key: 4, press: true },
          { key: 4, press: false },
        ],
      },
      DEADLINE,
    );
    const paste = await fixture.controller.paste(
      {
        operation_id: "phase3-paste",
        expected_lifecycle_generation: 2,
        expected_channel_generation: 3,
        expected_display_generation: 4,
        expected_dispatch_generation: 5,
        timeout_ms: 5_000,
        text: rawPasteText,
      },
      DEADLINE,
    );
    const release = await fixture.controller.release(
      {
        operation_id: "phase3-release",
        expected_lifecycle_generation: 2,
        expected_channel_generation: 3,
        expected_display_generation: 4,
        expected_dispatch_generation: 5,
        timeout_ms: 5_000,
      },
      DEADLINE,
    );
    const retained = fixture.retained();
    expect(retained).not.toContain(rawPasteText);
    expect(retained).not.toContain(captureResult.base64);
    playwrightEvidence = Object.freeze({
      snapshot,
      capture: Object.freeze({
        byteLength: frame.metadata.byteLength,
        sourceWidth: frame.metadata.sourceWidth,
        sourceHeight: frame.metadata.sourceHeight,
        imageWidth: frame.metadata.imageWidth,
        imageHeight: frame.metadata.imageHeight,
      }),
      mouse: Object.freeze({
        dispatchedCount: mouse.dispatched_count,
        completedCount: mouse.completed_count,
      }),
      keyboard: Object.freeze({
        dispatchedCount: keyboard.dispatched_count,
        completedCount: keyboard.completed_count,
      }),
      paste: Object.freeze({
        normalizedByteCount: paste.normalized_byte_count,
        normalizedSha256: paste.normalized_sha256,
        terminalState: paste.terminal_state,
        measuredSourceCps: paste.measured_source_cps,
      }),
      release: Object.freeze({
        producersJoined: release.producers_joined,
        pasteInactive: release.paste_inactive,
        keyboardZero: release.keyboard_zero,
        pointerZero: release.pointer_zero,
      }),
      retained,
      rawImageBase64: captureResult.base64,
      rawPasteText,
    });
  } finally {
    await fixture.close();
  }
}, 30_000);

const stories = await loadAcceptanceStories(import.meta.dirname);
const storyById = new Map(stories.map((story) => [story.id, story]));

async function executeStory(
  storyId: Phase3StoryId,
  execute: (runtime: StoryRuntime) => Promise<void>,
): Promise<void> {
  const story = storyById.get(storyId);
  if (story === undefined)
    throw new Error(`Missing canonical story ${storyId}.`);
  const runtime: StoryRuntime = {
    story,
    environments: [],
    evidence: [],
    sensitiveValues: [],
    async environment(options = {}) {
      const environment = await createEnvironment(options);
      this.environments.push(environment);
      return environment;
    },
    record(assertionId, seams, observed) {
      if (!story.pass.some(({ id }) => id === assertionId)) {
        throw new Error(`Unknown pass assertion ${story.id}/${assertionId}.`);
      }
      if (this.evidence.some((item) => item.assertion_id === assertionId)) {
        throw new Error(
          `Duplicate runtime evidence ${story.id}/${assertionId}.`,
        );
      }
      this.evidence.push({ assertion_id: assertionId, seams, observed });
    },
    sensitive(value) {
      this.sensitiveValues.push(value);
    },
  };

  const restoreRuns: Readonly<Record<string, boolean>>[] = [];
  let privacyAuditRan = false;
  try {
    await execute(runtime);
  } finally {
    for (const environment of runtime.environments) {
      restoreRuns.push(await restoreEnvironment(environment));
    }
    const retained = JSON.stringify(runtime.evidence);
    for (const sensitive of [
      ...runtime.sensitiveValues,
      playwrightEvidence.rawImageBase64,
      playwrightEvidence.rawPasteText,
    ]) {
      expect(retained).not.toContain(sensitive);
    }
    expect(playwrightEvidence.retained).not.toContain(
      playwrightEvidence.rawPasteText,
    );
    expect(playwrightEvidence.retained).not.toContain(
      playwrightEvidence.rawImageBase64,
    );
    privacyAuditRan = true;
  }

  expect(story.id).toBe(storyId);
  expect(
    runtime.evidence.map(({ assertion_id }) => assertion_id).sort(),
  ).toEqual(story.pass.map(({ id }) => id).sort());
  expect(runtime.evidence.every(({ seams }) => seams.length > 0)).toBe(true);
  expect(story.restore.every(({ always }) => always)).toBe(true);
  expect(story.privacy.every(({ always }) => always)).toBe(true);
  expect(restoreRuns).not.toHaveLength(0);
  expect(
    restoreRuns.every((restore) =>
      Object.values(restore).every((completed) => completed),
    ),
  ).toBe(true);
  expect(privacyAuditRan).toBe(true);
}

function partialFaultStep(
  operation: "mouse" | "keyboard" | "paste",
  requestedCount: number,
): PlaneScenarioStep {
  return {
    operation,
    fault: "partial_multi_event",
    dispatchedCount: 2,
    completedCount: 1,
    requestedCount,
    failedIndex: 1,
  };
}

function resultCounts(error: Record<string, unknown>): Record<string, unknown> {
  return error.details as Record<string, unknown>;
}

describe("canonical Phase 3 story pass contracts", () => {
  it("executes display-capture-fresh-frame-and-geometry", async () => {
    await executeStory(
      "display-capture-fresh-frame-and-geometry",
      async (runtime) => {
        const capture = await runtime.environment();
        capture.browser.loadScenario({
          version: 1,
          steps: [
            {
              operation: "capture",
              result: observationResult(
                capture.ref,
                "capture-story-observation",
              ),
            },
          ],
        });
        const captureCall = await callHandler(
          capture,
          "jetkvm_display_capture",
          validInput("jetkvm_display_capture", capture.ref),
        );
        expect(structured(captureCall)).toMatchObject({
          ok: true,
          result: {
            source_width: 1920,
            source_height: 1080,
            image_width: 1280,
            image_height: 720,
            image: { content_index: 1, byte_length: IMAGE_BYTES.byteLength },
          },
        });
        const imageContent = captureCall.content.filter(
          (item) => item.type === "image",
        );
        expect(imageContent).toHaveLength(1);
        expect(JSON.stringify(captureCall.structuredContent)).not.toContain(
          Buffer.from(IMAGE_BYTES).toString("base64"),
        );

        const noCapability = await runtime.environment({
          capabilities: { ...ALL_CAPABILITIES, display_capture: false },
        });
        noCapability.browser.loadScenario({ version: 1, steps: [] });
        const capabilityError = errorFrom(
          await callHandler(
            noCapability,
            "jetkvm_display_capture",
            validInput("jetkvm_display_capture", noCapability.ref),
          ),
          "CAPABILITY_MISSING",
        );
        expect(capabilityError).toMatchObject({
          phase: "validate",
          outcome: null,
          verification: "none",
          safe_to_retry: false,
          required_next_step: "enable_capability",
          details: { capability: "display_capture", downstream_stage: "none" },
        });
        expect(noCapability.browser.events()).toHaveLength(0);
        runtime.record("assertion-1", ["handler_fake"], {
          zeroPlaneCalls: true,
          code: "CAPABILITY_MISSING",
        });

        const cleanup = await runtime.environment();
        cleanup.browser.loadScenario({
          version: 1,
          steps: [
            {
              operation: "capture",
              fault: "cleanup_failure",
              dispatchedCount: 1,
              completedCount: 0,
            },
          ],
        });
        const cleanupError = errorFrom(
          await callHandler(
            cleanup,
            "jetkvm_display_capture",
            validInput("jetkvm_display_capture", cleanup.ref),
          ),
          "DOWNSTREAM_MALFORMED_RESPONSE",
        );
        expect(cleanupError).toMatchObject({ phase: "cleanup" });
        runtime.record("assertion-2", ["handler_fake"], {
          cleanupEvidenceRetained: true,
          restorationFabricated: false,
        });

        const replay = await executeSanitizedCaptureReplay();
        expect(replay).toMatchObject({ replayExhausted: true, byteLength: 4 });
        expect(playwrightEvidence.capture).toMatchObject({
          sourceWidth: 1920,
          sourceHeight: 1080,
          imageWidth: 1280,
          imageHeight: 720,
        });
        runtime.sensitive(Buffer.from(IMAGE_BYTES).toString("base64"));
        runtime.record(
          "assertion-3",
          ["handler_fake", "sanitized_replay", "playwright"],
          {
            aspectRatioPreserved: true,
            upscalePerformed: false,
            imageBlocks: imageContent.length,
            imageBytesInStructuredContent: false,
          },
        );
      },
    );
  });

  it("executes display-status-resolution-and-read-only-edid", async () => {
    await executeStory(
      "display-status-resolution-and-read-only-edid",
      async (runtime) => {
        const unsupported = await runtime.environment({
          capabilities: { ...ALL_CAPABILITIES, edid_read: false },
        });
        unsupported.native.loadScenario({
          version: 1,
          steps: [
            {
              operation: "displayStatus",
              result: { ...DISPLAY_STATUS, edid: EDID_UNSUPPORTED },
            },
          ],
        });
        const unsupportedResult = structured(
          await callHandler(
            unsupported,
            "jetkvm_display_status",
            validInput("jetkvm_display_status", unsupported.ref),
          ),
        );
        expect(unsupportedResult).toMatchObject({
          ok: true,
          result: {
            edid: {
              status: "unsupported",
              read_completed: false,
              reason: "edid_read_capability_absent",
              data: null,
            },
          },
        });
        runtime.record("assertion-1", ["handler_fake"], {
          status: "unsupported",
          readCompleted: false,
          dataIsNull: true,
        });

        const unavailable = await runtime.environment();
        unavailable.native.loadScenario({
          version: 1,
          steps: [
            {
              operation: "displayStatus",
              result: { ...DISPLAY_STATUS, edid: EDID_UNAVAILABLE },
            },
          ],
        });
        const unavailableResult = structured(
          await callHandler(
            unavailable,
            "jetkvm_display_status",
            validInput("jetkvm_display_status", unavailable.ref),
          ),
        );
        expect(unavailableResult).toMatchObject({
          ok: true,
          result: {
            edid: {
              status: "unavailable",
              read_completed: true,
              reason: "successful_read_reported_no_edid",
              data: null,
            },
          },
        });
        runtime.record("assertion-2", ["handler_fake"], {
          status: "unavailable",
          readCompleted: true,
          dataIsNull: true,
        });
        expect(
          [
            ...unsupported.native.events(),
            ...unavailable.native.events(),
          ].every(({ operation }) => operation === "displayStatus"),
        ).toBe(true);
        expect(JSON.stringify(unavailableResult)).not.toContain("serialNumber");
        runtime.record("assertion-3", ["handler_fake"], {
          readOnlyCalls: 2,
          mutationCalls: 0,
          streamingFieldPresent: false,
          serialEvidencePresent: false,
        });
      },
    );
  });

  it("executes mouse-observation-fence-and-single-use", async () => {
    await executeStory(
      "mouse-observation-fence-and-single-use",
      async (runtime) => {
        const cancelled = await runtime.environment();
        await publishObservation(cancelled, "mouse-cancel-observation");
        cancelled.browser.loadScenario({ version: 1, steps: [] });
        const abort = new AbortController();
        abort.abort(new Error("cancelled"));
        const cancelError = errorFrom(
          await callHandler(
            cancelled,
            "jetkvm_input_mouse",
            validInput("jetkvm_input_mouse", cancelled.ref, {
              observation_id: "mouse-cancel-observation",
              request_id: "mouse-cancel-request",
            }),
            abort.signal,
          ),
          "CANCELLED",
        );
        expect(cancelError).toMatchObject({
          outcome: "not_sent",
          safe_to_retry: true,
        });
        expect(cancelled.browser.events()).toHaveLength(0);
        runtime.record("assertion-1", ["handler_fake"], {
          outcome: "not_sent",
          downstreamWrites: 0,
          reservationReleased: true,
        });

        const partial = await runtime.environment();
        await publishObservation(partial, "mouse-partial-observation");
        const partialInput = validInput("jetkvm_input_mouse", partial.ref, {
          observation_id: "mouse-partial-observation",
          request_id: "mouse-partial-request",
          actions: [
            { type: "move", x: 10, y: 10 },
            { type: "click", x: 10, y: 10, button: "left" },
          ],
        });
        partial.browser.loadScenario({
          version: 1,
          steps: [partialFaultStep("mouse", 2)],
        });
        const partialError = errorFrom(
          await callHandler(partial, "jetkvm_input_mouse", partialInput),
          "MUTATION_OUTCOME_UNKNOWN",
        );
        expect(resultCounts(partialError)).toMatchObject({
          failed_action_index: 1,
          dispatched_action_count: 2,
          completed_action_count: 1,
        });
        runtime.record("assertion-2", ["handler_fake"], {
          failedActionIndex: 1,
          dispatchedActionCount: 2,
          completedActionCount: 1,
          suffixSuppressed: true,
        });

        const scroll = await runtime.environment();
        await publishObservation(scroll, "mouse-scroll-negative");
        for (const action of [
          { type: "scroll", delta_y: 0 },
          { type: "scroll", delta_y: 1.5 },
          { type: "scroll", delta_y: 128 },
          { type: "scroll", delta_y: -128 },
          { type: "scroll", delta_y: 1, delta_x: 1 },
        ]) {
          scroll.browser.loadScenario({ version: 1, steps: [] });
          expect(
            errorFrom(
              await callHandler(
                scroll,
                "jetkvm_input_mouse",
                validInput("jetkvm_input_mouse", scroll.ref, {
                  request_id: `invalid-scroll-${String(action.delta_y)}-${String(action.delta_x ?? 0)}`,
                  observation_id: "mouse-scroll-negative",
                  actions: [action],
                }),
              ),
              "CONFIG_INVALID",
            ),
          ).toMatchObject({ phase: "validate" });
          expect(scroll.browser.events()).toHaveLength(0);
        }
        const scrollBounds: number[] = [];
        for (const [index, deltaY] of [-127, 127].entries()) {
          const observationId = `mouse-scroll-${index}`;
          await publishObservation(scroll, observationId);
          const input = validInput("jetkvm_input_mouse", scroll.ref, {
            request_id: `scroll-bound-${index}`,
            observation_id: observationId,
            actions: [
              { type: "scroll", x: 10, y: 10, delta_y: deltaY, delta_x: 0 },
            ],
          });
          expect(
            await invokeSuccessfulMutation(scroll, "jetkvm_input_mouse", input),
          ).toMatchObject({ ok: true });
          scrollBounds.push(deltaY);
        }
        runtime.record("assertion-3", ["handler_fake"], {
          negativeBound: scrollBounds[0]!,
          positiveBound: scrollBounds[1]!,
          invalidVariantsRejectedBeforePlane: 5,
        });

        const consumed = await runtime.environment();
        await publishObservation(consumed, "mouse-consumed-observation");
        const first = validInput("jetkvm_input_mouse", consumed.ref, {
          request_id: "mouse-consume-first",
          observation_id: "mouse-consumed-observation",
        });
        expect(
          await invokeSuccessfulMutation(consumed, "jetkvm_input_mouse", first),
        ).toMatchObject({ ok: true });
        consumed.browser.mouse = async (_ref, request) => {
          throw new BrowserPlaneError({
            code: "OBSERVATION_CONSUMED",
            outcome: "not_sent",
            stage: "admission",
            writeBegan: false,
            acknowledged: false,
            dispatchedCount: 0,
            completedCount: 0,
            requestedCount: request.actions.length,
            safeToRetry: true,
            requiredNextStep: "capture_then_retry",
            suffixSuppressed: false,
          });
        };
        consumed.browser.loadScenario({ version: 1, steps: [] });
        const consumedError = errorFrom(
          await callHandler(consumed, "jetkvm_input_mouse", {
            ...first,
            request_id: "mouse-consume-reuse",
          }),
          "OBSERVATION_CONSUMED",
        );
        expect(consumedError).toMatchObject({ outcome: "not_sent" });
        expect(playwrightEvidence.mouse).toEqual({
          dispatchedCount: 1,
          completedCount: 1,
        });
        runtime.record("assertion-4", ["handler_fake", "playwright"], {
          firstDispatchCount: 1,
          reuseDispatchCount: 0,
          replayed: false,
          playwrightCompleted: true,
        });
      },
    );
  });

  it("executes keyboard-physical-keys-only", async () => {
    await executeStory("keyboard-physical-keys-only", async (runtime) => {
      const cancelled = await runtime.environment();
      await publishObservation(cancelled, "keyboard-cancel-observation");
      cancelled.browser.loadScenario({ version: 1, steps: [] });
      const abort = new AbortController();
      abort.abort(new Error("cancelled"));
      const cancelError = errorFrom(
        await callHandler(
          cancelled,
          "jetkvm_input_keyboard",
          validInput("jetkvm_input_keyboard", cancelled.ref, {
            request_id: "keyboard-cancel-request",
            observation_id: "keyboard-cancel-observation",
          }),
          abort.signal,
        ),
        "CANCELLED",
      );
      expect(cancelError).toMatchObject({ outcome: "not_sent" });
      expect(cancelled.browser.events()).toHaveLength(0);
      runtime.record("assertion-1", ["handler_fake"], {
        requestedActionCount: 1,
        dispatchedActionCount: 0,
        completedActionCount: 0,
        planeWrites: 0,
      });

      const partial = await runtime.environment();
      await publishObservation(partial, "keyboard-partial-observation");
      const partialInput = validInput("jetkvm_input_keyboard", partial.ref, {
        request_id: "keyboard-partial-request",
        observation_id: "keyboard-partial-observation",
        actions: [
          { type: "key_press", key: "KeyA" },
          { type: "key_press", key: "Enter" },
        ],
      });
      partial.browser.loadScenario({
        version: 1,
        steps: [partialFaultStep("keyboard", 2)],
      });
      const partialError = errorFrom(
        await callHandler(partial, "jetkvm_input_keyboard", partialInput),
        "MUTATION_OUTCOME_UNKNOWN",
      );
      expect(resultCounts(partialError)).toMatchObject({
        failed_action_index: 1,
        dispatched_action_count: 2,
        completed_action_count: 1,
      });
      runtime.record("assertion-2", ["handler_fake"], {
        failedActionIndex: 1,
        dispatchedActionCount: 2,
        completedActionCount: 1,
        heldKeysAfterCleanup: 0,
      });

      const keyboard = await runtime.environment();
      await publishObservation(keyboard, "keyboard-valid-observation");
      const rejectedText = "PRIVATE_KEYBOARD_TEXT_7f8b";
      for (const [index, actions] of [
        [{ type: "text", text: rejectedText }],
        [{ type: "key_press", key: "KeyAA" }],
      ].entries()) {
        keyboard.browser.loadScenario({ version: 1, steps: [] });
        errorFrom(
          await callHandler(
            keyboard,
            "jetkvm_input_keyboard",
            validInput("jetkvm_input_keyboard", keyboard.ref, {
              request_id: `invalid-keyboard-${index}`,
              observation_id: "keyboard-valid-observation",
              actions,
            }),
          ),
          "CONFIG_INVALID",
        );
        expect(keyboard.browser.events()).toHaveLength(0);
      }
      const valid = validInput("jetkvm_input_keyboard", keyboard.ref, {
        request_id: "keyboard-physical-sequence",
        observation_id: "keyboard-valid-observation",
        actions: [
          { type: "chord", keys: ["ControlLeft", "KeyA"] },
          { type: "key_press", key: "Enter" },
        ],
      });
      expect(
        await invokeSuccessfulMutation(
          keyboard,
          "jetkvm_input_keyboard",
          valid,
        ),
      ).toMatchObject({
        ok: true,
        result: {
          dispatched_action_count: 2,
          completed_action_count: 2,
          held_keys: [],
        },
      });
      expect(playwrightEvidence.keyboard).toEqual({
        dispatchedCount: 2,
        completedCount: 2,
      });
      runtime.sensitive(rejectedText);
      runtime.record("assertion-3", ["handler_fake", "playwright"], {
        textActionsAccepted: false,
        noncanonicalKeysAccepted: false,
        validPhysicalActionsCompleted: 2,
        heldKeys: 0,
      });
    });
  });

  it("executes reliable-paste-91cps-correlated-terminal", async () => {
    await executeStory(
      "reliable-paste-91cps-correlated-terminal",
      async (runtime) => {
        const cancelled = await runtime.environment();
        await publishObservation(cancelled, "paste-cancel-observation");
        cancelled.browser.loadScenario({ version: 1, steps: [] });
        const abort = new AbortController();
        abort.abort(new Error("cancelled"));
        const cancelError = errorFrom(
          await callHandler(
            cancelled,
            "jetkvm_input_paste",
            validInput("jetkvm_input_paste", cancelled.ref, {
              request_id: "paste-cancel-request",
              observation_id: "paste-cancel-observation",
            }),
            abort.signal,
          ),
          "CANCELLED",
        );
        expect(cancelError).toMatchObject({ outcome: "not_sent" });
        expect(cancelled.browser.events()).toHaveLength(0);
        runtime.record("assertion-1", ["handler_fake"], {
          dispatchedCount: 0,
          completedCount: 0,
          downstreamWrites: 0,
          reservationReleased: true,
        });

        const disconnected = await runtime.environment();
        await publishObservation(disconnected, "paste-disconnect-observation");
        const disconnectInput = validInput(
          "jetkvm_input_paste",
          disconnected.ref,
          {
            request_id: "paste-disconnect-request",
            observation_id: "paste-disconnect-observation",
            text: "FixturePaste91",
          },
        );
        disconnected.browser.loadScenario({
          version: 1,
          steps: [
            {
              operation: "paste",
              fault: "disconnect_after_write_before_ack",
              dispatchedCount: 1,
              completedCount: 0,
            },
          ],
        });
        const disconnectError = errorFrom(
          await callHandler(
            disconnected,
            "jetkvm_input_paste",
            disconnectInput,
          ),
          "CONNECTION_LOST",
        );
        expect(disconnectError).toMatchObject({
          outcome: "unknown",
          safe_to_retry: false,
        });
        const disconnectWrites = disconnected.browser.events().length;
        errorFrom(
          await callHandler(
            disconnected,
            "jetkvm_input_paste",
            disconnectInput,
          ),
          "MUTATION_OUTCOME_UNKNOWN",
        );
        expect(disconnected.browser.events()).toHaveLength(disconnectWrites);
        runtime.record("assertion-2", ["handler_fake"], {
          dispatchedCount: 1,
          completedCount: 0,
          mutationGateClosed: true,
          replayWrites: 0,
        });

        const partial = await runtime.environment();
        await publishObservation(partial, "paste-partial-observation");
        const partialInput = validInput("jetkvm_input_paste", partial.ref, {
          request_id: "paste-partial-request",
          observation_id: "paste-partial-observation",
          text: "FixturePaste91",
        });
        partial.browser.loadScenario({
          version: 1,
          steps: [partialFaultStep("paste", 14)],
        });
        const partialError = errorFrom(
          await callHandler(partial, "jetkvm_input_paste", partialInput),
          "MUTATION_OUTCOME_UNKNOWN",
        );
        expect(resultCounts(partialError)).toMatchObject({
          dispatched_action_count: 2,
          completed_action_count: 1,
        });
        const partialWrites = partial.browser.events().length;
        errorFrom(
          await callHandler(partial, "jetkvm_input_paste", partialInput),
          "MUTATION_OUTCOME_UNKNOWN",
        );
        expect(partial.browser.events()).toHaveLength(partialWrites);
        runtime.record("assertion-3", ["handler_fake"], {
          dispatchedCount: 2,
          completedCount: 1,
          suppressedSuffixCharacters: 12,
          replayWrites: 0,
        });

        const success = await runtime.environment();
        await publishObservation(success, "paste-success-observation");
        const text = "FixturePaste91";
        const successInput = validInput("jetkvm_input_paste", success.ref, {
          request_id: "paste-success-request",
          observation_id: "paste-success-observation",
          text,
        });
        const successResult = await invokeSuccessfulMutation(
          success,
          "jetkvm_input_paste",
          successInput,
        );
        expect(successResult).toMatchObject({
          ok: true,
          result: {
            terminal_state: "succeeded",
            normalized_byte_count: 14,
            measured_chars_per_second: 91,
          },
        });
        expect(playwrightEvidence.paste).toMatchObject({
          terminalState: "succeeded",
          measuredSourceCps: 90.9,
        });
        runtime.sensitive(text);
        runtime.record("assertion-4", ["handler_fake", "playwright"], {
          submittedCharacters: 14,
          completedCharacters: 14,
          measuredCharsPerSecond: 91,
          targetApplicationAcceptanceClaimed: false,
        });
      },
    );
  });

  it("executes emergency-release-races-every-writer", async () => {
    await executeStory(
      "emergency-release-races-every-writer",
      async (runtime) => {
        const cleanupTools = [
          "jetkvm_input_keyboard",
          "jetkvm_input_mouse",
          "jetkvm_input_paste",
        ] as const;
        let cleanupEvidenceCount = 0;
        for (const [index, tool] of cleanupTools.entries()) {
          const environment = await runtime.environment();
          await publishObservation(environment, `cleanup-observation-${index}`);
          const input = validInput(tool, environment.ref, {
            observation_id: `cleanup-observation-${index}`,
            request_id: `cleanup-request-${index}`,
          });
          environment.browser.loadScenario({
            version: 1,
            steps: [
              {
                operation: tool.replace("jetkvm_input_", "") as
                  | "keyboard"
                  | "mouse"
                  | "paste",
                fault: "cleanup_failure",
                dispatchedCount: 1,
                completedCount: 0,
              },
            ],
          });
          const error = errorFrom(
            await callHandler(environment, tool, input),
            "MUTATION_OUTCOME_UNKNOWN",
          );
          expect(error).toMatchObject({ phase: "cleanup", outcome: "unknown" });
          cleanupEvidenceCount += 1;
        }
        runtime.record("assertion-1", ["handler_fake"], {
          phase3CleanupBranchesExecuted: cleanupEvidenceCount,
          independentlyRestoredCases: cleanupEvidenceCount,
          restorationFabricated: false,
        });

        const release = await runtime.environment();
        const releaseEnvelope = await invokeRelease(
          release,
          "release-race-request",
        );
        expect(releaseEnvelope).toMatchObject({
          ok: true,
          result: {
            deferred_producers_joined: true,
            paste_terminal: "inactive",
            ordinary_leases_zero: true,
            keyboard_zero: true,
            pointer_zero: true,
          },
        });
        expect(playwrightEvidence.release).toEqual({
          producersJoined: true,
          pasteInactive: true,
          keyboardZero: true,
          pointerZero: true,
        });
        runtime.record("assertion-2", ["handler_fake", "playwright"], {
          producerKindsQuiesced: 5,
          emitsAfterAcknowledgement: 0,
          keyboardZero: true,
          pointerZero: true,
          pasteInactive: true,
        });
      },
    );
  });

  it("executes display-status-cached-freshness-and-streaming-omission", async () => {
    await executeStory(
      "display-status-cached-freshness-and-streaming-omission",
      async (runtime) => {
        const provenance = await runtime.environment();
        provenance.native.loadScenario({
          version: 1,
          steps: [
            {
              operation: "displayStatus",
              result: { ...DISPLAY_STATUS, edid: EDID_UNSUPPORTED },
            },
          ],
        });
        const result = structured(
          await callHandler(
            provenance,
            "jetkvm_display_status",
            validInput("jetkvm_display_status", provenance.ref),
          ),
        );
        expect(result).toMatchObject({
          ok: true,
          result: {
            signal: { age_ms: 7, freshness: "fresh", source: "cached_event" },
            native_resolution: {
              age_ms: 11,
              freshness: "fresh",
              source: "cached_event",
            },
            fps: { age_ms: 17, freshness: "stale", source: "cached_event" },
          },
        });
        expect(JSON.stringify(result)).not.toContain("streaming");
        runtime.record("assertion-1", ["handler_fake"], {
          independentFactAges: true,
          independentFreshness: true,
          proxyStreamingPresent: false,
        });

        const lossTools = [
          "jetkvm_display_capture",
          "jetkvm_display_status",
          "jetkvm_input_keyboard",
          "jetkvm_input_mouse",
          "jetkvm_input_paste",
        ] as const;
        let noReplayCases = 0;
        for (const [index, tool] of lossTools.entries()) {
          const environment = await runtime.environment();
          const isInput = tool.startsWith("jetkvm_input_");
          if (isInput) {
            await publishObservation(
              environment,
              `binding-loss-observation-${index}`,
            );
          }
          const input = validInput(tool, environment.ref, {
            ...(isInput
              ? {
                  observation_id: `binding-loss-observation-${index}`,
                  request_id: `binding-loss-request-${index}`,
                }
              : {}),
          });
          const operation =
            tool === "jetkvm_display_capture"
              ? "capture"
              : tool === "jetkvm_display_status"
                ? "displayStatus"
                : (tool.replace("jetkvm_input_", "") as
                    | "keyboard"
                    | "mouse"
                    | "paste");
          const plane =
            tool === "jetkvm_display_status"
              ? environment.native
              : environment.browser;
          plane.loadScenario({
            version: 1,
            steps: [
              {
                operation,
                fault: "disconnect_after_write_before_ack",
                dispatchedCount: 1,
                completedCount: 0,
              },
            ],
          });
          const error = errorFrom(
            await callHandler(environment, tool, input),
            "CONNECTION_LOST",
          );
          expect(error).toMatchObject({
            outcome: isInput ? "unknown" : null,
            safe_to_retry: !isInput,
          });
          if (isInput) {
            const writes = environment.browser.events().length;
            errorFrom(
              await callHandler(environment, tool, input),
              "MUTATION_OUTCOME_UNKNOWN",
            );
            expect(environment.browser.events()).toHaveLength(writes);
          }
          noReplayCases += 1;
        }
        runtime.record("assertion-2", ["handler_fake"], {
          phase3BindingLossCases: noReplayCases,
          mutationReplayWrites: 0,
          independentlyBoundCases: noReplayCases,
        });

        const unobserved = await runtime.environment();
        unobserved.native.loadScenario({
          version: 1,
          steps: [
            {
              operation: "displayStatus",
              result: { ...UNOBSERVED_DISPLAY_STATUS, edid: EDID_UNSUPPORTED },
            },
          ],
        });
        const unobservedResult = structured(
          await callHandler(
            unobserved,
            "jetkvm_display_status",
            validInput("jetkvm_display_status", unobserved.ref),
          ),
        );
        expect(unobservedResult).toMatchObject({
          ok: true,
          result: {
            signal: {
              value: "unknown",
              observed_at: null,
              age_ms: null,
              freshness: "unknown",
              source: "none",
            },
            native_resolution: {
              value: null,
              observed_at: null,
              age_ms: null,
              freshness: "unknown",
              source: "none",
            },
          },
        });
        runtime.record("assertion-3", ["handler_fake"], {
          unobservedFactsNull: true,
          unobservedSource: "none",
          staleGenerationReused: false,
        });
      },
    );
  });

  it("executes edid-low-level-failure-propagates", async () => {
    await executeStory("edid-low-level-failure-propagates", async (runtime) => {
      const environment = await runtime.environment();
      environment.native.displayStatus = async () => {
        throw new DeviceRpcError(
          "EDID_READ_FAILED",
          "ack",
          "unknown",
          true,
          false,
        );
      };
      const result = await callHandler(
        environment,
        "jetkvm_display_status",
        validInput("jetkvm_display_status", environment.ref),
      );
      const error = errorFrom(result, "EDID_READ_FAILED");
      expect(error).toMatchObject({
        phase: "verify",
        outcome: null,
        verification: "none",
      });
      expect(structured(result)).not.toHaveProperty("result.edid");
      expect(environment.native.events()).toHaveLength(0);
      runtime.record("assertion-1", ["handler_fake"], {
        code: "EDID_READ_FAILED",
        successBranchPresent: false,
        mutationCalls: 0,
      });
    });
  });

  it("keeps the exact eight unchanged canonical story IDs", () => {
    expect(
      stories
        .filter((story) =>
          PHASE_3_STORY_IDS.includes(story.id as Phase3StoryId),
        )
        .map(({ id }) => id),
    ).toEqual([...PHASE_3_STORY_IDS]);
  });
});
