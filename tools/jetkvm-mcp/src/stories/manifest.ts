import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { JETKVM_TOOL_NAMES, type JetKvmToolName } from "../domain.ts";

export const ACCEPTANCE_STORY_SCHEMA_NAME = "AcceptanceStory";

export const CANONICAL_STORY_IDS = [
  "session-connect-without-takeover-busy",
  "session-explicit-authorized-takeover",
  "session-reconnect-invalidates-observations",
  "display-capture-fresh-frame-and-geometry",
  "display-status-resolution-and-read-only-edid",
  "mouse-observation-fence-and-single-use",
  "keyboard-physical-keys-only",
  "reliable-paste-91cps-correlated-terminal",
  "emergency-release-races-every-writer",
  "power-three-semantic-actions",
  "disconnect-before-write-not-sent",
  "disconnect-after-write-unknown-no-replay",
  "duplicate-request-id-definitive-replay",
  "malformed-response-fails-closed",
  "permission-and-capability-errors-actionable",
  "stale-generation-zero-downstream-write",
  "partial-verification-does-not-replay",
  "transport-reconnect-does-not-own-device",
  "display-status-cached-freshness-and-streaming-omission",
  "edid-low-level-failure-propagates",
  "reconnect-requires-new-channel-observations",
  "atx-extension-serialization-idempotency-and-nonproof",
  "sse-get-and-post-share-http-security-boundary",
  "sse-session-id-is-routing-not-authentication",
] as const;

export const BEHAVIOR_REQUIREMENT_IDS = [
  "branch:strict-schema-rejection",
  "branch:permission-denied",
  "branch:capability-missing",
  "branch:deadline-before-admission",
  "branch:cancellation-before-write",
  "branch:disconnect-before-write",
  "branch:disconnect-after-write",
  "branch:malformed-downstream-response",
  "branch:stale-session-generation",
  "branch:busy-without-takeover",
  "branch:authorized-takeover",
  "branch:unauthorized-takeover",
  "branch:definitive-acknowledgement",
  "branch:duplicate-same-request-digest",
  "branch:duplicate-changed-digest",
  "branch:partial-verification",
  "branch:partial-multi-event-dispatch",
  "branch:post-reconnect-input-without-capture",
  "branch:cleanup-failure",
  "branch:per-fact-status-provenance",
  "branch:edid-capability-absent",
  "branch:edid-successful-empty",
  "branch:edid-lower-layer-failure",
  "branch:reconnect-evidence",
  "branch:atx-gate-and-serialization",
  "branch:atx-acknowledgement-semantics",
  "branch:sse-route-security",
  "branch:sse-routing-close",
  "branch:shared-device-rpc-adapter-binding",
  "branch:device-rpc-adapter-replacement",
  "branch:device-rpc-adapter-mid-flight-loss",
  "branch:scroll-validation",
] as const;

export const FOCUSED_ASSERTION_OWNER_PHASES = [
  "phase_3",
  "phase_4",
  "phase_5",
] as const;
export type FocusedAssertionOwnerPhase =
  (typeof FOCUSED_ASSERTION_OWNER_PHASES)[number];

type ApplicableBehaviorCell = {
  applicability: "applicable";
  coverage_scope: "tool" | "shared_transport";
  story_id: (typeof CANONICAL_STORY_IDS)[number];
  step_id: string;
  fault_id: string;
  assertion_id: string;
  focused_assertion_id: string;
  focused_assertion_owner_phase: FocusedAssertionOwnerPhase;
  focused_assertion_phase_2_status: "reserved";
};

type NotApplicableBehaviorCell = {
  applicability: "not_applicable";
  rationale: string;
};

export type ToolBehaviorMatrixCell =
  | ApplicableBehaviorCell
  | NotApplicableBehaviorCell;

export type ToolBehaviorMatrixRow = {
  requirement: (typeof BEHAVIOR_REQUIREMENT_IDS)[number];
  cells: Readonly<Record<JetKvmToolName, ToolBehaviorMatrixCell>>;
};

export type ToolBehaviorMatrix = readonly ToolBehaviorMatrixRow[];

type MatrixApplicableLink = Omit<
  ApplicableBehaviorCell,
  | "coverage_scope"
  | "focused_assertion_id"
  | "focused_assertion_owner_phase"
  | "focused_assertion_phase_2_status"
> & {
  coverage_scope?: "shared_transport";
};

type MatrixDefinition = {
  requirement: (typeof BEHAVIOR_REQUIREMENT_IDS)[number];
  applicable: Partial<Readonly<Record<JetKvmToolName, MatrixApplicableLink>>>;
  not_applicable: Partial<
    Readonly<Record<JetKvmToolName, NotApplicableBehaviorCell>>
  >;
};

const T = {
  capture: "jetkvm_display_capture",
  displayStatus: "jetkvm_display_status",
  keyboard: "jetkvm_input_keyboard",
  mouse: "jetkvm_input_mouse",
  paste: "jetkvm_input_paste",
  release: "jetkvm_input_release",
  power: "jetkvm_power_control",
  connect: "jetkvm_session_connect",
  reconnect: "jetkvm_session_reconnect",
  sessionStatus: "jetkvm_session_status",
} as const satisfies Readonly<Record<string, JetKvmToolName>>;

const FOCUSED_ASSERTION_OWNER_PHASE_BY_TOOL: Readonly<
  Record<JetKvmToolName, Exclude<FocusedAssertionOwnerPhase, "phase_5">>
> = Object.freeze({
  jetkvm_display_capture: "phase_3",
  jetkvm_display_status: "phase_3",
  jetkvm_input_keyboard: "phase_3",
  jetkvm_input_mouse: "phase_3",
  jetkvm_input_paste: "phase_3",
  jetkvm_input_release: "phase_3",
  jetkvm_power_control: "phase_4",
  jetkvm_session_connect: "phase_4",
  jetkvm_session_reconnect: "phase_4",
  jetkvm_session_status: "phase_4",
});

function linked(
  storyIndex: number,
  step_id: string,
  fault_id: string,
  assertion_id: string,
): MatrixApplicableLink {
  return {
    applicability: "applicable",
    story_id: CANONICAL_STORY_IDS[storyIndex]!,
    step_id,
    fault_id,
    assertion_id,
  };
}

function toolSlug(tool: JetKvmToolName): string {
  return tool.replaceAll("_", "-");
}

function requirementSlug(
  requirement: (typeof BEHAVIOR_REQUIREMENT_IDS)[number],
): string {
  return requirement.replace("branch:", "");
}

function focusedAssertionId(
  tool: JetKvmToolName,
  requirement: (typeof BEHAVIOR_REQUIREMENT_IDS)[number],
  coverageScope: ApplicableBehaviorCell["coverage_scope"],
): string {
  const layer =
    coverageScope === "shared_transport"
      ? "transport"
      : requirement.startsWith("branch:device-rpc-adapter-") ||
          requirement === "branch:shared-device-rpc-adapter-binding"
        ? "adapter"
        : "unit";
  return `${layer}:${toolSlug(tool)}:${requirementSlug(requirement)}`;
}

function focusedAssertionOwnerPhase(
  tool: JetKvmToolName,
  coverageScope: ApplicableBehaviorCell["coverage_scope"],
): FocusedAssertionOwnerPhase {
  return coverageScope === "shared_transport"
    ? "phase_5"
    : FOCUSED_ASSERTION_OWNER_PHASE_BY_TOOL[tool];
}

function reviewed(
  tool: JetKvmToolName,
  rationale: string,
): NotApplicableBehaviorCell {
  return {
    applicability: "not_applicable",
    rationale: `Reviewed for ${tool}: ${rationale}`,
  };
}

function linkedForTools(
  tools: readonly JetKvmToolName[],
  storyIndex: number,
  stepPrefix: string,
  faultId: string,
  assertionId: string,
): MatrixDefinition["applicable"] {
  return Object.fromEntries(
    tools.map((tool) => [
      tool,
      linked(
        storyIndex,
        `${stepPrefix}-${toolSlug(tool)}`,
        faultId,
        assertionId,
      ),
    ]),
  ) as MatrixDefinition["applicable"];
}

function forEveryTool(
  storyIndex: number,
  stepPrefix: string,
  faultId: string,
  assertionId: string,
): MatrixDefinition["applicable"] {
  return linkedForTools(
    JETKVM_TOOL_NAMES,
    storyIndex,
    stepPrefix,
    faultId,
    assertionId,
  );
}

function linkedForToolsWithPerToolFault(
  tools: readonly JetKvmToolName[],
  storyIndex: number,
  stepPrefix: string,
  faultPrefix: string,
  assertionId: string,
): MatrixDefinition["applicable"] {
  return Object.fromEntries(
    tools.map((tool) => {
      const slug = toolSlug(tool);
      return [
        tool,
        linked(
          storyIndex,
          `${stepPrefix}-${slug}`,
          `${faultPrefix}-${slug}`,
          assertionId,
        ),
      ];
    }),
  ) as MatrixDefinition["applicable"];
}

function forEveryToolWithPerToolFault(
  storyIndex: number,
  stepPrefix: string,
  faultPrefix: string,
  assertionId: string,
): MatrixDefinition["applicable"] {
  return linkedForToolsWithPerToolFault(
    JETKVM_TOOL_NAMES,
    storyIndex,
    stepPrefix,
    faultPrefix,
    assertionId,
  );
}

function sharedTransportForEveryTool(
  cell: MatrixApplicableLink,
): MatrixDefinition["applicable"] {
  return Object.fromEntries(
    JETKVM_TOOL_NAMES.map((tool) => [
      tool,
      { ...cell, coverage_scope: "shared_transport" },
    ]),
  ) as MatrixDefinition["applicable"];
}

