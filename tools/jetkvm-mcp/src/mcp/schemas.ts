import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

import {
  CAPABILITY_NAMES,
  JETKVM_TOOL_NAMES,
  PERMISSION_NAMES,
  PHYSICAL_KEYS,
  type JetKvmToolName,
} from "../domain.ts";
import {
  ERROR_CODES,
  ERROR_PHASES,
  type ErrorCode,
  type ErrorPhase,
  type RequiredNextStep,
} from "../errors.ts";

const MAX_JSON_INTEGER = Number.MAX_SAFE_INTEGER;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const opaqueIdSchema = z.string().regex(OPAQUE_ID_PATTERN);
const nonNegativeIntegerSchema = z.number().int().min(0).max(MAX_JSON_INTEGER);
const positiveIntegerSchema = z.number().int().min(1).max(MAX_JSON_INTEGER);
const nonNegativeDimensionSchema = nonNegativeIntegerSchema;
const timestampSchema = z.string().min(1);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const permissionSchema = z.enum(PERMISSION_NAMES);
const capabilityNameSchema = z.enum(CAPABILITY_NAMES);
const toolNameSchema = z.enum(JETKVM_TOOL_NAMES);
const errorPhaseSchema = z.enum(ERROR_PHASES);

const capabilityShape = Object.fromEntries(
  CAPABILITY_NAMES.map((name) => [name, z.boolean()]),
) as Record<(typeof CAPABILITY_NAMES)[number], z.ZodBoolean>;
export const capabilitySnapshotSchema = z.object(capabilityShape).strict();

const definitiveMutationShape = {
  request_id: opaqueIdSchema,
  outcome: z.enum(["applied", "already_applied"]),
  verification: z.enum(["device_state_verified", "device_ack_only"]),
  safe_to_retry: z.literal(false),
  required_next_step: z.literal("none"),
} as const;
const notSentMutationShape = {
  request_id: opaqueIdSchema,
  outcome: z.literal("not_sent"),
  verification: z.literal("none"),
  safe_to_retry: z.boolean(),
  required_next_step: z.enum([
    "none",
    "capture_then_retry",
    "reconnect_then_capture",
    "wait_or_request_takeover",
    "grant_permission",
    "enable_capability",
  ]),
} as const;
const unknownMutationShape = {
  request_id: opaqueIdSchema,
  outcome: z.literal("unknown"),
  verification: z.literal("none"),
  safe_to_retry: z.literal(false),
  required_next_step: z.enum([
    "release_then_reconnect_then_capture",
    "inspect_device_state_before_retry",
  ]),
} as const;

export const mutationStateSchema = z.union([
  z.object(definitiveMutationShape).strict(),
  z.object(notSentMutationShape).strict(),
  z.object(unknownMutationShape).strict(),
]);

const errorDetailsShape = {
  permission: permissionSchema.nullable(),
  capability: capabilityNameSchema.nullable(),
  failed_action_index: nonNegativeIntegerSchema.nullable(),
  dispatched_action_count: nonNegativeIntegerSchema.nullable(),
  completed_action_count: nonNegativeIntegerSchema.nullable(),
  downstream_stage: z.enum([
    "none",
    "admission",
    "write",
    "acknowledgement",
    "verification",
  ]),
  expected_generation: nonNegativeIntegerSchema.nullable(),
  actual_generation: nonNegativeIntegerSchema.nullable(),
  observation_id: opaqueIdSchema.nullable(),
} as const;
const commonErrorShape = {
  message: z.string().min(1).max(512),
  phase: errorPhaseSchema,
} as const;
const zeroActionCountSchema = z.union([z.null(), z.literal(0)]);

type ReadErrorPolicy = {
  readonly codes: readonly ErrorCode[];
  readonly phase: ErrorPhase;
  readonly phases?: readonly ErrorPhase[];
  readonly safeToRetry: boolean;
  readonly requiredNextStep: RequiredNextStep;
  readonly downstreamStage:
    | "none"
    | "admission"
    | "write"
    | "acknowledgement"
    | "verification";
  readonly downstreamStages?: readonly (
    | "none"
    | "admission"
    | "write"
    | "acknowledgement"
    | "verification"
  )[];
};

const READ_ERROR_POLICIES: readonly ReadErrorPolicy[] = [
  {
    codes: ["CONFIG_INVALID"],
    phase: "validate",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "none",
  },
  {
    codes: [
      "AUTH_FAILED",
      "AUTH_EXPIRED",
      "UNSUPPORTED_UI_VERSION",
      "FIRMWARE_INCOMPATIBLE",
      "BROWSER_UNSUPPORTED",
    ],
    phase: "connect",
    phases: ["authorize", "connect"],
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "admission",
    downstreamStages: ["none", "admission"],
  },
  {
    codes: ["AUTH_RATE_LIMITED"],
    phase: "connect",
    phases: ["authorize", "connect"],
    safeToRetry: true,
    requiredNextStep: "none",
    downstreamStage: "admission",
    downstreamStages: ["none", "admission"],
  },
  {
    codes: ["OBSERVE_ONLY", "SAFETY_DENIED"],
    phase: "authorize",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "none",
  },
  {
    codes: ["SESSION_NOT_FOUND", "STALE_SESSION_GENERATION"],
    phase: "validate",
    safeToRetry: false,
    requiredNextStep: "reconnect_then_capture",
    downstreamStage: "admission",
    downstreamStages: ["none", "admission"],
  },
  {
    codes: ["SESSION_TAKEN_OVER", "SESSION_DRAINED"],
    phase: "execute",
    phases: ["validate", "connect", "execute"],
    safeToRetry: false,
    requiredNextStep: "reconnect_then_capture",
    downstreamStage: "admission",
    downstreamStages: ["none", "admission", "write"],
  },
  {
    codes: ["DEVICE_UNREACHABLE"],
    phase: "connect",
    phases: ["connect", "execute"],
    safeToRetry: true,
    requiredNextStep: "reconnect_then_capture",
    downstreamStage: "admission",
    downstreamStages: ["none", "admission", "write"],
  },
  {
    codes: ["CONNECTION_LOST"],
    phase: "execute",
    phases: ["connect", "execute", "verify", "cleanup"],
    safeToRetry: true,
    requiredNextStep: "reconnect_then_capture",
    downstreamStage: "acknowledgement",
    downstreamStages: [
      "none",
      "admission",
      "write",
      "acknowledgement",
      "verification",
    ],
  },
  {
    codes: ["DOWNSTREAM_MALFORMED_RESPONSE"],
    phase: "execute",
    phases: ["connect", "execute", "verify", "cleanup"],
    safeToRetry: false,
    requiredNextStep: "reconnect_then_capture",
    downstreamStage: "acknowledgement",
    downstreamStages: [
      "none",
      "admission",
      "write",
      "acknowledgement",
      "verification",
    ],
  },
  {
    codes: ["CANCELLED", "DEADLINE_EXCEEDED"],
    phase: "execute",
    phases: [
      "validate",
      "authorize",
      "queue",
      "connect",
      "execute",
      "verify",
      "cleanup",
    ],
    safeToRetry: true,
    requiredNextStep: "none",
    downstreamStage: "none",
    downstreamStages: [
      "none",
      "admission",
      "write",
      "acknowledgement",
      "verification",
    ],
  },
  {
    codes: [
      "VIDEO_UNAVAILABLE",
      "VIDEO_STALLED",
      "FRAME_TIMEOUT",
      "DISPLAY_CHANGED",
    ],
    phase: "execute",
    phases: ["validate", "execute", "verify"],
    safeToRetry: true,
    requiredNextStep: "capture_then_retry",
    downstreamStage: "verification",
    downstreamStages: [
      "none",
      "admission",
      "write",
      "acknowledgement",
      "verification",
    ],
  },
  {
    codes: ["EDID_READ_FAILED", "DISPLAY_STATUS_STALE"],
    phase: "execute",
    phases: ["execute", "verify"],
    safeToRetry: true,
    requiredNextStep: "none",
    downstreamStage: "verification",
    downstreamStages: [
      "none",
      "admission",
      "write",
      "acknowledgement",
      "verification",
    ],
  },
];