const MATRIX_DEFINITIONS = [
  {
    requirement: "branch:strict-schema-rejection",
    applicable: forEveryTool(
      0,
      "reject-strict-schema",
      "strict-schema-before-controller",
      "assertion-1",
    ),
    not_applicable: {},
  },
  {
    requirement: "branch:permission-denied",
    applicable: {
      ...forEveryTool(
        14,
        "status-without-permission",
        "deny-then-remove-capability",
        "assertion-1",
      ),
      [T.connect]: linked(
        1,
        "permission-denied-unauthorized-takeover",
        "permission-denied-unauthorized-takeover",
        "assertion-1",
      ),
      [T.reconnect]: linked(
        1,
        "denied-reconnect-takeover",
        "deny-reconnect-takeover-permission",
        "assertion-1",
      ),
    },
    not_applicable: {},
  },
  {
    requirement: "branch:capability-missing",
    applicable: {
      ...linkedForTools(
        JETKVM_TOOL_NAMES.filter(
          (tool) =>
            tool !== T.connect && tool !== T.reconnect && tool !== T.capture,
        ),
        14,
        "keyboard-without-capability",
        "deny-then-remove-capability",
        "assertion-2",
      ),
      [T.capture]: linked(
        3,
        "capture-without-display-capability",
        "remove-display-capture-capability",
        "assertion-1",
      ),
    },
    not_applicable: {
      [T.connect]: reviewed(
        T.connect,
        "connect compatibility failures use dedicated AUTH_FAILED, UNSUPPORTED_UI_VERSION, FIRMWARE_INCOMPATIBLE, BROWSER_UNSUPPORTED, or reachability codes because auth, UI, and WebRTC are not CapabilityName keys.",
      ),
      [T.reconnect]: reviewed(
        T.reconnect,
        "reconnect compatibility failures use dedicated AUTH_FAILED, UNSUPPORTED_UI_VERSION, FIRMWARE_INCOMPATIBLE, BROWSER_UNSUPPORTED, or reachability codes because auth, UI, and WebRTC are not CapabilityName keys.",
      ),
    },
  },
  {
    requirement: "branch:deadline-before-admission",
    applicable: forEveryToolWithPerToolFault(
      0,
      "deadline-before-admission",
      "expire-before-admission",
      "assertion-2",
    ),
    not_applicable: {},
  },
  {
    requirement: "branch:cancellation-before-write",
    applicable: {
      ...forEveryToolWithPerToolFault(
        5,
        "cancel-before-write",
        "cancel-before-write",
        "assertion-1",
      ),
      [T.keyboard]: linked(
        6,
        "cancel-physical-key-before-write",
        "cancel-keyboard-before-write",
        "assertion-1",
      ),
      [T.paste]: linked(
        7,
        "paste-cancel-before-acceptance",
        "cancel-before-paste-acceptance",
        "assertion-1",
      ),
    },
    not_applicable: {},
  },
  {
    requirement: "branch:disconnect-before-write",
    applicable: {
      ...linkedForToolsWithPerToolFault(
        JETKVM_TOOL_NAMES.filter(
          (tool) =>
            tool !== T.capture &&
            tool !== T.displayStatus &&
            tool !== T.sessionStatus,
        ),
        10,
        "disconnect-before-write",
        "arm-disconnect-before-write",
        "assertion-1",
      ),
      ...linkedForToolsWithPerToolFault(
        [T.capture, T.displayStatus, T.sessionStatus],
        10,
        "disconnect-before-write",
        "arm-disconnect-before-write",
        "assertion-2",
      ),
    },
    not_applicable: {},
  },
  {
    requirement: "branch:disconnect-after-write",
    applicable: {
      ...linkedForToolsWithPerToolFault(
        JETKVM_TOOL_NAMES.filter(
          (tool) =>
            tool !== T.capture &&
            tool !== T.displayStatus &&
            tool !== T.sessionStatus,
        ),
        11,
        "disconnect-after-write",
        "arm-disconnect-after-write",
        "assertion-1",
      ),
      ...linkedForToolsWithPerToolFault(
        [T.capture, T.displayStatus, T.sessionStatus],
        11,
        "disconnect-after-write",
        "arm-disconnect-after-write",
        "assertion-2",
      ),
      [T.paste]: linked(
        7,
        "paste-disconnect-after-write",
        "disconnect-after-paste-write",
        "assertion-2",
      ),
    },
    not_applicable: {},
  },
  {
    requirement: "branch:malformed-downstream-response",
    applicable: forEveryToolWithPerToolFault(
      13,
      "malformed-after-write",
      "arm-malformed-after-write",
      "assertion-1",
    ),
    not_applicable: {},
  },
  {
    requirement: "branch:stale-session-generation",
    applicable: {
      ...linkedForTools(
        JETKVM_TOOL_NAMES.filter((tool) => tool !== T.connect),
        15,
        "stale-keyboard-generation",
        "retain-prior-generation",
        "assertion-1",
      ),
      [T.mouse]: linked(
        2,
        "input-with-stale-generation",
        "publish-new-generation",
        "assertion-1",
      ),
    },
    not_applicable: {
      [T.connect]: reviewed(
        T.connect,
        "connect creates the first generation and accepts no session_generation field to compare as stale.",
      ),
    },
  },
  {
    requirement: "branch:busy-without-takeover",
    applicable: {
      [T.connect]: linked(
        0,
        "retry-expired-connect-request",
        "incumbent-busy",
        "assertion-3",
      ),
      [T.reconnect]: linked(
        0,
        "reconnect-without-takeover",
        "incumbent-busy",
        "assertion-3",
      ),
    },
    not_applicable: {
      [T.capture]: reviewed(
        T.capture,
        "capture operates only inside an already-owned session and has no takeover option or ownership publication.",
      ),
      [T.displayStatus]: reviewed(
        T.displayStatus,
        "display status is read-only inside the incumbent session and cannot request ownership.",
      ),
      [T.keyboard]: reviewed(
        T.keyboard,
        "keyboard input requires an existing generation and cannot acquire or take over device ownership.",
      ),
      [T.mouse]: reviewed(
        T.mouse,
        "mouse input requires an existing observation and cannot acquire or take over device ownership.",
      ),
      [T.paste]: reviewed(
        T.paste,
        "paste requires an existing observation and cannot acquire or take over device ownership.",
      ),
      [T.release]: reviewed(
        T.release,
        "release drains an already-owned generation and has no ownership acquisition path.",
      ),
      [T.power]: reviewed(
        T.power,
        "power control requires an existing generation and cannot publish device ownership.",
      ),
      [T.sessionStatus]: reviewed(
        T.sessionStatus,
        "session status only inspects the incumbent generation and has no takeover input.",
      ),
    },
  },
  {
    requirement: "branch:authorized-takeover",
    applicable: {
      [T.connect]: linked(
        1,
        "authorized-takeover",
        "arm-authorized-takeover-permission",
        "assertion-2",
      ),
      [T.reconnect]: linked(
        1,
        "authorized-reconnect-takeover",
        "arm-authorized-reconnect-takeover-permission",
        "assertion-2",
      ),
    },
    not_applicable: {
      [T.capture]: reviewed(
        T.capture,
        "capture cannot request takeover and only reads from the generation already authorized by connect or reconnect.",
      ),
      [T.displayStatus]: reviewed(
        T.displayStatus,
        "display status cannot request takeover and only reads the current authorized generation.",
      ),
      [T.keyboard]: reviewed(
        T.keyboard,
        "keyboard actions cannot request takeover; they are fenced to an existing authorized generation.",
      ),
      [T.mouse]: reviewed(
        T.mouse,
        "mouse actions cannot request takeover; they are fenced to an existing authorized generation.",
      ),
      [T.paste]: reviewed(
        T.paste,
        "paste cannot request takeover; it is fenced to an existing authorized generation.",
      ),
      [T.release]: reviewed(
        T.release,
        "release is an emergency operation for the current generation, not an ownership publication operation.",
      ),
      [T.power]: reviewed(
        T.power,
        "power control cannot request takeover and only mutates through an existing authorized generation.",
      ),
      [T.sessionStatus]: reviewed(
        T.sessionStatus,
        "session status is read-only and has no takeover option or ownership publication.",
      ),
    },
  },
  {
    requirement: "branch:unauthorized-takeover",
    applicable: {
      [T.connect]: linked(
        1,
        "denied-takeover",
        "alternate-takeover-permission",
        "assertion-3",
      ),
      [T.reconnect]: linked(
        1,
        "denied-reconnect-takeover",
        "deny-reconnect-takeover-permission",
        "assertion-3",
      ),
    },
    not_applicable: {
      [T.capture]: reviewed(
        T.capture,
        "capture exposes no takeover flag, so takeover authorization is never evaluated by this handler.",
      ),
      [T.displayStatus]: reviewed(
        T.displayStatus,
        "display status exposes no takeover flag, so takeover authorization is never evaluated.",
      ),
      [T.keyboard]: reviewed(
        T.keyboard,
        "keyboard input exposes no takeover flag and cannot enter the ownership authorization branch.",
      ),
      [T.mouse]: reviewed(
        T.mouse,
        "mouse input exposes no takeover flag and cannot enter the ownership authorization branch.",
      ),
      [T.paste]: reviewed(
        T.paste,
        "paste exposes no takeover flag and cannot enter the ownership authorization branch.",
      ),
      [T.release]: reviewed(
        T.release,
        "release exposes no takeover flag and operates only on the caller's current generation.",
      ),
      [T.power]: reviewed(
        T.power,
        "power control exposes no takeover flag and cannot enter the ownership authorization branch.",
      ),
      [T.sessionStatus]: reviewed(
        T.sessionStatus,
        "session status exposes no takeover flag and performs no ownership change.",
      ),
    },
  },
  {
    requirement: "branch:definitive-acknowledgement",
    applicable: linkedForTools(
      [
        T.connect,
        T.reconnect,
        T.keyboard,
        T.mouse,
        T.paste,
        T.release,
        T.power,
      ],
      9,
      "definitive-acknowledgement",
      "fixed-atx-sequence",
      "assertion-1",
    ),
    not_applicable: {
      [T.capture]: reviewed(
        T.capture,
        "capture returns a fresh read result rather than the MutationState acknowledgement contract.",
      ),
      [T.displayStatus]: reviewed(
        T.displayStatus,
        "display status returns observed read facts and does not acknowledge a mutation.",
      ),
      [T.sessionStatus]: reviewed(
        T.sessionStatus,
        "session status returns observed session facts and does not acknowledge a mutation.",
      ),
    },
  },
  {
    requirement: "branch:duplicate-same-request-digest",
    applicable: linkedForTools(
      [
        T.connect,
        T.reconnect,
        T.keyboard,
        T.mouse,
        T.paste,
        T.release,
        T.power,
      ],
      12,
      "duplicate-same-request-digest",
      "repeat-ledger-key",
      "assertion-1",
    ),
    not_applicable: {
      [T.capture]: reviewed(
        T.capture,
        "capture has no request_id and is intentionally outside mutation-ledger deduplication.",
      ),
      [T.displayStatus]: reviewed(
        T.displayStatus,
        "display status has no request_id and is intentionally outside mutation-ledger deduplication.",
      ),
      [T.sessionStatus]: reviewed(
        T.sessionStatus,
        "session status has no request_id and is intentionally outside mutation-ledger deduplication.",
      ),
    },
  },
  {
    requirement: "branch:duplicate-changed-digest",
    applicable: linkedForTools(
      [
        T.connect,
        T.reconnect,
        T.keyboard,
        T.mouse,
        T.paste,
        T.release,
        T.power,
      ],
      12,
      "duplicate-changed-digest",
      "repeat-ledger-key",
      "assertion-2",
    ),
    not_applicable: {
      [T.capture]: reviewed(
        T.capture,
        "capture has no request_id whose digest could conflict with a prior mutation.",
      ),
      [T.displayStatus]: reviewed(
        T.displayStatus,
        "display status has no request_id whose digest could conflict with a prior mutation.",
      ),
      [T.sessionStatus]: reviewed(
        T.sessionStatus,
        "session status has no request_id whose digest could conflict with a prior mutation.",
      ),
    },
  },
  {
    requirement: "branch:partial-verification",
    applicable: linkedForToolsWithPerToolFault(
      [T.connect, T.reconnect, T.keyboard, T.mouse, T.paste, T.power],
      16,
      "partial-verification",
      "arm-partial-verification",
      "assertion-2",
    ),
    not_applicable: {
      [T.release]: reviewed(
        T.release,
        "release success requires device_state_verified, while acknowledgement or state-proof loss is unknown with no verified device state.",
      ),
      [T.capture]: reviewed(
        T.capture,
        "capture is a single read result and has no applied mutation acknowledgement to preserve during later verification.",
      ),
      [T.displayStatus]: reviewed(
        T.displayStatus,
        "display status is a read and has no applied acknowledgement followed by mutation verification.",
      ),
      [T.sessionStatus]: reviewed(
        T.sessionStatus,
        "session status is a read and has no applied acknowledgement followed by mutation verification.",
      ),
    },
  },
  {
    requirement: "branch:partial-multi-event-dispatch",
    applicable: {
      [T.mouse]: linked(
        5,
        "partial-mouse-dispatch",
        "interrupt-mouse-after-first-event",
        "assertion-2",
      ),
      [T.keyboard]: linked(
        6,
        "send-partial-physical-keys",
        "interrupt-key-sequence",
        "assertion-2",
      ),
      [T.paste]: linked(
        7,
        "submit-reliable-paste",
        "paste-boundary-sequence",
        "assertion-3",
      ),
    },
    not_applicable: {
      [T.capture]: reviewed(
        T.capture,
        "capture produces one bounded read result and has no ordered mutation-event suffix to suppress.",
      ),
      [T.displayStatus]: reviewed(
        T.displayStatus,
        "display status produces one read result and has no ordered mutation-event suffix to suppress.",
      ),
      [T.release]: reviewed(
        T.release,
        "release is one generation-drain operation whose partial state is covered by cleanup and unknown-outcome semantics, not a caller event list.",
      ),
      [T.power]: reviewed(
        T.power,
        "power accepts one semantic action; ON/OFF serialization is covered by the dedicated ATX rows rather than a caller event list.",
      ),
      [T.connect]: reviewed(
        T.connect,
        "connect accepts one ownership operation and no caller-supplied multi-event sequence.",
      ),
      [T.reconnect]: reviewed(
        T.reconnect,
        "reconnect accepts one replacement operation and no caller-supplied multi-event sequence.",
      ),
      [T.sessionStatus]: reviewed(
        T.sessionStatus,
        "session status is a read and has no caller-supplied multi-event sequence.",
      ),
    },
  },
  {
    requirement: "branch:post-reconnect-input-without-capture",
    applicable: {
      [T.mouse]: linked(
        2,
        "input-with-old-observation",
        "publish-new-generation",
        "assertion-2",
      ),
      [T.keyboard]: linked(
        2,
        "keyboard-with-old-observation",
        "publish-new-generation",
        "assertion-2",
      ),
      [T.paste]: linked(
        2,
        "paste-with-old-observation",
        "publish-new-generation",
        "assertion-2",
      ),
    },
    not_applicable: {
      [T.capture]: reviewed(
        T.capture,
        "capture creates the fresh observation required after reconnect rather than consuming an observation.",
      ),
      [T.displayStatus]: reviewed(
        T.displayStatus,
        "display status consumes no input observation and remains a read-only status operation.",
      ),
      [T.release]: reviewed(
        T.release,
        "emergency release intentionally requires no observation so it can drain unsafe held input.",
      ),
      [T.power]: reviewed(
        T.power,
        "power control is generation-fenced but does not consume a display observation.",
      ),
      [T.connect]: reviewed(
        T.connect,
        "connect creates session ownership and does not consume a prior display observation.",
      ),
      [T.reconnect]: reviewed(
        T.reconnect,
        "reconnect invalidates observations and returns fresh_capture_required rather than consuming one.",
      ),
      [T.sessionStatus]: reviewed(
        T.sessionStatus,
        "session status consumes no input observation and only reports fresh_capture_required.",
      ),
    },
  },
  {
    requirement: "branch:cleanup-failure",
    applicable: {
      [T.capture]: linked(
        3,
        "capture-fresh-frame",
        "post-capture-cleanup-failure",
        "assertion-2",
      ),
      ...linkedForToolsWithPerToolFault(
        [
          T.keyboard,
          T.mouse,
          T.paste,
          T.release,
          T.power,
          T.connect,
          T.reconnect,
        ],
        8,
        "cleanup-failure",
        "arm-cleanup-failure",
        "assertion-1",
      ),
    },
    not_applicable: {
      [T.displayStatus]: reviewed(
        T.displayStatus,
        "display status holds no input, producer, ownership publication, or mutation resource requiring post-operation cleanup.",
      ),
      [T.sessionStatus]: reviewed(
        T.sessionStatus,
        "session status holds no input, producer, ownership publication, or mutation resource requiring post-operation cleanup.",
      ),
    },
  },
  {
    requirement: "branch:per-fact-status-provenance",
    applicable: {
      [T.displayStatus]: linked(
        18,
        "status-with-unequal-facts",
        "arm-unequal-display-fact-provenance",
        "assertion-1",
      ),
      [T.sessionStatus]: linked(
        18,
        "session-status-after-binding-loss",
        "lose-binding-during-read",
        "assertion-1",
      ),
    },
    not_applicable: {
      [T.capture]: reviewed(
        T.capture,
        "capture returns one fresh frame timestamp and geometry, not independently sourced cached status facts.",
      ),
      [T.keyboard]: reviewed(
        T.keyboard,
        "keyboard returns mutation counts and held state, not signal, resolution, or FPS provenance.",
      ),
      [T.mouse]: reviewed(
        T.mouse,
        "mouse returns mutation counts and post-capture state, not independently sourced status facts.",
      ),
      [T.paste]: reviewed(
        T.paste,
        "paste returns correlated lifecycle facts, not signal, resolution, or FPS provenance.",
      ),
      [T.release]: reviewed(
        T.release,
        "release returns drain acknowledgements, not signal, resolution, or FPS provenance.",
      ),
      [T.power]: reviewed(
        T.power,
        "power reports a separately qualified ATX LED observation, not native capture fact provenance.",
      ),
      [T.connect]: reviewed(
        T.connect,
        "connect returns ownership and generation state, not independently sourced native capture facts.",
      ),
      [T.reconnect]: reviewed(
        T.reconnect,
        "reconnect returns replacement evidence and fresh_capture_required, not native capture fact provenance.",
      ),
    },
  },
  {
    requirement: "branch:edid-capability-absent",
    applicable: {
      [T.displayStatus]: linked(
        4,
        "status-without-edid-capability",
        "sequence-edid-states",
        "assertion-1",
      ),
    },
    not_applicable: Object.fromEntries(
      JETKVM_TOOL_NAMES.filter((tool) => tool !== T.displayStatus).map(
        (tool) => [
          tool,
          reviewed(
            tool,
            "only jetkvm_display_status exposes the optional read-only EDID result union; this handler has no EDID field.",
          ),
        ],
      ),
    ),
  },
  {
    requirement: "branch:edid-successful-empty",
    applicable: {
      [T.displayStatus]: linked(
        4,
        "status-with-empty-edid",
        "sequence-edid-states",
        "assertion-2",
      ),
    },
    not_applicable: Object.fromEntries(
      JETKVM_TOOL_NAMES.filter((tool) => tool !== T.displayStatus).map(
        (tool) => [
          tool,
          reviewed(
            tool,
            "only jetkvm_display_status performs a qualified EDID read that can complete successfully with no EDID bytes.",
          ),
        ],
      ),
    ),
  },
  {
    requirement: "branch:edid-lower-layer-failure",
    applicable: {
      [T.displayStatus]: linked(
        19,
        "read-edid-lower-failure",
        "fail-qualified-edid-read",
        "assertion-1",
      ),
    },
    not_applicable: Object.fromEntries(
      JETKVM_TOOL_NAMES.filter((tool) => tool !== T.displayStatus).map(
        (tool) => [
          tool,
          reviewed(
            tool,
            "only jetkvm_display_status invokes the lower-layer read-only EDID operation that can return EDID_READ_FAILED.",
          ),
        ],
      ),
    ),
  },
  {
    requirement: "branch:reconnect-evidence",
    applicable: {
      [T.reconnect]: linked(
        20,
        "reconnect-with-new-channel",
        "replace-one-shared-adapter",
        "assertion-1",
      ),
    },
    not_applicable: Object.fromEntries(
      JETKVM_TOOL_NAMES.filter((tool) => tool !== T.reconnect).map((tool) => [
        tool,
        reviewed(
          tool,
          "only jetkvm_session_reconnect publishes a replacement generation and must prove new WebRTC, RPC, HID, and browser-channel observations.",
        ),
      ]),
    ),
  },
  {
    requirement: "branch:atx-gate-and-serialization",
    applicable: {
      [T.power]: linked(
        21,
        "serialized-power-short",
        "atx-midflight-binding-loss",
        "assertion-1",
      ),
    },
    not_applicable: Object.fromEntries(
      JETKVM_TOOL_NAMES.filter((tool) => tool !== T.power).map((tool) => [
        tool,
        reviewed(
          tool,
          "only jetkvm_power_control drives the atx-power serial extension and owns its full-sequence mutex and fixed timing.",
        ),
      ]),
    ),
  },
  {
    requirement: "branch:atx-acknowledgement-semantics",
    applicable: {
      [T.power]: linked(
        21,
        "serialized-power-short",
        "atx-midflight-binding-loss",
        "assertion-2",
      ),
    },
    not_applicable: Object.fromEntries(
      JETKVM_TOOL_NAMES.filter((tool) => tool !== T.power).map((tool) => [
        tool,
        reviewed(
          tool,
          "only jetkvm_power_control reports serial ON/OFF completion separately from an uncorrelated cached ATX LED fact.",
        ),
      ]),
    ),
  },
  {
    requirement: "branch:sse-route-security",
    applicable: sharedTransportForEveryTool(
      linked(
        22,
        "secure-sse-get",
        "allow-valid-routes",
        "assert-valid-routes-share-boundary",
      ),
    ),
    not_applicable: {},
  },
  {
    requirement: "branch:sse-routing-close",
    applicable: sharedTransportForEveryTool(
      linked(
        23,
        "post-inactive-sdk-stream",
        "disconnect-inactive-stream-after-routing",
        "assert-inactive-sdk-stream-500",
      ),
    ),
    not_applicable: {},
  },
  {
    requirement: "branch:shared-device-rpc-adapter-binding",
    applicable: forEveryTool(
      20,
      "shared-device-rpc-adapter-binding",
      "replace-one-shared-adapter",
      "assertion-2",
    ),
    not_applicable: {},
  },
  {
    requirement: "branch:device-rpc-adapter-replacement",
    applicable: forEveryTool(
      20,
      "device-rpc-adapter-replacement",
      "replace-one-shared-adapter",
      "assertion-3",
    ),
    not_applicable: {},
  },
  {
    requirement: "branch:device-rpc-adapter-mid-flight-loss",
    applicable: {
      ...linkedForToolsWithPerToolFault(
        JETKVM_TOOL_NAMES.filter((tool) => tool !== T.power),
        18,
        "device-rpc-adapter-mid-flight-loss",
        "arm-device-rpc-adapter-mid-flight-loss",
        "assertion-2",
      ),
      [T.power]: linked(
        21,
        "power-after-on-binding-loss",
        "atx-midflight-binding-loss",
        "assertion-3",
      ),
    },
    not_applicable: {},
  },
  {
    requirement: "branch:scroll-validation",
    applicable: {
      [T.mouse]: linked(
        5,
        "scroll-negative-bound",
        "validate-scroll-before-plane",
        "assertion-3",
      ),
    },
    not_applicable: Object.fromEntries(
      JETKVM_TOOL_NAMES.filter((tool) => tool !== T.mouse).map((tool) => [
        tool,
        reviewed(
          tool,
          "only jetkvm_input_mouse accepts HID wheel deltas; this handler exposes no scroll action or horizontal wheel field.",
        ),
      ]),
    ),
  },
] as const satisfies readonly MatrixDefinition[];

function buildToolBehaviorMatrix(): ToolBehaviorMatrix {
  return MATRIX_DEFINITIONS.map((definition) => {
    const { requirement } = definition;
    const { applicable, not_applicable } = definition as MatrixDefinition;
    const cells = Object.fromEntries(
      JETKVM_TOOL_NAMES.map((tool) => {
        const definitionCell = applicable[tool] ?? not_applicable[tool];
        if (definitionCell === undefined) {
          throw new Error(
            `Behavior matrix definition ${requirement} has no reviewed cell for ${tool}`,
          );
        }
        if (definitionCell.applicability === "not_applicable") {
          return [tool, definitionCell];
        }
        const coverageScope = definitionCell.coverage_scope ?? "tool";
        return [
          tool,
          {
            ...definitionCell,
            coverage_scope: coverageScope,
            focused_assertion_id: focusedAssertionId(
              tool,
              requirement,
              coverageScope,
            ),
            focused_assertion_owner_phase: focusedAssertionOwnerPhase(
              tool,
              coverageScope,
            ),
            focused_assertion_phase_2_status: "reserved",
          },
        ];
      }),
    ) as Record<JetKvmToolName, ToolBehaviorMatrixCell>;
    return { requirement, cells };
  });
}

export const TOOL_BEHAVIOR_MATRIX = buildToolBehaviorMatrix();

export type FocusedAssertionExecutionResult = Readonly<{
  focused_assertion_id: string;
  test_identity: string;
  result: "pass" | "fail" | "skip" | "todo";
}>;

const focusedAssertionExecutionResultSchema = z
  .object({
    focused_assertion_id: z.string().min(1),
    test_identity: z.string().min(1),
    result: z.enum(["pass", "fail", "skip", "todo"]),
  })
  .strict();

export function validateFocusedAssertionExecutions(
  ownerPhase: FocusedAssertionOwnerPhase,
  values: readonly unknown[],
  matrix: ToolBehaviorMatrix = TOOL_BEHAVIOR_MATRIX,
): FocusedAssertionExecutionResult[] {
  const results = values.map((value, index) => {
    const parsed = focusedAssertionExecutionResultSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `Focused assertion execution result ${index} must contain only focused_assertion_id, test_identity, and result.`,
      );
    }
    return parsed.data;
  });

  const ownerById = new Map<string, FocusedAssertionOwnerPhase>();
  const expectedIds: string[] = [];
  for (const row of matrix) {
    for (const cell of Object.values(row.cells)) {
      if (cell.applicability !== "applicable") continue;
      const existingOwner = ownerById.get(cell.focused_assertion_id);
      if (existingOwner !== undefined) {
        throw new Error(
          `Behavior matrix has duplicate focused assertion ID ${cell.focused_assertion_id}.`,
        );
      }
      ownerById.set(
        cell.focused_assertion_id,
        cell.focused_assertion_owner_phase,
      );
      if (cell.focused_assertion_owner_phase === ownerPhase) {
        expectedIds.push(cell.focused_assertion_id);
      }
    }
  }

  const seenIds = new Set<string>();
  const seenIdentities = new Set<string>();
  for (const result of results) {
    if (seenIds.has(result.focused_assertion_id)) {
      throw new Error(
        `Duplicate focused assertion ID ${result.focused_assertion_id}.`,
      );
    }
    seenIds.add(result.focused_assertion_id);
    if (seenIdentities.has(result.test_identity)) {
      throw new Error(`Duplicate test identity ${result.test_identity}.`);
    }
    seenIdentities.add(result.test_identity);
    if (result.result !== "pass") {
      throw new Error(
        `Focused assertion ${result.focused_assertion_id} must pass; execution result was ${result.result}.`,
      );
    }
    const actualOwner = ownerById.get(result.focused_assertion_id);
    if (actualOwner !== ownerPhase) {
      const ownership =
        actualOwner === undefined ? "not reserved" : `owned by ${actualOwner}`;
      throw new Error(
        `Unexpected focused assertion ${result.focused_assertion_id} for ${ownerPhase}: ${ownership}.`,
      );
    }
  }

  const missingIds = expectedIds.filter((id) => !seenIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(
      `Missing focused assertion executions for ${ownerPhase}: ${missingIds.join(", ")}.`,
    );
  }

  return results;
}

const storyConditionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().min(1),
    required: z.literal(true),
  })
  .strict();

const faultStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    after_step: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .nullable(),
    boundary: z.enum([
      "before_admission",
      "queued",
      "before_write",
      "after_write",
      "after_acknowledgement",
      "during_verification",
      "during_cleanup",
      "transport_route",
    ]),
    action: z.string().min(1),
    expected_effect: z.string().min(1),
  })
  .strict();

const storyStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    tool: z.enum(JETKVM_TOOL_NAMES).nullable(),
    call: z.string().min(1),
    input: z.record(z.unknown()),
    timeout_ms: z.number().int().min(100).max(300_000).nullable(),
    expect: z.string().min(1),
  })
  .strict();

const storyAssertionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    requirement: z
      .string()
      .regex(/^(?:branch|contract):[a-z0-9]+(?:-[a-z0-9]+)*$/),
    assertion: z.string().min(1),
  })
  .strict();

const evidenceFieldSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    requirement: z
      .string()
      .regex(/^(?:branch|contract):[a-z0-9]+(?:-[a-z0-9]+)*$/),
    field: z.enum([
      "requirement_result",
      "source_hash",
      "artifact_hash",
      "sanitized_version",
      "opaque_identifier",
      "generation_identifier",
      "dimensions",
      "count",
      "duration_ms",
      "outcome",
      "verification",
      "acknowledgement_step",
      "first_mismatch_index",
      "normalized_payload_hash",
      "restore_result",
      "http_status",
    ]),
    source: z.string().min(1),
    retention: z.enum(["test_run", "release_manifest"]),
  })
  .strict();

const restoreStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    action: z.string().min(1),
    assertion: z.string().min(1),
    always: z.literal(true),
  })
  .strict();

const privacyRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    rule: z.string().min(1),
    prohibited: z
      .array(
        z.enum([
          "bearer_tokens",
          "cookies",
          "credentials",
          "headers",
          "lease_proofs",
          "network_topology",
          "raw_payloads",
          "screenshots",
          "sdp_ice",
          "secrets",
          "serial_edid",
          "stack_traces",
          "target_contents",
        ]),
      )
      .min(1),
    always: z.literal(true),
  })
  .strict();

export const acceptanceStorySchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Story IDs must be lowercase kebab-case",
      ),
    title: z.string().min(1),
    requirements: z
      .array(z.string().regex(/^(?:branch|contract):[a-z0-9]+(?:-[a-z0-9]+)*$/))
      .min(1),
    tools: z.array(z.enum(JETKVM_TOOL_NAMES)).min(1),
    environments: z.array(z.enum(["fake", "replay", "live"])).min(1),
    preconditions: z.array(storyConditionSchema).min(1),
    fault_script: z.array(faultStepSchema).min(1),
    steps: z.array(storyStepSchema).min(1),
    pass: z.array(storyAssertionSchema).min(1),
    evidence: z.array(evidenceFieldSchema).min(1),
    restore: z.array(restoreStepSchema).min(1),
    privacy: z.array(privacyRuleSchema).min(1),
  })
  .strict();

export type AcceptanceStory = z.infer<typeof acceptanceStorySchema>;

const BEHAVIOR_REQUIREMENT_LOOKUP: Readonly<Record<string, true>> =
  Object.freeze(
    Object.fromEntries(
      BEHAVIOR_REQUIREMENT_IDS.map((requirement) => [requirement, true]),
    ) as Record<string, true>,
  );

const REQUIRED_RESTORE_IDS = [
  "release-input",
  "stop-paste",
  "zero-held-input",
  "close-story-session",
  "reset-fixture",
] as const;

const REQUIRED_PRIVACY_PROHIBITIONS = [
  "bearer_tokens",
  "cookies",
  "credentials",
  "headers",
  "lease_proofs",
  "network_topology",
  "raw_payloads",
  "screenshots",
  "sdp_ice",
  "secrets",
  "serial_edid",
  "stack_traces",
  "target_contents",
] as const;

const REQUIRED_STORY_OWNERS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "branch:per-fact-status-provenance": [CANONICAL_STORY_IDS[18]],
    "branch:edid-capability-absent": [CANONICAL_STORY_IDS[4]],
    "branch:edid-successful-empty": [CANONICAL_STORY_IDS[4]],
    "branch:edid-lower-layer-failure": [CANONICAL_STORY_IDS[19]],
    "branch:shared-device-rpc-adapter-binding": [CANONICAL_STORY_IDS[20]],
    "branch:device-rpc-adapter-replacement": [CANONICAL_STORY_IDS[20]],
    "branch:device-rpc-adapter-mid-flight-loss": [
      CANONICAL_STORY_IDS[18],
      CANONICAL_STORY_IDS[21],
    ],
    "branch:atx-gate-and-serialization": [CANONICAL_STORY_IDS[21]],
    "branch:atx-acknowledgement-semantics": [CANONICAL_STORY_IDS[21]],
    "branch:scroll-validation": [CANONICAL_STORY_IDS[5]],
  });

const PLACEHOLDER_PATTERN =
  /\b(?:deferred (?:field|implementation|requirement|step|story|work)|fill (?:this|it) later|not implemented|placeholder|tbd|todo)\b/i;
const FIXED_TOPOLOGY_OR_SECRET_PATTERN =
  /(?:https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|internal|invalid)\b|(?:bearer[_ -]?token|cookie|credential|password|secret)\s*[=:]\s*\S+)/i;
const MODEL_VISIBLE_SECRET_FIELD_PATTERN =
  /"(?:bearer_token|cookie|cookies|credential|credentials|password|secret|token|url)"\s*:/i;