const READ_PERMISSION_POLICY = {
  codes: ["PERMISSION_DENIED"],
  phase: "authorize",
  safeToRetry: false,
  requiredNextStep: "grant_permission",
  downstreamStage: "none",
} as const satisfies ReadErrorPolicy;
const READ_CAPABILITY_POLICY = {
  codes: ["CAPABILITY_MISSING"],
  phase: "validate",
  safeToRetry: false,
  requiredNextStep: "enable_capability",
  downstreamStage: "none",
} as const satisfies ReadErrorPolicy;

const readErrorDetails = (
  permission: z.ZodTypeAny,
  capability: z.ZodTypeAny,
  policy: ReadErrorPolicy,
) =>
  z
    .object({
      ...errorDetailsShape,
      permission,
      capability,
      failed_action_index: z.null(),
      dispatched_action_count: zeroActionCountSchema,
      completed_action_count: zeroActionCountSchema,
      downstream_stage:
        policy.downstreamStages === undefined
          ? z.literal(policy.downstreamStage)
          : z.enum(
              policy.downstreamStages as [
                ReadErrorPolicy["downstreamStage"],
                ...ReadErrorPolicy["downstreamStage"][],
              ],
            ),
    })
    .strict();

const readErrorPolicySchema = (
  policy: ReadErrorPolicy,
  permission: z.ZodTypeAny = z.null(),
  capability: z.ZodTypeAny = z.null(),
) =>
  z
    .object({
      ...commonErrorShape,
      code:
        policy.codes.length === 1
          ? z.literal(policy.codes[0]!)
          : z.enum(policy.codes as [ErrorCode, ...ErrorCode[]]),
      phase:
        policy.phases === undefined
          ? z.literal(policy.phase)
          : z.enum(policy.phases as [ErrorPhase, ...ErrorPhase[]]),
      outcome: z.null(),
      verification: z.literal("none"),
      safe_to_retry: z.literal(policy.safeToRetry),
      required_next_step: z.literal(policy.requiredNextStep),
      details: readErrorDetails(permission, capability, policy),
    })
    .strict();

const SHARED_READ_ERROR_CODES = [
  "CONFIG_INVALID",
  "AUTH_FAILED",
  "AUTH_RATE_LIMITED",
  "AUTH_EXPIRED",
  "OBSERVE_ONLY",
  "SAFETY_DENIED",
  "UNSUPPORTED_UI_VERSION",
  "FIRMWARE_INCOMPATIBLE",
  "BROWSER_UNSUPPORTED",
  "SESSION_NOT_FOUND",
  "STALE_SESSION_GENERATION",
  "SESSION_TAKEN_OVER",
  "SESSION_DRAINED",
  "DEVICE_UNREACHABLE",
  "CONNECTION_LOST",
  "DOWNSTREAM_MALFORMED_RESPONSE",
  "CANCELLED",
  "DEADLINE_EXCEEDED",
] as const satisfies readonly ErrorCode[];

const readErrorBody = (
  permission: z.ZodTypeAny,
  capability: z.ZodTypeAny,
  applicableCodes: readonly ErrorCode[],
) => {
  const policySchemas = READ_ERROR_POLICIES.flatMap((policy) => {
    const codes = policy.codes.filter((code) => applicableCodes.includes(code));
    return codes.length === 0
      ? []
      : [readErrorPolicySchema({ ...policy, codes })];
  });
  return z.union([
    readErrorPolicySchema(READ_PERMISSION_POLICY, permission, z.null()),
    readErrorPolicySchema(READ_CAPABILITY_POLICY, z.null(), capability),
    ...policySchemas,
  ]);
};

type MutationErrorPolicy = {
  readonly codes: readonly ErrorCode[];
  readonly phase: ErrorPhase;
  readonly phases?: readonly ErrorPhase[];
  readonly outcome: "applied" | "already_applied" | "not_sent" | "unknown";
  readonly verification: "device_state_verified" | "device_ack_only" | "none";
  readonly safeToRetry: boolean;
  readonly requiredNextStep: RequiredNextStep;
  readonly downstreamStage:
    | "none"
    | "admission"
    | "write"
    | "acknowledgement"
    | "verification";
  readonly downstreamStages?: readonly (
    | "none"
    | "admission"
    | "write"
    | "acknowledgement"
    | "verification"
  )[];
  readonly excludedTools?: readonly JetKvmToolName[];
};

const MUTATION_ERROR_POLICIES: readonly MutationErrorPolicy[] = [
  {
    codes: [
      "CONFIG_INVALID",
      "INVALID_COORDINATE",
      "INVALID_KEY",
      "UNSUPPORTED_SCROLL_AXIS",
      "ATX_EXTENSION_INACTIVE",
      "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
    ],
    phase: "validate",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "none",
  },
  {
    codes: [
      "AUTH_FAILED",
      "AUTH_EXPIRED",
      "UNSUPPORTED_UI_VERSION",
      "FIRMWARE_INCOMPATIBLE",
      "BROWSER_UNSUPPORTED",
    ],
    phase: "connect",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "admission",
  },
  {
    codes: ["AUTH_RATE_LIMITED"],
    phase: "connect",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: true,
    requiredNextStep: "none",
    downstreamStage: "admission",
  },
  {
    codes: ["OBSERVE_ONLY", "SAFETY_DENIED"],
    phase: "authorize",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "none",
  },
  {
    codes: ["SESSION_NOT_FOUND", "STALE_SESSION_GENERATION"],
    phase: "validate",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "reconnect_then_capture",
    downstreamStage: "admission",
  },
  {
    codes: ["DEVICE_UNREACHABLE"],
    phase: "connect",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: true,
    requiredNextStep: "none",
    downstreamStage: "admission",
  },
  {
    codes: ["VIDEO_UNAVAILABLE", "VIDEO_STALLED"],
    phase: "validate",
    phases: ["validate", "execute"],
    outcome: "not_sent",
    verification: "none",
    safeToRetry: true,
    requiredNextStep: "capture_then_retry",
    downstreamStage: "none",
    downstreamStages: ["none", "admission", "write"],
  },
  {
    codes: ["STALE_OBSERVATION", "OBSERVATION_CONSUMED", "DISPLAY_CHANGED"],
    phase: "validate",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: true,
    requiredNextStep: "capture_then_retry",
    downstreamStage: "none",
    downstreamStages: ["none", "admission"],
  },
  {
    codes: ["DISPLAY_CHANGED"],
    phase: "execute",
    phases: ["execute", "verify"],
    outcome: "unknown",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "release_then_reconnect_then_capture",
    downstreamStage: "write",
    downstreamStages: ["write", "acknowledgement", "verification"],
  },
  {
    codes: ["PASTE_BUSY", "ATX_BUSY"],
    phase: "queue",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: true,
    requiredNextStep: "none",
    downstreamStage: "none",
  },
  {
    codes: ["PASTE_REJECTED", "POWER_ACTION_REJECTED"],
    phase: "execute",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "none",
  },
  {
    codes: ["SESSION_TAKEN_OVER", "SESSION_DRAINED"],
    phase: "execute",
    phases: ["validate", "queue", "connect", "execute"],
    outcome: "not_sent",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "reconnect_then_capture",
    downstreamStage: "admission",
    downstreamStages: ["none", "admission", "write"],
  },
  {
    codes: ["SESSION_TAKEN_OVER", "SESSION_DRAINED"],
    phase: "execute",
    phases: ["connect", "execute", "verify", "cleanup"],
    outcome: "unknown",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "release_then_reconnect_then_capture",
    downstreamStage: "write",
    downstreamStages: ["write", "acknowledgement", "verification"],
  },
  {
    codes: ["CONNECTION_LOST"],
    phase: "execute",
    phases: ["connect", "execute"],
    outcome: "not_sent",
    verification: "none",
    safeToRetry: true,
    requiredNextStep: "reconnect_then_capture",
    downstreamStage: "write",
    downstreamStages: ["none", "admission", "write"],
    excludedTools: ["jetkvm_session_connect"],
  },
  {
    codes: ["CONNECTION_LOST"],
    phase: "connect",
    phases: ["connect", "execute"],
    outcome: "not_sent",
    verification: "none",
    safeToRetry: true,
    requiredNextStep: "none",
    downstreamStage: "admission",
    downstreamStages: ["none", "admission", "write"],
    excludedTools: [
      "jetkvm_input_keyboard",
      "jetkvm_input_mouse",
      "jetkvm_input_paste",
      "jetkvm_input_release",
      "jetkvm_power_control",
      "jetkvm_session_reconnect",
    ],
  },
  {
    codes: ["CONNECTION_LOST"],
    phase: "execute",
    phases: ["connect", "execute", "verify", "cleanup"],
    outcome: "unknown",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
    downstreamStage: "write",
    downstreamStages: ["write", "acknowledgement", "verification"],
  },
  {
    codes: ["DOWNSTREAM_MALFORMED_RESPONSE"],
    phase: "execute",
    phases: ["connect", "execute"],
    outcome: "not_sent",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "reconnect_then_capture",
    downstreamStage: "write",
    downstreamStages: ["none", "admission", "write"],
    excludedTools: ["jetkvm_session_connect"],
  },
  {
    codes: ["DOWNSTREAM_MALFORMED_RESPONSE"],
    phase: "connect",
    phases: ["connect", "execute"],
    outcome: "not_sent",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "admission",
    downstreamStages: ["none", "admission", "write"],
    excludedTools: [
      "jetkvm_input_keyboard",
      "jetkvm_input_mouse",
      "jetkvm_input_paste",
      "jetkvm_input_release",
      "jetkvm_power_control",
      "jetkvm_session_reconnect",
    ],
  },
  {
    codes: ["DOWNSTREAM_MALFORMED_RESPONSE"],
    phase: "execute",
    phases: ["connect", "execute", "verify", "cleanup"],
    outcome: "unknown",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
    downstreamStage: "write",
    downstreamStages: ["write", "acknowledgement", "verification"],
  },
  {
    codes: ["PASTE_FAILED", "PASTE_CANCELLED", "EVENT_GAP"],
    phase: "execute",
    phases: ["execute", "verify", "cleanup"],
    outcome: "unknown",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "release_then_reconnect_then_capture",
    downstreamStage: "write",
    downstreamStages: ["write", "acknowledgement", "verification"],
  },
  {
    codes: ["ATX_SERIAL_UNAVAILABLE"],
    phase: "execute",
    phases: ["connect", "execute"],
    outcome: "not_sent",
    verification: "none",
    safeToRetry: true,
    requiredNextStep: "none",
    downstreamStage: "write",
    downstreamStages: ["none", "admission", "write"],
  },
  {
    codes: ["ATX_SERIAL_UNAVAILABLE"],
    phase: "execute",
    phases: ["execute", "verify", "cleanup"],
    outcome: "unknown",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
    downstreamStage: "write",
    downstreamStages: ["write", "acknowledgement", "verification"],
  },
  {
    codes: ["CANCELLED", "DEADLINE_EXCEEDED"],
    phase: "queue",
    phases: ["queue", "connect", "execute"],
    outcome: "not_sent",
    verification: "none",
    safeToRetry: true,
    requiredNextStep: "none",
    downstreamStage: "none",
    downstreamStages: ["none", "admission", "write"],
  },
  {
    codes: ["CANCELLED", "DEADLINE_EXCEEDED"],
    phase: "execute",
    phases: ["connect", "execute", "verify", "cleanup"],
    outcome: "unknown",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
    downstreamStage: "write",
    downstreamStages: ["write", "acknowledgement", "verification"],
  },
  {
    codes: ["POWER_STATE_UNVERIFIED", "PARTIAL_VERIFICATION"],
    phase: "verify",
    outcome: "applied",
    verification: "device_ack_only",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "verification",
  },
  {
    codes: ["POWER_STATE_UNVERIFIED", "PARTIAL_VERIFICATION"],
    phase: "verify",
    outcome: "already_applied",
    verification: "device_ack_only",
    safeToRetry: false,
    requiredNextStep: "none",
    downstreamStage: "verification",
  },
  {
    codes: ["ADMISSION_CAPACITY_EXCEEDED"],
    phase: "queue",
    outcome: "not_sent",
    verification: "none",
    safeToRetry: true,
    requiredNextStep: "none",
    downstreamStage: "none",
  },
  {
    codes: ["MUTATION_OUTCOME_UNKNOWN"],
    phase: "execute",
    phases: ["connect", "execute", "verify", "cleanup"],
    outcome: "unknown",
    verification: "none",
    safeToRetry: false,
    requiredNextStep: "inspect_device_state_before_retry",
    downstreamStage: "write",
    downstreamStages: ["write", "acknowledgement", "verification"],
  },
];