function assertUniqueIds(story: AcceptanceStory): void {
  const collections = [
    ["precondition", story.preconditions],
    ["fault", story.fault_script],
    ["step", story.steps],
    ["pass assertion", story.pass],
    ["evidence", story.evidence],
    ["restore", story.restore],
    ["privacy", story.privacy],
  ] as const;

  for (const [label, values] of collections) {
    const ids = values.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Story ${story.id} has a duplicate ${label} id`);
    }
  }
}

function assertCompleteReferences(story: AcceptanceStory): void {
  const tools = new Set(story.tools);
  for (const step of story.steps) {
    if (step.tool !== null && !tools.has(step.tool)) {
      throw new Error(
        `Story ${story.id} step tool ${step.tool} is absent from its tool reference list`,
      );
    }
    if (step.tool !== null && step.timeout_ms === null) {
      throw new Error(
        `Story ${story.id} tool step ${step.id} has no bounded timeout`,
      );
    }
  }

  const stepIds = new Set(story.steps.map(({ id }) => id));
  for (const fault of story.fault_script) {
    if (fault.after_step !== null && !stepIds.has(fault.after_step)) {
      throw new Error(
        `Story ${story.id} fault ${fault.id} references an unknown step`,
      );
    }
  }

  const requirements = new Set(story.requirements);
  for (const requirement of requirements) {
    if (
      requirement.startsWith("branch:") &&
      BEHAVIOR_REQUIREMENT_LOOKUP[requirement] !== true
    ) {
      throw new Error(
        `Story ${story.id} has an incomplete requirement reference: ${requirement}`,
      );
    }
    if (
      !story.pass.some((assertion) => assertion.requirement === requirement)
    ) {
      throw new Error(
        `Story ${story.id} requirement ${requirement} has no pass assertion`,
      );
    }
    if (!story.evidence.some((field) => field.requirement === requirement)) {
      throw new Error(
        `Story ${story.id} requirement ${requirement} has no evidence row`,
      );
    }
  }

  for (const reference of [...story.pass, ...story.evidence]) {
    if (!requirements.has(reference.requirement)) {
      throw new Error(
        `Story ${story.id} has a requirement reference not declared by the story`,
      );
    }
  }
}

function assertSafetyPolicy(story: AcceptanceStory): void {
  const restoreIds = new Set(story.restore.map(({ id }) => id));
  if (REQUIRED_RESTORE_IDS.some((id) => !restoreIds.has(id))) {
    throw new Error(
      `Story ${story.id} lacks the complete unconditional restore sequence`,
    );
  }
  if (
    story.id === "power-three-semantic-actions" &&
    !story.restore.some(({ id }) => id === "restore-power-baseline")
  ) {
    throw new Error(
      `Story ${story.id} lacks unconditional power-baseline restoration`,
    );
  }

  const prohibited = new Set(story.privacy.flatMap((rule) => rule.prohibited));
  if (REQUIRED_PRIVACY_PROHIBITIONS.some((field) => !prohibited.has(field))) {
    throw new Error(
      `Story ${story.id} lacks a complete unconditional privacy policy`,
    );
  }

  const serialized = JSON.stringify(story);
  if (PLACEHOLDER_PATTERN.test(serialized)) {
    throw new Error(`Story ${story.id} contains placeholder or deferred text`);
  }
  if (
    FIXED_TOPOLOGY_OR_SECRET_PATTERN.test(serialized) ||
    MODEL_VISIBLE_SECRET_FIELD_PATTERN.test(serialized)
  ) {
    throw new Error(
      `Story ${story.id} contains fixed network topology or credential/secret material`,
    );
  }
}

const READ_TOOL_LOOKUP: Readonly<Partial<Record<JetKvmToolName, true>>> =
  Object.freeze({
    jetkvm_display_capture: true,
    jetkvm_display_status: true,
    jetkvm_session_status: true,
  });
const READ_MUTATION_OUTCOME_PATTERN =
  /\b(?:not_sent|applied|device_ack_only)\b|\bunknown\b(?=\s+(?:after|at|for|with)\b)/i;

function assertReadResponseEnvelopes(
  stories: readonly AcceptanceStory[],
): void {
  for (const story of stories) {
    for (const step of story.steps) {
      if (
        step.tool !== null &&
        READ_TOOL_LOOKUP[step.tool] === true &&
        READ_MUTATION_OUTCOME_PATTERN.test(step.expect)
      ) {
        throw new Error(
          `Story ${story.id} read tool ${step.tool} step ${step.id} uses a mutation outcome in its response envelope`,
        );
      }
    }
  }
}

function assertDeclaredRequirementCallLinks(
  stories: readonly AcceptanceStory[],
  matrix: ToolBehaviorMatrix,
): void {
  const storiesById = new Map(stories.map((story) => [story.id, story]));
  const linkedRequirements = new Set<string>();
  for (const row of matrix) {
    for (const cell of Object.values(row.cells)) {
      if (cell.applicability !== "applicable") {
        continue;
      }
      const story = storiesById.get(cell.story_id);
      const step = story?.steps.find(({ id }) => id === cell.step_id);
      if (
        story?.requirements.includes(row.requirement) === true &&
        step !== undefined
      ) {
        linkedRequirements.add(`${story.id}\0${row.requirement}`);
      }
    }
  }

  for (const story of stories) {
    for (const requirement of story.requirements) {
      if (
        requirement.startsWith("branch:") &&
        !linkedRequirements.has(`${story.id}\0${requirement}`)
      ) {
        throw new Error(
          `Story ${story.id} declared requirement ${requirement} has no linked executable call`,
        );
      }
    }
  }
}

const MUTATION_TOOL_LOOKUP: Readonly<Partial<Record<JetKvmToolName, true>>> =
  Object.freeze({
    jetkvm_input_keyboard: true,
    jetkvm_input_mouse: true,
    jetkvm_input_paste: true,
    jetkvm_input_release: true,
    jetkvm_power_control: true,
    jetkvm_session_connect: true,
    jetkvm_session_reconnect: true,
  });

function assertOneShotFaultBrackets(
  stories: readonly AcceptanceStory[],
  matrix: ToolBehaviorMatrix,
): void {
  const linkedStepsByFault = new Map<string, Set<string>>();
  for (const row of matrix) {
    for (const cell of Object.values(row.cells)) {
      if (cell.applicability !== "applicable") {
        continue;
      }
      const key = `${cell.story_id}\0${cell.fault_id}`;
      const linkedSteps = linkedStepsByFault.get(key) ?? new Set<string>();
      linkedSteps.add(cell.step_id);
      linkedStepsByFault.set(key, linkedSteps);
    }
  }

  for (const story of stories) {
    const stepIndexById = new Map(
      story.steps.map((step, index) => [step.id, index]),
    );
    for (const [faultIndex, fault] of story.fault_script.entries()) {
      if (fault.id.startsWith("clear-")) {
        continue;
      }
      const clear = story.fault_script[faultIndex + 1];
      const isOneShot =
        fault.id.startsWith("arm-") ||
        /\bone-shot\b/i.test(fault.action) ||
        clear?.id.startsWith("clear-") === true;
      if (!isOneShot) {
        continue;
      }

      const anchorIndex =
        fault.after_step === null
          ? -1
          : (stepIndexById.get(fault.after_step) ?? -2);
      const call = story.steps[anchorIndex + 1];
      const linkedSteps = linkedStepsByFault.get(`${story.id}\0${fault.id}`);
      if (
        anchorIndex < -1 ||
        call === undefined ||
        clear === undefined ||
        !clear.id.startsWith("clear-") ||
        clear.boundary !== "during_cleanup" ||
        clear.after_step !== call.id ||
        (linkedSteps !== undefined &&
          (linkedSteps.size !== 1 || !linkedSteps.has(call.id)))
      ) {
        throw new Error(
          `Story ${story.id} one-shot fault ${fault.id} must bracket exactly one linked call with an immediate ordered clear`,
        );
      }
    }
  }
}

function assertPartialVerificationFaultBrackets(
  stories: readonly AcceptanceStory[],
): void {
  for (const story of stories) {
    if (!story.requirements.includes("branch:partial-verification")) {
      continue;
    }
    const stepIndexById = new Map(
      story.steps.map((step, index) => [step.id, index]),
    );
    for (const call of story.steps) {
      if (call.tool === null || MUTATION_TOOL_LOOKUP[call.tool] !== true) {
        continue;
      }
      const callIndex = stepIndexById.get(call.id)!;
      const previousStepId =
        callIndex === 0 ? null : story.steps[callIndex - 1]!.id;
      const armId = `arm-${call.id}`;
      const clearId = `clear-${call.id}`;
      const armIndex = story.fault_script.findIndex(({ id }) => id === armId);
      const arm = story.fault_script[armIndex];
      const clear = story.fault_script[armIndex + 1];
      if (
        armIndex < 0 ||
        arm === undefined ||
        arm.after_step !== previousStepId ||
        arm.boundary !== "during_verification" ||
        !/\bone-shot\b/i.test(arm.action) ||
        clear === undefined ||
        clear.id !== clearId ||
        clear.after_step !== call.id ||
        clear.boundary !== "during_cleanup"
      ) {
        throw new Error(
          `Story ${story.id} partial-verification call ${call.id} must have an exact immediate arm, call, and clear bracket`,
        );
      }
    }
  }
}

function isSameRequest(
  first: AcceptanceStory["steps"][number],
  second: AcceptanceStory["steps"][number],
): boolean {
  return (
    typeof first.input.request_id === "string" &&
    first.input.request_id === second.input.request_id &&
    first.tool === second.tool
  );
}

function isExactRequestReplay(
  first: AcceptanceStory["steps"][number],
  second: AcceptanceStory["steps"][number],
): boolean {
  return (
    isSameRequest(first, second) && isDeepStrictEqual(first.input, second.input)
  );
}

function assertClosedGenerationRecovery(
  stories: readonly AcceptanceStory[],
): void {
  const unknownClosedPattern =
    /\boutcome unknown\b|\bunknown\b.*\b(?:closed|retained)\b.*\bgate\b|\bclosed\b.*\b(?:mutation|ATX)\b.*\bgate\b/i;
  const recoveryPattern =
    /\b(?:recover|reconnect|rebind|restore|inspect|provision)\b/i;

  for (const story of stories) {
    for (const [stepIndex, step] of story.steps.entries()) {
      if (
        step.tool === null ||
        MUTATION_TOOL_LOOKUP[step.tool] !== true ||
        !unknownClosedPattern.test(step.expect)
      ) {
        continue;
      }

      let recoveryIndex = stepIndex + 1;
      const duplicate = story.steps[recoveryIndex];
      if (duplicate !== undefined && isSameRequest(step, duplicate)) {
        recoveryIndex += 1;
      }
      const recovery = story.steps[recoveryIndex];
      if (recovery === undefined) {
        continue;
      }

      const currentGeneration = step.input.session_generation;
      if (recovery.tool === null) {
        const serialized = JSON.stringify(recovery);
        const nextGeneration =
          recovery.input.next_generation ??
          recovery.input.replacement_session_generation;
        const following = story.steps[recoveryIndex + 1];
        const followingGeneration = following?.input.session_generation;
        if (
          !recoveryPattern.test(serialized) ||
          (typeof currentGeneration === "number" &&
            typeof nextGeneration === "number" &&
            nextGeneration <= currentGeneration) ||
          (typeof nextGeneration === "number" &&
            typeof followingGeneration === "number" &&
            followingGeneration !== nextGeneration)
        ) {
          throw new Error(
            `Story ${story.id} unknown or closed generation after ${step.id} must recover before a later call`,
          );
        }
        continue;
      }

      const inspection = recovery;
      const release = story.steps[recoveryIndex + 1];
      let reconnectIndex = recoveryIndex + 2;
      while (
        release !== undefined &&
        story.steps[reconnectIndex] !== undefined &&
        isExactRequestReplay(release, story.steps[reconnectIndex]!)
      ) {
        reconnectIndex += 1;
      }
      const reconnect = story.steps[reconnectIndex];
      if (
        inspection.tool === T.sessionStatus &&
        release?.tool === T.release &&
        reconnect?.tool === T.reconnect
      ) {
        const next = story.steps[reconnectIndex + 1];
        const nextGeneration = next?.input.session_generation;
        if (
          inspection.input.session_generation !== currentGeneration ||
          release.input.session_generation !== currentGeneration ||
          reconnect.input.session_generation !== currentGeneration ||
          (typeof currentGeneration === "number" &&
            typeof nextGeneration === "number" &&
            nextGeneration <= currentGeneration)
        ) {
          throw new Error(
            `Story ${story.id} unknown or closed generation after ${step.id} must recover before a later call`,
          );
        }
        continue;
      }

      const cleanup = story.fault_script.find(
        (fault) =>
          fault.boundary === "during_cleanup" &&
          fault.after_step === step.id &&
          recoveryPattern.test(`${fault.action} ${fault.expected_effect}`),
      );
      const nextGeneration = recovery.input.session_generation;
      if (
        cleanup === undefined ||
        (typeof currentGeneration === "number" &&
          typeof nextGeneration === "number" &&
          nextGeneration <= currentGeneration)
      ) {
        throw new Error(
          `Story ${story.id} unknown or closed generation after ${step.id} must recover before a later call`,
        );
      }
    }
  }
}

const PROVEN_NON_CLOSING_RELEASE_REQUIREMENT_LOOKUP: Readonly<
  Record<string, true>
> = Object.freeze({
  "branch:strict-schema-rejection": true,
  "branch:permission-denied": true,
  "branch:capability-missing": true,
  "branch:deadline-before-admission": true,
  "branch:cancellation-before-write": true,
  "branch:disconnect-before-write": true,
  "branch:stale-session-generation": true,
  "branch:duplicate-changed-digest": true,
});

function assertGenerationClosingReleaseRecovery(
  stories: readonly AcceptanceStory[],
  matrix: ToolBehaviorMatrix,
): void {
  const provenNonClosingReleaseKeys = new Set<string>();
  for (const row of matrix) {
    if (
      PROVEN_NON_CLOSING_RELEASE_REQUIREMENT_LOOKUP[row.requirement] !== true
    ) {
      continue;
    }
    const cell = row.cells[T.release];
    if (cell.applicability === "applicable") {
      provenNonClosingReleaseKeys.add(`${cell.story_id}\u0000${cell.step_id}`);
    }
  }

  for (const story of stories) {
    for (const [releaseIndex, release] of story.steps.entries()) {
      if (
        release.tool !== T.release ||
        provenNonClosingReleaseKeys.has(`${story.id}\u0000${release.id}`)
      ) {
        continue;
      }

      const closedSessionId = release.input.session_id;
      const closedGeneration = release.input.session_generation;
      if (
        typeof closedSessionId !== "string" ||
        closedSessionId.length === 0 ||
        typeof closedGeneration !== "number" ||
        !Number.isInteger(closedGeneration)
      ) {
        throw new Error(
          `Story ${story.id} generation-closing release ${release.id} must identify its exact closed session and generation`,
        );
      }

      let hasRecovery = false;
      let verifiedRecoverySuccessor = false;
      let nextTool: string | undefined;
      let nextSessionId: string | undefined;
      let nextGeneration: number | undefined;
      let nextObservationId: string | undefined;
      let restoreAtxBaseline = false;
      let connectsWithoutIncumbent = false;

      for (const later of story.steps.slice(releaseIndex + 1)) {
        if (later.tool === null) {
          const nextCase =
            typeof later.input.next_case === "string"
              ? story.steps.find(
                  (candidate) => candidate.id === later.input.next_case,
                )
              : undefined;
          const isCaseRecovery =
            nextCase !== undefined && later.input.emergency_release === true;
          const isRecovery =
            later.call.startsWith("acceptance-fixture/session/") &&
            (typeof later.input.next_tool === "string" ||
              nextCase !== undefined) &&
            later.input.closed_session_id === closedSessionId &&
            (later.input.closed_generation === undefined ||
              later.input.closed_generation === closedGeneration);
          if (!isRecovery) {
            continue;
          }

          nextTool =
            typeof later.input.next_tool === "string"
              ? later.input.next_tool
              : (nextCase?.tool ?? undefined);
          connectsWithoutIncumbent =
            nextTool === T.connect && later.input.require_no_incumbent === true;
          const inspectedRecovery =
            later.call.includes("/inspect-and-recover-for-next-tool") &&
            later.input.inspect_device_state === true &&
            later.input.emergency_release === true;
          nextSessionId =
            typeof later.input.next_session_id === "string"
              ? later.input.next_session_id
              : undefined;
          nextGeneration =
            typeof later.input.next_generation === "number" &&
            Number.isInteger(later.input.next_generation)
              ? later.input.next_generation
              : undefined;
          nextObservationId =
            typeof later.input.next_observation_id === "string"
              ? later.input.next_observation_id
              : undefined;
          restoreAtxBaseline = later.input.restore_atx_baseline === true;

          if (
            typeof nextTool !== "string" ||
            (nextTool === T.connect
              ? !connectsWithoutIncumbent
              : nextSessionId === undefined ||
                nextGeneration === undefined ||
                nextGeneration <= closedGeneration ||
                (later.input.reprove_session_ready !== true &&
                  !inspectedRecovery &&
                  !isCaseRecovery))
          ) {
            throw new Error(
              `Story ${story.id} generation-closing release ${release.id} has an incomplete explicit recovery ${later.id}`,
            );
          }
          hasRecovery = true;
          continue;
        }

        if (MUTATION_TOOL_LOOKUP[later.tool] !== true) {
          continue;
        }
        if (
          later.tool === T.release &&
          provenNonClosingReleaseKeys.has(`${story.id}\u0000${later.id}`)
        ) {
          continue;
        }
        const reusesClosedGeneration =
          later.input.session_id === closedSessionId &&
          later.input.session_generation === closedGeneration;
        if (isExactRequestReplay(release, later)) {
          continue;
        }
        if (isSameRequest(release, later) && reusesClosedGeneration) {
          continue;
        }
        if (
          !hasRecovery &&
          later.tool === T.reconnect &&
          reusesClosedGeneration
        ) {
          hasRecovery = true;
          nextSessionId = closedSessionId;
          nextGeneration = closedGeneration + 1;
          continue;
        }
        if (reusesClosedGeneration || !hasRecovery) {
          throw new Error(
            `Story ${story.id} generation-closing release ${release.id} closes ${closedSessionId} generation ${closedGeneration}; explicit recovery is required before later mutation ${later.id}`,
          );
        }

        if (!verifiedRecoverySuccessor) {
          const consumesObservation =
            later.tool === T.keyboard ||
            later.tool === T.mouse ||
            later.tool === T.paste;
          if (
            (nextTool !== undefined && later.tool !== nextTool) ||
            (later.tool === T.connect
              ? !connectsWithoutIncumbent
              : later.input.session_id !== nextSessionId ||
                later.input.session_generation !== nextGeneration) ||
            (later.tool === T.power && !restoreAtxBaseline) ||
            (consumesObservation &&
              nextObservationId !== undefined &&
              later.input.observation_id !== nextObservationId)
          ) {
            throw new Error(
              `Story ${story.id} generation-closing release ${release.id} requires explicit recovery to re-prove the exact later mutation ${later.id} successor state`,
            );
          }
          verifiedRecoverySuccessor = true;
        }
      }
    }
  }
}

function assertFixtureRecoveryTransitions(
  stories: readonly AcceptanceStory[],
): void {
  for (const story of stories) {
    for (const [recoveryIndex, recovery] of story.steps.entries()) {
      if (recovery.tool !== null) {
        continue;
      }
      const nextTool = recovery.input.next_tool;
      const nextCase = recovery.input.next_case;
      if (typeof nextTool !== "string" && typeof nextCase !== "string") {
        continue;
      }
      const nextCall = story.steps.find(
        (candidate, index) => index > recoveryIndex && candidate.tool !== null,
      );
      if (
        nextCall === undefined ||
        (typeof nextTool === "string" && nextCall.tool !== nextTool) ||
        (typeof nextCase === "string" && nextCall.id !== nextCase)
      ) {
        throw new Error(
          `Story ${story.id} fixture recovery ${recovery.id} does not reach its declared next tool call`,
        );
      }

      const nextGeneration = recovery.input.next_generation;
      const closedGeneration =
        recovery.input.closed_generation ??
        recovery.input.closed_session_generation;
      if (
        (typeof nextGeneration === "number" &&
          nextCall.input.session_generation !== nextGeneration) ||
        (typeof closedGeneration === "number" &&
          typeof nextGeneration === "number" &&
          nextGeneration <= closedGeneration)
      ) {
        throw new Error(
          `Story ${story.id} fixture recovery ${recovery.id} next tool generation is unreachable`,
        );
      }
      if (
        typeof recovery.input.next_session_id === "string" &&
        nextCall.input.session_id !== recovery.input.next_session_id
      ) {
        throw new Error(
          `Story ${story.id} fixture recovery ${recovery.id} next tool session is unreachable`,
        );
      }
      if (
        typeof recovery.input.next_observation_id === "string" &&
        nextCall.input.observation_id !== recovery.input.next_observation_id
      ) {
        throw new Error(
          `Story ${story.id} fixture recovery ${recovery.id} next tool observation is unreachable`,
        );
      }
    }

    const requiresReleaseRecovery =
      story.id === "duplicate-request-id-definitive-replay";
    const requiresOwnershipRecovery =
      requiresReleaseRecovery ||
      story.id === "reconnect-requires-new-channel-observations";
    if (!requiresOwnershipRecovery) {
      continue;
    }
    for (const [transitionIndex, transition] of story.steps.entries()) {
      if (
        story.id === "reconnect-requires-new-channel-observations" &&
        transition.tool === T.connect
      ) {
        continue;
      }
      if (
        transition.tool !== T.connect &&
        transition.tool !== T.reconnect &&
        !(requiresReleaseRecovery && transition.tool === T.release)
      ) {
        continue;
      }
      const nextCaseIndex = story.steps.findIndex(
        (candidate, index) =>
          index > transitionIndex &&
          candidate.tool !== null &&
          !isSameRequest(transition, candidate),
      );
      if (nextCaseIndex < 0) {
        continue;
      }
      const nextCase = story.steps[nextCaseIndex]!;
      const directReconnectSuccessor =
        transition.tool === T.reconnect &&
        typeof transition.input.session_generation === "number" &&
        nextCase.input.session_generation ===
          transition.input.session_generation + 1 &&
        nextCase.input.session_id === transition.input.session_id;
      const hasFixtureRecovery = story.steps
        .slice(transitionIndex + 1, nextCaseIndex)
        .some(
          (candidate) =>
            candidate.tool === null &&
            (typeof candidate.input.next_tool === "string" ||
              typeof candidate.input.next_case === "string"),
        );
      if (!directReconnectSuccessor && !hasFixtureRecovery) {
        throw new Error(
          `Story ${story.id} drained or replaced session after ${transition.id} requires explicit fixture recovery before the next tool case`,
        );
      }
    }
  }
}

interface StoryLifecycleSession {
  readonly sessionId: string;
  readonly sessionGeneration: number;
}

interface PendingStoryLifecycleTransition {
  readonly kind: "connect" | "reconnect";
  readonly stepId: string;
  readonly predecessor: StoryLifecycleSession | null;
}

const LIFECYCLE_REVIEWED_STORY_IDS: Readonly<Record<string, true>> =
  Object.freeze({
    "power-three-semantic-actions": true,
    "partial-verification-does-not-replay": true,
  });

function assertStorySessionLifecycle(
  stories: readonly AcceptanceStory[],
): void {
  const establishCall = "acceptance-fixture/session/establish-ready";
  const retireCall = "acceptance-fixture/session/retire-and-prove-no-incumbent";
  const bindCall = "acceptance-fixture/session/bind-success-result";

  for (const story of stories) {
    if (LIFECYCLE_REVIEWED_STORY_IDS[story.id] !== true) {
      continue;
    }

    let current: StoryLifecycleSession | null = null;
    let pending: PendingStoryLifecycleTransition | null = null;
    let established = false;

    for (const [stepIndex, step] of story.steps.entries()) {
      const next = story.steps[stepIndex + 1];
      const isPendingBind =
        step.tool === null &&
        step.call === bindCall &&
        pending !== null &&
        step.input.source_step === pending.stepId;
      if (pending !== null && !isPendingBind) {
        throw new Error(
          `Story ${story.id} session lifecycle ${pending.kind} ${pending.stepId} must bind its structured successful result before a later step`,
        );
      }

      if (step.tool === null && step.call === establishCall) {
        const sessionId = step.input.session_id;
        const sessionGeneration = step.input.session_generation;
        if (
          established ||
          current !== null ||
          typeof sessionId !== "string" ||
          sessionId.length === 0 ||
          typeof sessionGeneration !== "number" ||
          !Number.isInteger(sessionGeneration) ||
          sessionGeneration <= 0 ||
          step.input.session_state !== "ready"
        ) {
          throw new Error(
            `Story ${story.id} session lifecycle establish step ${step.id} must create one structured ready session`,
          );
        }
        current = { sessionId, sessionGeneration };
        established = true;
        continue;
      }

      if (step.tool === null && step.call === retireCall) {
        if (
          current === null ||
          step.input.session_id !== current.sessionId ||
          step.input.session_generation !== current.sessionGeneration ||
          step.input.retire_session !== true ||
          step.input.require_no_incumbent !== true
        ) {
          throw new Error(
            `Story ${story.id} session lifecycle retire step ${step.id} must close the exact current session and prove no incumbent`,
          );
        }
        if (
          typeof step.input.next_case === "string" &&
          next?.id !== step.input.next_case
        ) {
          throw new Error(
            `Story ${story.id} session lifecycle retire step ${step.id} does not reach its declared next connect case`,
          );
        }
        current = null;
        continue;
      }

      if (step.tool === null && step.call === bindCall) {
        if (
          pending === null ||
          step.input.source_step !== pending.stepId ||
          step.input.source_outcome !== "applied" ||
          step.input.returned_session_state !== "ready"
        ) {
          throw new Error(
            `Story ${story.id} session lifecycle bind step ${step.id} must identify one successful connect or reconnect source`,
          );
        }
        const returnedSessionId = step.input.returned_session_id;
        const returnedSessionGeneration =
          step.input.returned_session_generation;
        if (
          typeof returnedSessionId !== "string" ||
          returnedSessionId.length === 0 ||
          typeof returnedSessionGeneration !== "number" ||
          !Number.isInteger(returnedSessionGeneration) ||
          returnedSessionGeneration <= 0
        ) {
          throw new Error(
            `Story ${story.id} session lifecycle bind step ${step.id} requires an exact returned session identity and generation`,
          );
        }
        if (pending.kind === "reconnect") {
          const predecessor: StoryLifecycleSession | null = pending.predecessor;
          if (
            predecessor === null ||
            step.input.predecessor_session_id !== predecessor.sessionId ||
            step.input.predecessor_session_generation !==
              predecessor.sessionGeneration ||
            returnedSessionId !== predecessor.sessionId ||
            returnedSessionGeneration !== predecessor.sessionGeneration + 1 ||
            step.input.fresh_capture_required !== true
          ) {
            throw new Error(
              `Story ${story.id} session lifecycle reconnect ${pending.stepId} must bind the exact returned successor identity and generation`,
            );
          }
        }
        if (
          typeof step.input.next_case === "string" &&
          next?.id !== step.input.next_case
        ) {
          throw new Error(
            `Story ${story.id} session lifecycle bind step ${step.id} does not reach its declared next case`,
          );
        }
        current = {
          sessionId: returnedSessionId,
          sessionGeneration: returnedSessionGeneration,
        };
        pending = null;
        continue;
      }

      if (step.tool === T.connect) {
        if (current !== null && step.input.takeover !== true) {
          throw new Error(
            `Story ${story.id} session lifecycle connect ${step.id} cannot apply with takeover false while an incumbent session remains active`,
          );
        }
        pending = {
          kind: "connect",
          stepId: step.id,
          predecessor: current,
        };
        continue;
      }

      if (step.tool === T.reconnect) {
        if (
          current === null ||
          step.input.session_id !== current.sessionId ||
          step.input.session_generation !== current.sessionGeneration
        ) {
          throw new Error(
            `Story ${story.id} session lifecycle reconnect ${step.id} must use the current returned session identity and generation`,
          );
        }
        pending = {
          kind: "reconnect",
          stepId: step.id,
          predecessor: current,
        };
        continue;
      }

      const sessionId = step.input.session_id;
      const sessionGeneration = step.input.session_generation;
      if (
        typeof sessionId === "string" ||
        typeof sessionGeneration === "number"
      ) {
        if (
          current === null ||
          sessionId !== current.sessionId ||
          sessionGeneration !== current.sessionGeneration
        ) {
          throw new Error(
            `Story ${story.id} session lifecycle call ${step.id} uses a stale session instead of the current reconnect successor`,
          );
        }
      }
    }

    if (!established || pending !== null) {
      throw new Error(
        `Story ${story.id} session lifecycle must establish state and bind every successful connect or reconnect result`,
      );
    }
  }
}

function assertObservationReachability(
  stories: readonly AcceptanceStory[],
): void {
  const reviewedStoryIds: Readonly<Record<string, true>> = Object.freeze({
    "power-three-semantic-actions": true,
    "duplicate-request-id-definitive-replay": true,
    "partial-verification-does-not-replay": true,
    "reconnect-requires-new-channel-observations": true,
  });
  for (const story of stories) {
    if (reviewedStoryIds[story.id] !== true) {
      continue;
    }
    for (const [stepIndex, step] of story.steps.entries()) {
      if (
        step.tool !== T.keyboard &&
        step.tool !== T.mouse &&
        step.tool !== T.paste
      ) {
        continue;
      }
      if (typeof step.input.observation_id !== "string") {
        continue;
      }
      const previous = story.steps[stepIndex - 1];
      if (previous !== undefined && isSameRequest(previous, step)) {
        continue;
      }
      const followsCapture = previous?.tool === T.capture;
      const followsFixtureCapture =
        previous?.tool === null &&
        previous.input.capture_fresh_observation === true &&
        previous.input.next_observation_id === step.input.observation_id;
      if (!followsCapture && !followsFixtureCapture) {
        throw new Error(
          `Story ${story.id} observation-consuming call ${step.id} requires an immediate fresh capture`,
        );
      }
    }
  }
}

function assertAtxBindingLossCases(stories: readonly AcceptanceStory[]): void {
  for (const story of stories) {
    const stepIndexById = new Map(
      story.steps.map((step, index) => [step.id, index]),
    );
    for (const fault of story.fault_script) {
      if (!/^atx-(?:prewrite|midflight)-binding-loss$/.test(fault.id)) {
        continue;
      }
      const anchorIndex =
        fault.after_step === null
          ? -1
          : (stepIndexById.get(fault.after_step) ?? -2);
      const call = story.steps[anchorIndex + 1];
      const duplicate = story.steps[anchorIndex + 2];
      const recovery = story.steps[anchorIndex + 3];
      const recoveryEvidence =
        recovery === undefined ? "" : JSON.stringify(recovery);
      if (
        anchorIndex < -1 ||
        call?.tool !== T.power ||
        duplicate === undefined ||
        !isSameRequest(call, duplicate) ||
        recovery?.tool !== null ||
        !/\b(?:recover|reconnect|restore)\b/i.test(recoveryEvidence) ||
        !/\bbaseline\b/i.test(recoveryEvidence)
      ) {
        throw new Error(
          `Story ${story.id} ATX binding-loss fault ${fault.id} must bracket one call, its exact duplicate proof, and ordered recovery`,
        );
      }
    }
  }
}

function assertReviewedPowerOutcomes(
  stories: readonly AcceptanceStory[],
): void {
  const story = stories.find(
    ({ id }) => id === "reconnect-requires-new-channel-observations",
  );
  if (story === undefined) {
    return;
  }
  for (const step of story.steps) {
    if (
      step.tool === T.power &&
      (!/\b(?:applied|not_sent|unknown)\b/i.test(step.expect) ||
        !/\b(?:device_ack_only|verification none)\b/i.test(step.expect))
    ) {
      throw new Error(
        `Story ${story.id} power call ${step.id} requires an exact outcome and verification envelope`,
      );
    }
  }
}

function assertAtxInterCaseRestoration(
  stories: readonly AcceptanceStory[],
): void {
  const baselinePattern = /\bbaseline\b/i;
  const restoreProofPattern = /\b(?:restore|prove|reproof)\w*\b/i;
  const mayHaveWrittenAtxPattern =
    /\b(?:applied|already_applied|unknown)\b|\b(?:serial|ATX)\b.*\b(?:write|receipt|sequence)\b/i;

  for (const story of stories) {
    for (const [stepIndex, step] of story.steps.entries()) {
      if (
        step.tool !== T.power ||
        !mayHaveWrittenAtxPattern.test(step.expect)
      ) {
        continue;
      }
      const nextToolIndex = story.steps.findIndex(
        (candidate, index) => index > stepIndex && candidate.tool !== null,
      );
      if (nextToolIndex < 0) {
        continue;
      }
      const nextToolStep = story.steps[nextToolIndex]!;
      if (isSameRequest(step, nextToolStep)) {
        continue;
      }

      const immediateRecovery = story.steps[stepIndex + 1];
      const serializedRecovery =
        immediateRecovery === undefined
          ? ""
          : JSON.stringify(immediateRecovery);
      const hasStepProof =
        immediateRecovery?.tool === null &&
        (/\/atx\/|restore-atx/i.test(immediateRecovery.call) ||
          immediateRecovery.input.restore_atx_baseline === true) &&
        baselinePattern.test(serializedRecovery) &&
        restoreProofPattern.test(serializedRecovery);
      const hasCleanupProof = story.fault_script.some((fault) => {
        const serialized = `${fault.action} ${fault.expected_effect}`;
        return (
          fault.boundary === "during_cleanup" &&
          fault.after_step === step.id &&
          baselinePattern.test(serialized) &&
          restoreProofPattern.test(serialized)
        );
      });
      if (!hasStepProof && !hasCleanupProof) {
        throw new Error(
          `Story ${story.id} ATX inter-case transition after ${step.id} must restore and reproof the baseline before the later call`,
        );
      }
    }
  }
}

const PER_TOOL_FAULT_EXECUTIONS = [
  {
    tools: JETKVM_TOOL_NAMES,
    storyIndex: 0,
    requirement: "branch:deadline-before-admission",
    stepPrefix: "deadline-before-admission",
    faultPrefix: "expire-before-admission",
    clearPrefix: "clear-expired-deadline",
    retryPrefix: "retry-deadline-before-admission",
    boundary: "before_admission",
  },
  {
    tools: JETKVM_TOOL_NAMES.filter(
      (tool) => tool !== T.keyboard && tool !== T.paste,
    ),
    storyIndex: 5,
    requirement: "branch:cancellation-before-write",
    stepPrefix: "cancel-before-write",
    faultPrefix: "cancel-before-write",
    clearPrefix: "clear-cancel-before-write",
    retryPrefix: "retry-cancel-before-write",
    boundary: "before_write",
  },
] as const;

function assertPerToolFaultExecution(
  stories: readonly AcceptanceStory[],
  matrix: ToolBehaviorMatrix,
): void {
  for (const execution of PER_TOOL_FAULT_EXECUTIONS) {
    const story = stories[execution.storyIndex];
    const row = matrix.find(
      ({ requirement }) => requirement === execution.requirement,
    );
    if (story === undefined || row === undefined) {
      throw new Error(
        `Per-tool fault execution is unavailable for ${execution.requirement}`,
      );
    }

    const requestIds = new Set<string>();
    for (const tool of execution.tools) {
      const slug = toolSlug(tool);
      const expectedStepId = `${execution.stepPrefix}-${slug}`;
      const expectedFaultId = `${execution.faultPrefix}-${slug}`;
      const expectedClearId = `${execution.clearPrefix}-${slug}`;
      const cell = row.cells[tool];
      if (
        cell?.applicability !== "applicable" ||
        cell.story_id !== story.id ||
        cell.step_id !== expectedStepId ||
        cell.fault_id !== expectedFaultId
      ) {
        throw new Error(
          `Applicable ${tool} ${execution.requirement} must link its compatible per-tool fault ${expectedFaultId}`,
        );
      }

      const callIndex = story.steps.findIndex(
        ({ id }) => id === expectedStepId,
      );
      const call = story.steps[callIndex];
      const faultIndex = story.fault_script.findIndex(
        ({ id }) => id === expectedFaultId,
      );
      const fault = story.fault_script[faultIndex];
      const clearIndex = story.fault_script.findIndex(
        ({ id }) => id === expectedClearId,
      );
      const clear = story.fault_script[clearIndex];
      const armAnchorIndex = story.steps.findIndex(
        ({ id }) => id === fault?.after_step,
      );
      if (
        call === undefined ||
        call.tool !== tool ||
        fault === undefined ||
        fault.boundary !== execution.boundary ||
        callIndex < 1 ||
        armAnchorIndex !== callIndex - 1
      ) {
        throw new Error(
          `Per-tool fault ${expectedFaultId} must be armed immediately before its linked call ${expectedStepId}`,
        );
      }
      if (
        clear === undefined ||
        clear.boundary !== "during_cleanup" ||
        clear.after_step !== expectedStepId ||
        clearIndex !== faultIndex + 1
      ) {
        throw new Error(
          `Per-tool fault ${expectedFaultId} must have an ordered clear ${expectedClearId} immediately after its linked call`,
        );
      }

      if (MUTATION_TOOL_LOOKUP[tool] !== true) {
        continue;
      }
      const retryId = `${execution.retryPrefix}-${slug}`;
      const retry = story.steps[callIndex + 1];
      const requestId = call.input.request_id;
      if (
        retry?.id !== retryId ||
        retry.tool !== tool ||
        JSON.stringify(retry.input) !== JSON.stringify(call.input) ||
        typeof requestId !== "string" ||
        requestId.length === 0 ||
        !/(?:applied|CONTROL_BUSY)/.test(retry.expect)
      ) {
        throw new Error(
          `Per-tool mutation reservation retry ${retryId} must immediately reuse the same normalized request after fault clear`,
        );
      }
      if (requestIds.has(requestId)) {
        throw new Error(
          `Per-tool mutation reservation retry request ID ${requestId} is reused across tools`,
        );
      }
      requestIds.add(requestId);

      if (
        tool === T.power &&
        !story.restore.some(({ id }) => id === "restore-power-baseline")
      ) {
        throw new Error(
          `Story ${story.id} must restore the power baseline after the cleared-fault power retry`,
        );
      }
    }
  }
}

function assertConnectDeadlineReservationExecution(
  stories: readonly AcceptanceStory[],
): void {
  const story = stories[0];
  if (story?.id !== "session-connect-without-takeover-busy") {
    throw new Error(
      "Canonical story 1 is unavailable for deadline reservation validation",
    );
  }

  const deadline = story.steps.find(
    ({ id }) => id === "deadline-before-admission",
  );
  const retry = story.steps.find(
    ({ id }) => id === "retry-expired-connect-request",
  );
  const clearFault = story.fault_script.find(
    ({ id }) => id === "clear-expired-deadline",
  );
  if (
    deadline === undefined ||
    retry === undefined ||
    clearFault === undefined ||
    deadline.tool !== "jetkvm_session_connect" ||
    retry.tool !== "jetkvm_session_connect" ||
    JSON.stringify(retry.input) !== JSON.stringify(deadline.input) ||
    !/CONTROL_BUSY/.test(retry.expect) ||
    clearFault.after_step !== deadline.id
  ) {
    throw new Error(
      "Story 1 deadline reservation release must clear the deadline fault and retry the same normalized connect request to ordinary CONTROL_BUSY handling",
    );
  }
}

function assertScrollObservationExecution(
  stories: readonly AcceptanceStory[],
): void {
  const story = stories[5];
  if (story?.id !== "mouse-observation-fence-and-single-use") {
    throw new Error("Canonical story 6 is unavailable for scroll validation");
  }

  const stepById = new Map(story.steps.map((step) => [step.id, step]));
  const orderedIds = [
    "capture-negative-scroll-observation",
    "scroll-negative-bound",
    "reuse-consumed-negative-observation",
    "capture-positive-scroll-observation",
    "scroll-positive-bound",
  ] as const;
  const positions = orderedIds.map((id) =>
    story.steps.findIndex((step) => step.id === id),
  );
  if (
    positions.some((position) => position < 0) ||
    positions.some(
      (position, index) => index > 0 && position <= positions[index - 1]!,
    )
  ) {
    throw new Error(
      "Story 6 must capture a fresh observation before each accepted scroll bound and then exercise consumed-observation reuse",
    );
  }

  const negative = stepById.get("scroll-negative-bound")!;
  const positive = stepById.get("scroll-positive-bound")!;
  const consumed = stepById.get("reuse-consumed-negative-observation")!;
  const negativeObservation = negative.input.observation_id;
  const positiveObservation = positive.input.observation_id;
  if (
    typeof negativeObservation !== "string" ||
    typeof positiveObservation !== "string" ||
    negativeObservation === positiveObservation
  ) {
    throw new Error(
      "Story 6 accepted scroll bounds must each use a fresh observation",
    );
  }
  if (
    consumed.input.observation_id !== negativeObservation ||
    consumed.tool !== "jetkvm_input_mouse" ||
    !/OBSERVATION_CONSUMED/.test(consumed.expect)
  ) {
    throw new Error(
      "Story 6 must prove consumed-observation reuse fails before input",
    );
  }

  const cancellation = stepById.get("cancel-before-write");
  const cancellationRetry = stepById.get("retry-cancelled-reservation");
  if (
    cancellation === undefined ||
    cancellationRetry === undefined ||
    cancellationRetry.tool !== "jetkvm_input_mouse" ||
    JSON.stringify(cancellationRetry.input) !==
      JSON.stringify(cancellation.input) ||
    !/applied.*one downstream write/i.test(cancellationRetry.expect)
  ) {
    throw new Error(
      "Story 6 must prove cancellation reservation release by retrying the same normalized mouse request",
    );
  }

  const observationCases = [
    {
      captureId: "capture-foreign-observation",
      stepId: "reject-foreign-observation",
      observationId: "opaque-observation-foreign",
      expected: /STALE_OBSERVATION.*zero downstream writes/i,
    },
    {
      captureId: "capture-stale-age-observation",
      stepId: "reject-stale-age-observation",
      observationId: "opaque-observation-stale-age",
      expected: /STALE_OBSERVATION.*zero downstream writes/i,
    },
    {
      captureId: "capture-consumed-observation",
      stepId: "reuse-consumed-observation",
      observationId: "opaque-observation-consumed",
      expected: /OBSERVATION_CONSUMED.*zero downstream writes/i,
    },
    {
      captureId: "capture-display-before-observation",
      stepId: "reject-display-change-before-dispatch",
      observationId: "opaque-observation-display-before",
      expected: /DISPLAY_CHANGED.*zero downstream writes/i,
    },
    {
      captureId: "capture-display-after-observation",
      stepId: "display-change-after-first-dispatch",
      observationId: "opaque-observation-display-after",
      expected:
        /outcome unknown.*dispatched_action_count 2.*completed_action_count 1.*suppressed/i,
    },
  ] as const;
  const observationIds = new Set<string>();
  for (const observationCase of observationCases) {
    const capture = stepById.get(observationCase.captureId);
    const step = stepById.get(observationCase.stepId);
    if (
      capture?.tool !== "jetkvm_display_capture" ||
      step?.tool !== "jetkvm_input_mouse" ||
      step.input.observation_id !== observationCase.observationId ||
      !observationCase.expected.test(step.expect) ||
      story.steps.indexOf(capture) >= story.steps.indexOf(step) ||
      observationIds.has(observationCase.observationId)
    ) {
      throw new Error(
        `Story 6 observation fence ${observationCase.stepId} must use its own fresh observation and observable downstream-write expectation`,
      );
    }
    observationIds.add(observationCase.observationId);
  }

  const consumedOnce = stepById.get("consume-observation");
  if (
    consumedOnce?.tool !== "jetkvm_input_mouse" ||
    consumedOnce.input.observation_id !== "opaque-observation-consumed" ||
    story.steps.indexOf(consumedOnce) >=
      story.steps.findIndex(({ id }) => id === "reuse-consumed-observation")
  ) {
    throw new Error(
      "Story 6 consumed-observation fence must first consume a fresh observation exactly once",
    );
  }

  const requiredFaults = [
    ["clear-cancel-before-write", "cancel-before-write"],
    ["foreign-observation-session-fence", "capture-foreign-observation"],
    ["age-observation-past-maximum", "capture-stale-age-observation"],
    ["consume-observation-once", "capture-consumed-observation"],
    ["change-display-before-dispatch", "capture-display-before-observation"],
    [
      "change-display-after-first-dispatch",
      "capture-display-after-observation",
    ],
  ] as const;
  for (const [faultId, afterStep] of requiredFaults) {
    const fault = story.fault_script.find(({ id }) => id === faultId);
    if (fault?.after_step !== afterStep) {
      throw new Error(
        `Story 6 observation fence requires exact fault ${faultId} after ${afterStep}`,
      );
    }
  }
}

function assertPartialMultiEventFaultExecution(
  stories: readonly AcceptanceStory[],
  matrix: ToolBehaviorMatrix,
): void {
  const row = matrix.find(
    ({ requirement }) => requirement === "branch:partial-multi-event-dispatch",
  );
  if (row === undefined) {
    throw new Error("Partial multi-event dispatch matrix row is unavailable");
  }
  const storiesById = new Map(stories.map((story) => [story.id, story]));
  for (const [tool, cell] of Object.entries(row.cells)) {
    if (cell.applicability !== "applicable") {
      continue;
    }
    const story = storiesById.get(cell.story_id);
    const callIndex =
      story?.steps.findIndex(({ id }) => id === cell.step_id) ?? -1;
    const call = story?.steps[callIndex];
    const fault = story?.fault_script.find(({ id }) => id === cell.fault_id);
    const anchorIndex =
      fault?.after_step === null
        ? -1
        : (story?.steps.findIndex(({ id }) => id === fault?.after_step) ?? -2);
    if (
      story === undefined ||
      call === undefined ||
      call.tool !== tool ||
      fault === undefined ||
      fault.boundary !== "after_write" ||
      anchorIndex !== callIndex - 1
    ) {
      throw new Error(
        `Partial multi-event ${tool} fault must be armed immediately before its linked call`,
      );
    }
  }
}

function assertBehaviorMatrix(
  stories: readonly AcceptanceStory[],
  matrix: ToolBehaviorMatrix,
): void {
  if (
    matrix.length !== BEHAVIOR_REQUIREMENT_IDS.length ||
    matrix.some(
      (row, index) => row.requirement !== BEHAVIOR_REQUIREMENT_IDS[index],
    )
  ) {
    throw new Error(
      "Behavior matrix must contain the exact 32 requirement rows in specification order",
    );
  }

  const storiesById = new Map(stories.map((story) => [story.id, story]));
  for (const row of matrix) {
    const cellKeys = Object.keys(row.cells);
    const extraCell = cellKeys.find(
      (key) => !JETKVM_TOOL_NAMES.includes(key as JetKvmToolName),
    );
    if (extraCell !== undefined) {
      throw new Error(
        `Behavior matrix row ${row.requirement} has unknown tool cell ${extraCell}`,
      );
    }

    let applicableCount = 0;
    for (const tool of JETKVM_TOOL_NAMES) {
      if (!Object.hasOwn(row.cells, tool)) {
        throw new Error(
          `Missing behavior matrix cell for ${tool} in ${row.requirement}`,
        );
      }
      const cell = row.cells[tool];
      if (cell === undefined) {
        throw new Error(
          `Missing behavior matrix cell for ${tool} in ${row.requirement}`,
        );
      }

      if (cell.applicability === "not_applicable") {
        const prefix = `Reviewed for ${tool}: `;
        if (
          !cell.rationale.startsWith(prefix) ||
          cell.rationale.slice(prefix.length).trim().length < 24
        ) {
          throw new Error(
            `Missing reviewed rationale for ${tool} in ${row.requirement}`,
          );
        }
        continue;
      }

      applicableCount += 1;
      const story = storiesById.get(cell.story_id);
      const step = story?.steps.find(({ id }) => id === cell.step_id);
      const fault = story?.fault_script.find(({ id }) => id === cell.fault_id);
      const assertion = story?.pass.find(({ id }) => id === cell.assertion_id);
      if (
        story === undefined ||
        step === undefined ||
        fault === undefined ||
        assertion === undefined
      ) {
        throw new Error(
          `Applicable ${tool} ${row.requirement} coverage must link an executable call, fault boundary, and pass assertion`,
        );
      }
      const coverageScope = (
        cell as ApplicableBehaviorCell & { coverage_scope?: unknown }
      ).coverage_scope;
      if (coverageScope !== "tool" && coverageScope !== "shared_transport") {
        throw new Error(
          `Applicable ${tool} ${row.requirement} coverage requires an explicit tool or shared transport coverage scope`,
        );
      }
      if (coverageScope === "tool" && step.tool !== tool) {
        throw new Error(
          `Applicable ${tool} ${row.requirement} linked step tool ${String(step.tool)} is cross-tool coverage`,
        );
      }
      if (
        coverageScope === "shared_transport" &&
        (step.tool !== null ||
          (row.requirement !== "branch:sse-route-security" &&
            row.requirement !== "branch:sse-routing-close"))
      ) {
        throw new Error(
          `Applicable ${tool} ${row.requirement} shared transport coverage is permitted only for a null-tool SSE assertion`,
        );
      }
      const expectedOwnerPhase = focusedAssertionOwnerPhase(
        tool,
        coverageScope,
      );
      if (
        cell.focused_assertion_phase_2_status !== "reserved" ||
        cell.focused_assertion_owner_phase !== expectedOwnerPhase
      ) {
        throw new Error(
          `Applicable ${tool} ${row.requirement} requires a Phase 2 reserved focused assertion owned by ${expectedOwnerPhase}`,
        );
      }
      const expectedFocusedAssertionId = focusedAssertionId(
        tool,
        row.requirement,
        coverageScope,
      );
      if (cell.focused_assertion_id !== expectedFocusedAssertionId) {
        throw new Error(
          `Applicable ${tool} ${row.requirement} requires focused unit/adapter assertion ID ${expectedFocusedAssertionId}`,
        );
      }
      if (
        !story.requirements.includes(row.requirement) ||
        assertion.requirement !== row.requirement
      ) {
        throw new Error(
          `Applicable ${tool} ${row.requirement} pass assertion is not declared by linked story ${story.id}`,
        );
      }
    }

    if (applicableCount === 0) {
      throw new Error(
        `Behavior matrix row ${row.requirement} has no executable applicable cell`,
      );
    }
  }
}

export function validateAcceptanceStories(
  values: readonly unknown[],
  matrix: ToolBehaviorMatrix = TOOL_BEHAVIOR_MATRIX,
): AcceptanceStory[] {
  const stories = values.map((value) => acceptanceStorySchema.parse(value));
  const actualIds = stories.map(({ id }) => id);

  if (actualIds.some((id) => id !== id.toLowerCase())) {
    throw new Error("Acceptance story IDs must be lowercase");
  }
  if (
    actualIds.length !== CANONICAL_STORY_IDS.length ||
    actualIds.some((id, index) => id !== CANONICAL_STORY_IDS[index])
  ) {
    throw new Error(
      "Manifest must contain the exact canonical story IDs once, in canonical order",
    );
  }

  for (const story of stories) {
    assertUniqueIds(story);
    assertCompleteReferences(story);
    assertSafetyPolicy(story);
  }

  const mappedByRequirement: Record<string, string[]> = Object.fromEntries(
    BEHAVIOR_REQUIREMENT_IDS.map((requirement) => [requirement, []]),
  );
  for (const story of stories) {
    for (const requirement of story.requirements) {
      if (requirement.startsWith("branch:")) {
        mappedByRequirement[requirement]!.push(story.id);
      }
    }
  }

  const unmapped = BEHAVIOR_REQUIREMENT_IDS.filter(
    (requirement) => mappedByRequirement[requirement]!.length === 0,
  );
  if (unmapped.length > 0) {
    throw new Error(
      `Manifest has unmapped behavior requirement rows: ${unmapped.join(", ")}`,
    );
  }

  for (const [requirement, expectedOwners] of Object.entries(
    REQUIRED_STORY_OWNERS,
  )) {
    const actualOwners = mappedByRequirement[requirement] ?? [];
    if (
      actualOwners.length !== expectedOwners.length ||
      actualOwners.some((owner, index) => owner !== expectedOwners[index])
    ) {
      throw new Error(
        `Manifest story ownership for ${requirement} must be ${expectedOwners.join(", ")}`,
      );
    }
  }

  const referencedTools = new Set(stories.flatMap(({ tools }) => tools));
  if (JETKVM_TOOL_NAMES.some((tool) => !referencedTools.has(tool))) {
    throw new Error(
      "Manifest does not contain a complete exact-ten tool reference inventory",
    );
  }
  assertConnectDeadlineReservationExecution(stories);
  assertScrollObservationExecution(stories);
  assertPartialMultiEventFaultExecution(stories, matrix);
  assertPerToolFaultExecution(stories, matrix);
  assertBehaviorMatrix(stories, matrix);
  assertDeclaredRequirementCallLinks(stories, matrix);
  assertReadResponseEnvelopes(stories);
  assertOneShotFaultBrackets(stories, matrix);
  assertPartialVerificationFaultBrackets(stories);
  assertAtxBindingLossCases(stories);
  assertGenerationClosingReleaseRecovery(stories, matrix);
  assertClosedGenerationRecovery(stories);
  assertFixtureRecoveryTransitions(stories);
  assertStorySessionLifecycle(stories);
  assertObservationReachability(stories);
  assertReviewedPowerOutcomes(stories);
  assertAtxInterCaseRestoration(stories);

  return stories;
}

export async function loadAcceptanceStories(
  directory: string,
): Promise<AcceptanceStory[]> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(({ name }) => name)
    .sort();
  const expectedFiles = CANONICAL_STORY_IDS.map(
    (id, index) => `${String(index + 1).padStart(2, "0")}-${id}.json`,
  );

  if (
    entries.length !== expectedFiles.length ||
    entries.some((name, index) => name !== expectedFiles[index])
  ) {
    throw new Error(
      "Story directory must contain exactly the 24 canonical numbered JSON files",
    );
  }

  const parsed = await Promise.all(
    entries.map(
      async (name) =>
        JSON.parse(await readFile(resolve(directory, name), "utf8")) as unknown,
    ),
  );
  return validateAcceptanceStories(parsed);
}