const enumeratedActionCountTuple = (
  maximum: number,
  mode: "success" | "unknown_error" | "definitive_error",
) => {
  const schemas = Array.from({ length: maximum }, (_, index) => {
    const count = index + 1;
    const shape =
      mode === "unknown_error"
        ? {
            failed_action_index: z.literal(index),
            dispatched_action_count: z.literal(count),
            completed_action_count: z.literal(index),
          }
        : mode === "definitive_error"
          ? {
              failed_action_index: z.null(),
              dispatched_action_count: z.literal(count),
              completed_action_count: z.literal(count),
            }
          : {
              dispatched_action_count: z.literal(count),
              completed_action_count: z.literal(count),
            };
    return z.object(shape).passthrough();
  });
  return z.union(
    schemas as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
  );
};

const keyboardSuccessCountTuple = enumeratedActionCountTuple(64, "success");
const keyboardUnknownErrorCountTuple = enumeratedActionCountTuple(
  64,
  "unknown_error",
);
const keyboardDefinitiveErrorCountTuple = enumeratedActionCountTuple(
  64,
  "definitive_error",
);
const mouseSuccessCountTuple = enumeratedActionCountTuple(16, "success");
const mouseUnknownErrorCountTuple = enumeratedActionCountTuple(
  16,
  "unknown_error",
);
const mouseDefinitiveErrorCountTuple = enumeratedActionCountTuple(
  16,
  "definitive_error",
);

const mutationErrorDetailsObject = (
  permission: z.ZodTypeAny,
  capability: z.ZodTypeAny,
  policy: MutationErrorPolicy,
  failedActionIndex: z.ZodTypeAny,
  dispatchedActionCount: z.ZodTypeAny,
  completedActionCount: z.ZodTypeAny,
) =>
  z
    .object({
      ...errorDetailsShape,
      permission,
      capability,
      failed_action_index: failedActionIndex,
      dispatched_action_count: dispatchedActionCount,
      completed_action_count: completedActionCount,
      downstream_stage:
        policy.downstreamStages === undefined
          ? z.literal(policy.downstreamStage)
          : z.enum(
              policy.downstreamStages as [
                MutationErrorPolicy["downstreamStage"],
                ...MutationErrorPolicy["downstreamStage"][],
              ],
            ),
    })
    .strict();

const mutationErrorDetails = (
  tool: JetKvmToolName,
  permission: z.ZodTypeAny,
  capability: z.ZodTypeAny,
  policy: MutationErrorPolicy,
) => {
  if (policy.outcome === "not_sent") {
    return mutationErrorDetailsObject(
      permission,
      capability,
      policy,
      z.null(),
      zeroActionCountSchema,
      zeroActionCountSchema,
    );
  }

  const countTuple =
    tool === "jetkvm_input_keyboard"
      ? policy.outcome === "unknown"
        ? keyboardUnknownErrorCountTuple
        : keyboardDefinitiveErrorCountTuple
      : tool === "jetkvm_input_mouse"
        ? policy.outcome === "unknown"
          ? mouseUnknownErrorCountTuple
          : mouseDefinitiveErrorCountTuple
        : null;
  const base = mutationErrorDetailsObject(
    permission,
    capability,
    policy,
    errorDetailsShape.failed_action_index,
    errorDetailsShape.dispatched_action_count,
    errorDetailsShape.completed_action_count,
  );
  return countTuple === null ? base : base.and(countTuple);
};

const mutationErrorPolicySchema = (
  tool: JetKvmToolName,
  policy: MutationErrorPolicy,
  permission: z.ZodTypeAny = z.null(),
  capability: z.ZodTypeAny = z.null(),
) =>
  z
    .object({
      ...commonErrorShape,
      code:
        policy.codes.length === 1
          ? z.literal(policy.codes[0]!)
          : z.enum(policy.codes as [ErrorCode, ...ErrorCode[]]),
      phase:
        policy.phases === undefined
          ? z.literal(policy.phase)
          : z.enum(policy.phases as [ErrorPhase, ...ErrorPhase[]]),
      outcome: z.literal(policy.outcome),
      verification: z.literal(policy.verification),
      safe_to_retry: z.literal(policy.safeToRetry),
      required_next_step: z.literal(policy.requiredNextStep),
      details: mutationErrorDetails(tool, permission, capability, policy),
    })
    .strict();

const permissionMutationPolicy = {
  codes: ["PERMISSION_DENIED"],
  phase: "authorize",
  outcome: "not_sent",
  verification: "none",
  safeToRetry: false,
  requiredNextStep: "grant_permission",
  downstreamStage: "none",
} as const satisfies MutationErrorPolicy;
const capabilityMutationPolicy = {
  codes: ["CAPABILITY_MISSING"],
  phase: "validate",
  outcome: "not_sent",
  verification: "none",
  safeToRetry: false,
  requiredNextStep: "enable_capability",
  downstreamStage: "none",
} as const satisfies MutationErrorPolicy;
const controlBusyMutationPolicy = {
  codes: ["CONTROL_BUSY"],
  phase: "authorize",
  outcome: "not_sent",
  verification: "none",
  safeToRetry: true,
  requiredNextStep: "wait_or_request_takeover",
  downstreamStage: "admission",
} as const satisfies MutationErrorPolicy;

const COMMON_MUTATION_ERROR_CODES = [
  "CONFIG_INVALID",
  "AUTH_FAILED",
  "AUTH_RATE_LIMITED",
  "AUTH_EXPIRED",
  "OBSERVE_ONLY",
  "SAFETY_DENIED",
  "UNSUPPORTED_UI_VERSION",
  "FIRMWARE_INCOMPATIBLE",
  "BROWSER_UNSUPPORTED",
  "DEVICE_UNREACHABLE",
  "CONNECTION_LOST",
  "DOWNSTREAM_MALFORMED_RESPONSE",
  "CANCELLED",
  "DEADLINE_EXCEEDED",
  "ADMISSION_CAPACITY_EXCEEDED",
  "MUTATION_OUTCOME_UNKNOWN",
  "REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT",
] as const satisfies readonly ErrorCode[];
const SESSION_BOUND_MUTATION_ERROR_CODES = [
  "SESSION_NOT_FOUND",
  "STALE_SESSION_GENERATION",
  "SESSION_TAKEN_OVER",
  "SESSION_DRAINED",
] as const satisfies readonly ErrorCode[];
const OBSERVATION_MUTATION_ERROR_CODES = [
  "STALE_OBSERVATION",
  "OBSERVATION_CONSUMED",
  "DISPLAY_CHANGED",
  "VIDEO_UNAVAILABLE",
  "VIDEO_STALLED",
] as const satisfies readonly ErrorCode[];

const mutationErrorBody = (
  tool: JetKvmToolName,
  permission: z.ZodTypeAny,
  capability: z.ZodTypeAny,
  applicableCodes: readonly ErrorCode[],
) => {
  const policySchemas = MUTATION_ERROR_POLICIES.flatMap((policy) => {
    if (policy.excludedTools?.includes(tool)) return [];
    const codes = policy.codes.filter((code) => applicableCodes.includes(code));
    return codes.length === 0
      ? []
      : [mutationErrorPolicySchema(tool, { ...policy, codes })];
  });
  const branches = [
    mutationErrorPolicySchema(
      tool,
      permissionMutationPolicy,
      permission,
      z.null(),
    ),
    mutationErrorPolicySchema(
      tool,
      capabilityMutationPolicy,
      z.null(),
      capability,
    ),
    ...(applicableCodes.includes("CONTROL_BUSY")
      ? [mutationErrorPolicySchema(tool, controlBusyMutationPolicy)]
      : []),
    ...policySchemas,
  ] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
  return z.union(branches);
};

const displayCaptureErrorBodySchema = readErrorBody(
  z.literal("display.capture"),
  z.literal("display_capture"),
  [
    ...SHARED_READ_ERROR_CODES,
    "VIDEO_UNAVAILABLE",
    "VIDEO_STALLED",
    "FRAME_TIMEOUT",
    "DISPLAY_CHANGED",
  ],
);
const displayStatusErrorBodySchema = readErrorBody(
  z.literal("display.status"),
  z.literal("display_status"),
  [...SHARED_READ_ERROR_CODES, "EDID_READ_FAILED", "DISPLAY_STATUS_STALE"],
);
const sessionStatusErrorBodySchema = readErrorBody(
  z.literal("session.status"),
  z.literal("session_status"),
  SHARED_READ_ERROR_CODES,
);
const inputKeyboardErrorBodySchema = mutationErrorBody(
  "jetkvm_input_keyboard",
  z.literal("input.keyboard"),
  z.literal("keyboard"),
  [
    ...COMMON_MUTATION_ERROR_CODES,
    ...SESSION_BOUND_MUTATION_ERROR_CODES,
    ...OBSERVATION_MUTATION_ERROR_CODES,
    "INVALID_KEY",
    "PARTIAL_VERIFICATION",
  ],
);
const inputMouseErrorBodySchema = mutationErrorBody(
  "jetkvm_input_mouse",
  z.literal("input.mouse"),
  z.enum(["mouse", "absolute_pointer"]),
  [
    ...COMMON_MUTATION_ERROR_CODES,
    ...SESSION_BOUND_MUTATION_ERROR_CODES,
    ...OBSERVATION_MUTATION_ERROR_CODES,
    "INVALID_COORDINATE",
    "UNSUPPORTED_SCROLL_AXIS",
    "PARTIAL_VERIFICATION",
  ],
);
const inputPasteErrorBodySchema = mutationErrorBody(
  "jetkvm_input_paste",
  z.literal("input.paste"),
  z.literal("reliable_paste"),
  [
    ...COMMON_MUTATION_ERROR_CODES,
    ...SESSION_BOUND_MUTATION_ERROR_CODES,
    ...OBSERVATION_MUTATION_ERROR_CODES,
    "PASTE_BUSY",
    "PASTE_REJECTED",
    "PASTE_FAILED",
    "PASTE_CANCELLED",
    "EVENT_GAP",
    "PARTIAL_VERIFICATION",
  ],
);
const inputReleaseErrorBodySchema = mutationErrorBody(
  "jetkvm_input_release",
  z.literal("input.release"),
  z.literal("input_release"),
  [...COMMON_MUTATION_ERROR_CODES, ...SESSION_BOUND_MUTATION_ERROR_CODES],
);
const powerControlErrorBodySchema = mutationErrorBody(
  "jetkvm_power_control",
  z.literal("power.control"),
  z.literal("power_control"),
  [
    ...COMMON_MUTATION_ERROR_CODES,
    ...SESSION_BOUND_MUTATION_ERROR_CODES,
    "POWER_ACTION_REJECTED",
    "ATX_EXTENSION_INACTIVE",
    "ATX_SERIAL_UNAVAILABLE",
    "ATX_BUSY",
    "POWER_STATE_UNVERIFIED",
    "PARTIAL_VERIFICATION",
  ],
);
const sessionConnectErrorBodySchema = mutationErrorBody(
  "jetkvm_session_connect",
  z.enum(["session.connect", "session.takeover"]),
  z.never(),
  [...COMMON_MUTATION_ERROR_CODES, "CONTROL_BUSY"],
);
const sessionReconnectErrorBodySchema = mutationErrorBody(
  "jetkvm_session_reconnect",
  z.enum(["session.reconnect", "session.takeover"]),
  z.never(),
  [
    ...COMMON_MUTATION_ERROR_CODES,
    ...SESSION_BOUND_MUTATION_ERROR_CODES,
    "CONTROL_BUSY",
  ],
);

const toolErrorEnvelopeShape = {
  ok: z.literal(false),
  operation_id: opaqueIdSchema,
  session_id: opaqueIdSchema.nullable(),
  session_generation: nonNegativeIntegerSchema.nullable(),
  duration_ms: nonNegativeIntegerSchema,
} as const;
const errorForTool = (tool: JetKvmToolName, error: z.ZodTypeAny) =>
  z
    .object({
      ...toolErrorEnvelopeShape,
      tool: z.literal(tool),
      error,
    })
    .strict();

export const toolErrorSchema = z.union([
  errorForTool("jetkvm_display_capture", displayCaptureErrorBodySchema),
  errorForTool("jetkvm_display_status", displayStatusErrorBodySchema),
  errorForTool("jetkvm_session_status", sessionStatusErrorBodySchema),
  errorForTool("jetkvm_input_keyboard", inputKeyboardErrorBodySchema),
  errorForTool("jetkvm_input_mouse", inputMouseErrorBodySchema),
  errorForTool("jetkvm_input_paste", inputPasteErrorBodySchema),
  errorForTool("jetkvm_input_release", inputReleaseErrorBodySchema),
  errorForTool("jetkvm_power_control", powerControlErrorBodySchema),
  errorForTool("jetkvm_session_connect", sessionConnectErrorBodySchema),
  errorForTool("jetkvm_session_reconnect", sessionReconnectErrorBodySchema),
]);

export const successEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    tool: toolNameSchema,
    operation_id: opaqueIdSchema,
    session_id: opaqueIdSchema,
    session_generation: positiveIntegerSchema,
    duration_ms: nonNegativeIntegerSchema,
    result: z.unknown(),
  })
  .strict();

const sessionIdentityShape = {
  session_id: opaqueIdSchema,
  session_generation: nonNegativeIntegerSchema,
} as const;
const requestIdentityShape = {
  request_id: opaqueIdSchema,
} as const;
const observationIdentityShape = {
  observation_id: opaqueIdSchema,
} as const;
const timeout = (maximum: number) => z.number().int().min(100).max(maximum);

export const sessionConnectInputSchema = z
  .object({
    ...requestIdentityShape,
    takeover: z.boolean().default(false),
    timeout_ms: timeout(60_000),
  })
  .strict();
export const sessionStatusInputSchema = z
  .object({
    ...sessionIdentityShape,
    timeout_ms: timeout(30_000),
  })
  .strict();
export const sessionReconnectInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...requestIdentityShape,
    takeover: z.boolean().default(false),
    timeout_ms: timeout(60_000),
  })
  .strict();
export const displayCaptureInputSchema = z
  .object({
    ...sessionIdentityShape,
    format: z.enum(["jpeg", "png"]).default("jpeg"),
    max_width: z.number().int().min(64).max(1920).default(1280),
    max_height: z.number().int().min(64).max(1080).default(720),
    timeout_ms: timeout(60_000),
  })
  .strict();
export const displayStatusInputSchema = z
  .object({
    ...sessionIdentityShape,
    timeout_ms: timeout(30_000),
  })
  .strict();

const pointSchema = z
  .object({ x: nonNegativeIntegerSchema, y: nonNegativeIntegerSchema })
  .strict();
const mouseButtonSchema = z.enum(["left", "middle", "right"]);
const mouseActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("move"),
      x: nonNegativeIntegerSchema,
      y: nonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("click"),
      x: nonNegativeIntegerSchema,
      y: nonNegativeIntegerSchema,
      button: mouseButtonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("double_click"),
      x: nonNegativeIntegerSchema,
      y: nonNegativeIntegerSchema,
      button: mouseButtonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      button: mouseButtonSchema,
      path: z.array(pointSchema).min(2).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      x: nonNegativeIntegerSchema,
      y: nonNegativeIntegerSchema,
      delta_y: z
        .number()
        .int()
        .min(-127)
        .max(127)
        .refine((value) => value !== 0),
      delta_x: z.literal(0).optional(),
    })
    .strict(),
]);
export const inputMouseInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...observationIdentityShape,
    ...requestIdentityShape,
    actions: z.array(mouseActionSchema).min(1).max(16),
    timeout_ms: timeout(60_000),
  })
  .strict();

const physicalKeySchema = z.enum(PHYSICAL_KEYS);
const keyboardActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key_down"), key: physicalKeySchema }).strict(),
  z.object({ type: z.literal("key_up"), key: physicalKeySchema }).strict(),
  z.object({ type: z.literal("key_press"), key: physicalKeySchema }).strict(),
  z
    .object({
      type: z.literal("chord"),
      keys: z.array(physicalKeySchema).min(1).max(8),
    })
    .strict(),
]);
export const inputKeyboardInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...observationIdentityShape,
    ...requestIdentityShape,
    actions: z.array(keyboardActionSchema).min(1).max(64),
    timeout_ms: timeout(60_000),
  })
  .strict();
export const inputPasteInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...observationIdentityShape,
    ...requestIdentityShape,
    text: z
      .string()
      .min(1)
      .refine((value) => {
        const withoutBom = value.startsWith("\uFEFF") ? value.slice(1) : value;
        const normalized = withoutBom
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .normalize("NFC");
        const byteLength = Buffer.byteLength(normalized, "utf8");
        return byteLength >= 1 && byteLength <= 262_144;
      }),
    timeout_ms: timeout(300_000),
  })
  .strict();
export const inputReleaseInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...requestIdentityShape,
    timeout_ms: timeout(60_000),
  })
  .strict();
export const powerControlInputSchema = z
  .object({
    ...sessionIdentityShape,
    ...requestIdentityShape,
    action: z.enum(["press_power", "hold_power", "press_reset"]),
    timeout_ms: timeout(60_000),
  })
  .strict();

const observedFactSchema = <T extends z.ZodTypeAny, U extends z.ZodTypeAny>(
  valueSchema: T,
  noObservationValueSchema: U,
) =>
  z.union([
    z
      .object({
        value: valueSchema,
        observed_at: timestampSchema,
        age_ms: nonNegativeIntegerSchema,
        freshness: z.enum(["fresh", "stale"]),
        source: z.enum(["cached_snapshot", "cached_event"]),
      })
      .strict(),
    z
      .object({
        value: noObservationValueSchema,
        observed_at: z.null(),
        age_ms: z.null(),
        freshness: z.literal("unknown"),
        source: z.literal("none"),
      })
      .strict(),
  ]);

const jpegByteLengthSchema = z
  .number()
  .int()
  .min(0)
  .max(2 * 1024 * 1024);
const pngByteLengthSchema = z
  .number()
  .int()
  .min(0)
  .max(8 * 1024 * 1024);

const imageMetadataSchema = z.discriminatedUnion("mime_type", [
  z
    .object({
      content_index: z.literal(1),
      mime_type: z.literal("image/jpeg"),
      sha256: sha256Schema,
      byte_length: jpegByteLengthSchema,
    })
    .strict(),
  z
    .object({
      content_index: z.literal(1),
      mime_type: z.literal("image/png"),
      sha256: sha256Schema,
      byte_length: pngByteLengthSchema,
    })
    .strict(),
]);

const displayCaptureResultShape = {
  observation_id: opaqueIdSchema,
  connection_epoch: nonNegativeIntegerSchema,
  display_generation: nonNegativeIntegerSchema,
  frame_id: opaqueIdSchema,
  captured_at: timestampSchema,
  source_width: nonNegativeDimensionSchema,
  source_height: nonNegativeDimensionSchema,
  image_width: nonNegativeDimensionSchema,
  image_height: nonNegativeDimensionSchema,
  rotation: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270),
  ]),
  geometry: z
    .object({
      content_x: nonNegativeIntegerSchema,
      content_y: nonNegativeIntegerSchema,
      content_width: nonNegativeDimensionSchema,
      content_height: nonNegativeDimensionSchema,
    })
    .strict(),
  image: imageMetadataSchema,
} as const;
export const displayCaptureResultSchema = z
  .object(displayCaptureResultShape)
  .strict();

const signalValueSchema = z.enum([
  "present",
  "no_signal",
  "no_lock",
  "out_of_range",
  "unknown",
]);
const resolutionSchema = z
  .object({
    width: nonNegativeDimensionSchema,
    height: nonNegativeDimensionSchema,
  })
  .strict();
const nativeResolutionSchema = z
  .object({
    width: nonNegativeDimensionSchema,
    height: nonNegativeDimensionSchema,
    refresh_hz: z.number().nonnegative().finite().nullable(),
  })
  .strict();
const fpsValueSchema = z.number().nonnegative().finite().nullable();

const mutationResult = (extraShape: z.ZodRawShape) =>
  z.object({ ...definitiveMutationShape, ...extraShape }).strict();

export const sessionConnectResultSchema = mutationResult({
  state: z.literal("ready"),
  connection_epoch: nonNegativeIntegerSchema,
  display_generation: nonNegativeIntegerSchema,
  takeover_performed: z.boolean(),
  fresh_capture_required: z.literal(true),
  permissions: z.array(permissionSchema),
  capabilities: capabilitySnapshotSchema,
});
export const sessionStatusResultSchema = z
  .object({
    state: z.enum([
      "connecting",
      "ready",
      "degraded",
      "drained",
      "taken_over",
      "closing",
      "failed",
    ]),
    connection_epoch: nonNegativeIntegerSchema,
    display_generation: nonNegativeIntegerSchema,
    dispatch_generation: nonNegativeIntegerSchema,
    browser_channel_generation: nonNegativeIntegerSchema.nullable(),
    device_reachable: z.boolean().nullable(),
    setup_state: z.enum(["complete", "required", "unknown"]),
    auth_mode: z.enum(["password", "no_password", "unknown"]),
    rpc_reachability: z.enum(["reachable", "unreachable", "unknown"]),
    native_process: z.enum([
      "available",
      "unavailable",
      "restarting",
      "unknown",
    ]),
    web_rtc: z.enum([
      "connecting",
      "connected",
      "disconnected",
      "failed",
      "unknown",
    ]),
    hid: z.enum(["ready", "not_ready", "unknown"]),
    decoded_video: z.enum(["ready", "stalled", "unavailable", "unknown"]),
    native_capture_facts: z
      .object({
        signal: observedFactSchema(signalValueSchema, z.literal("unknown")),
        resolution: observedFactSchema(resolutionSchema.nullable(), z.null()),
        fps: observedFactSchema(fpsValueSchema, z.null()),
      })
      .strict(),
    active_mutation: z.boolean(),
    fresh_capture_required: z.boolean(),
    permissions: z.array(permissionSchema),
    capabilities: capabilitySnapshotSchema,
    blocked_reason: z.string().nullable(),
    versions: z
      .object({
        server: z.string(),
        protocol: z.string(),
        ui_contract: z.string().nullable(),
        firmware: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export const sessionReconnectResultSchema = z
  .object({
    ...definitiveMutationShape,
    previous_session_generation: nonNegativeIntegerSchema,
    new_session_generation: positiveIntegerSchema,
    connection_epoch: nonNegativeIntegerSchema,
    state: z.literal("ready"),
    takeover_performed: z.boolean(),
    fresh_capture_required: z.literal(true),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.new_session_generation > result.previous_session_generation) {
      return;
    }
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["new_session_generation"],
      message:
        "new_session_generation must be strictly greater than previous_session_generation.",
    });
  })
  .describe(
    "new_session_generation must be strictly greater than previous_session_generation.",
  );

const edidResultSchema = z.union([
  z
    .object({
      status: z.literal("unsupported"),
      read_completed: z.literal(false),
      reason: z.literal("edid_read_capability_absent"),
      observed_at: z.null(),
      data: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      read_completed: z.literal(true),
      reason: z.literal("successful_read_reported_no_edid"),
      observed_at: timestampSchema,
      data: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("available"),
      read_completed: z.literal(true),
      reason: z.null(),
      observed_at: timestampSchema,
      data: z
        .object({
          sha256: sha256Schema,
          manufacturer_id: z.string().nullable(),
          product_code: nonNegativeIntegerSchema.nullable(),
          serial_number: z.string().nullable(),
          display_name: z.string().nullable(),
          preferred_resolution: z
            .object({
              width: nonNegativeDimensionSchema,
              height: nonNegativeDimensionSchema,
              refresh_hz: z.number().nonnegative().finite().nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    })
    .strict(),
]);
export const displayStatusResultSchema = z
  .object({
    signal: observedFactSchema(signalValueSchema, z.literal("unknown")),
    native_resolution: observedFactSchema(
      nativeResolutionSchema.nullable(),
      z.null(),
    ),
    fps: observedFactSchema(fpsValueSchema, z.null()),
    edid: edidResultSchema,
  })
  .strict();
export const inputMouseResultSchema = mutationResult({
  dispatched_action_count: positiveIntegerSchema.max(16),
  completed_action_count: positiveIntegerSchema.max(16),
  post_capture: displayCaptureResultSchema.nullable(),
}).and(mouseSuccessCountTuple);
export const inputKeyboardResultSchema = mutationResult({
  dispatched_action_count: positiveIntegerSchema.max(64),
  completed_action_count: positiveIntegerSchema.max(64),
  held_keys: z.array(physicalKeySchema),
  post_capture: displayCaptureResultSchema.nullable(),
}).and(keyboardSuccessCountTuple);
export const inputPasteResultSchema = mutationResult({
  original_byte_count: nonNegativeIntegerSchema,
  normalized_byte_count: nonNegativeIntegerSchema,
  normalized_sha256: sha256Schema,
  accepted_at: timestampSchema,
  completed_at: timestampSchema,
  terminal_state: z.literal("succeeded"),
  measured_chars_per_second: z.number().nonnegative().finite().nullable(),
  post_capture: displayCaptureResultSchema.nullable(),
});
export const inputReleaseResultSchema = z
  .object({
    ...definitiveMutationShape,
    verification: z.literal("device_state_verified"),
    mutation_gate_closed: z.literal(true),
    deferred_producers_joined: z.literal(true),
    paste_terminal: z.enum(["cancelled", "inactive"]),
    ordinary_leases_zero: z.literal(true),
    keyboard_zero: z.literal(true),
    pointer_zero: z.literal(true),
    generation_drained: z.literal(true),
  })
  .strict();
const atxLedObservationSchema = z.union([
  z
    .object({
      power: z.boolean().nullable(),
      hdd: z.boolean().nullable(),
      observed_at: timestampSchema,
      freshness: z.enum(["fresh", "stale"]),
    })
    .strict(),
  z
    .object({
      power: z.null(),
      hdd: z.null(),
      observed_at: z.null(),
      freshness: z.literal("unknown"),
    })
    .strict(),
]);
const powerResultCommonShape = {
  ...definitiveMutationShape,
  verification: z.literal("device_ack_only"),
  serial_sequence_completed: z.literal(true),
  atx_led_observation: atxLedObservationSchema,
} as const;
export const powerControlResultSchema = z.union([
  z
    .object({
      ...powerResultCommonShape,
      action: z.literal("press_power"),
      wire_action: z.literal("power-short"),
      fixed_press_ms: z.literal(200),
    })
    .strict(),
  z
    .object({
      ...powerResultCommonShape,
      action: z.literal("hold_power"),
      wire_action: z.literal("power-long"),
      fixed_press_ms: z.literal(5000),
    })
    .strict(),
  z
    .object({
      ...powerResultCommonShape,
      action: z.literal("press_reset"),
      wire_action: z.literal("reset"),
      fixed_press_ms: z.literal(200),
    })
    .strict(),
]);

export const TOOL_INPUT_SCHEMAS = {
  jetkvm_display_capture: displayCaptureInputSchema,
  jetkvm_display_status: displayStatusInputSchema,
  jetkvm_input_keyboard: inputKeyboardInputSchema,
  jetkvm_input_mouse: inputMouseInputSchema,
  jetkvm_input_paste: inputPasteInputSchema,
  jetkvm_input_release: inputReleaseInputSchema,
  jetkvm_power_control: powerControlInputSchema,
  jetkvm_session_connect: sessionConnectInputSchema,
  jetkvm_session_reconnect: sessionReconnectInputSchema,
  jetkvm_session_status: sessionStatusInputSchema,
} satisfies Record<JetKvmToolName, z.ZodTypeAny>;

export const TOOL_RESULT_PAYLOAD_SCHEMAS = {
  jetkvm_display_capture: displayCaptureResultSchema,
  jetkvm_display_status: displayStatusResultSchema,
  jetkvm_input_keyboard: inputKeyboardResultSchema,
  jetkvm_input_mouse: inputMouseResultSchema,
  jetkvm_input_paste: inputPasteResultSchema,
  jetkvm_input_release: inputReleaseResultSchema,
  jetkvm_power_control: powerControlResultSchema,
  jetkvm_session_connect: sessionConnectResultSchema,
  jetkvm_session_reconnect: sessionReconnectResultSchema,
  jetkvm_session_status: sessionStatusResultSchema,
} satisfies Record<JetKvmToolName, z.ZodTypeAny>;

const successForTool = (tool: JetKvmToolName, result: z.ZodTypeAny) => {
  const schema = z
    .object({
      ok: z.literal(true),
      tool: z.literal(tool),
      operation_id: opaqueIdSchema,
      session_id: opaqueIdSchema,
      session_generation: positiveIntegerSchema,
      duration_ms: nonNegativeIntegerSchema,
      result,
    })
    .strict();
  if (tool !== "jetkvm_session_reconnect") return schema;
  return schema
    .superRefine((envelope, context) => {
      if (
        envelope.session_generation === envelope.result.new_session_generation
      ) {
        return;
      }
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session_generation"],
        message: "Reconnect envelope generation must equal the new generation.",
      });
    })
    .describe(
      "For reconnect success, session_generation must equal result.new_session_generation.",
    );
};

export const TOOL_RESULT_SCHEMAS = {
  jetkvm_display_capture: z.union([
    successForTool("jetkvm_display_capture", displayCaptureResultSchema),
    errorForTool("jetkvm_display_capture", displayCaptureErrorBodySchema),
  ]),
  jetkvm_display_status: z.union([
    successForTool("jetkvm_display_status", displayStatusResultSchema),
    errorForTool("jetkvm_display_status", displayStatusErrorBodySchema),
  ]),
  jetkvm_input_keyboard: z.union([
    successForTool("jetkvm_input_keyboard", inputKeyboardResultSchema),
    errorForTool("jetkvm_input_keyboard", inputKeyboardErrorBodySchema),
  ]),
  jetkvm_input_mouse: z.union([
    successForTool("jetkvm_input_mouse", inputMouseResultSchema),
    errorForTool("jetkvm_input_mouse", inputMouseErrorBodySchema),
  ]),
  jetkvm_input_paste: z.union([
    successForTool("jetkvm_input_paste", inputPasteResultSchema),
    errorForTool("jetkvm_input_paste", inputPasteErrorBodySchema),
  ]),
  jetkvm_input_release: z.union([
    successForTool("jetkvm_input_release", inputReleaseResultSchema),
    errorForTool("jetkvm_input_release", inputReleaseErrorBodySchema),
  ]),
  jetkvm_power_control: z.union([
    successForTool("jetkvm_power_control", powerControlResultSchema),
    errorForTool("jetkvm_power_control", powerControlErrorBodySchema),
  ]),
  jetkvm_session_connect: z.union([
    successForTool("jetkvm_session_connect", sessionConnectResultSchema),
    errorForTool("jetkvm_session_connect", sessionConnectErrorBodySchema),
  ]),
  jetkvm_session_reconnect: z.union([
    successForTool("jetkvm_session_reconnect", sessionReconnectResultSchema),
    errorForTool("jetkvm_session_reconnect", sessionReconnectErrorBodySchema),
  ]),
  jetkvm_session_status: z.union([
    successForTool("jetkvm_session_status", sessionStatusResultSchema),
    errorForTool("jetkvm_session_status", sessionStatusErrorBodySchema),
  ]),
} satisfies Record<JetKvmToolName, z.ZodTypeAny>;

export const SCHEMA_FILE_NAMES = JETKVM_TOOL_NAMES.flatMap((tool) => [
  `${tool}.input.schema.json`,
  `${tool}.result.schema.json`,
]).sort();

export type JsonSchemaDocument = Record<string, unknown>;

function addNonPortableConstraints(
  tool: JetKvmToolName,
  kind: "input" | "result",
  schema: JsonSchemaDocument,
): JsonSchemaDocument {
  if (tool === "jetkvm_input_paste" && kind === "input") {
    const properties = schema.properties as Record<string, JsonSchemaDocument>;
    properties.text!["x-utf8-byte-max"] = 262_144;
  }
  if (tool === "jetkvm_input_mouse" && kind === "input") {
    const serialized = JSON.stringify(schema);
    const patched = serialized.replace(
      '"minimum":-127,"maximum":127',
      '"minimum":-127,"maximum":127,"not":{"const":0}',
    );
    return JSON.parse(patched) as JsonSchemaDocument;
  }
  return schema;
}

export function generateJsonSchemaDocuments(): Record<
  string,
  JsonSchemaDocument
> {
  const documents: Record<string, JsonSchemaDocument> = {};
  for (const tool of JETKVM_TOOL_NAMES) {
    for (const [kind, schema] of [
      ["input", TOOL_INPUT_SCHEMAS[tool]],
      ["result", TOOL_RESULT_SCHEMAS[tool]],
    ] as const) {
      const generated = toJsonSchemaCompat(schema, {
        strictUnions: true,
        target: "jsonSchema7",
        pipeStrategy: kind === "input" ? "input" : "output",
      });
      const document =
        kind === "result"
          ? { ...generated, type: "object" as const }
          : generated;
      documents[`${tool}.${kind}.schema.json`] = addNonPortableConstraints(
        tool,
        kind,
        document,
      );
    }
  }
  return Object.fromEntries(
    Object.entries(documents).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export const GENERATED_JSON_SCHEMA_DOCUMENTS = generateJsonSchemaDocuments();
