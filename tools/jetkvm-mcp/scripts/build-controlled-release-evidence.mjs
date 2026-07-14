import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createExecutionEvidenceResolver,
  canonicalJson,
  sha256Canonical,
} from "./release-evidence.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function mergeControlledTraceReports(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error("Controlled trace reports are required.");
  }
  const traces = {};
  for (const report of reports) {
    if (
      !isRecord(report) ||
      report.schema_version !== 1 ||
      ![
        "execution-produced-focused-handler-calls",
        "execution-produced-protocol-calls",
      ].includes(report.evidence_source) ||
      !isRecord(report.traces)
    ) {
      throw new Error("Controlled trace report is malformed.");
    }
    for (const [identity, trace] of Object.entries(report.traces)) {
      if (Object.hasOwn(traces, identity)) {
        throw new Error(`Duplicate controlled trace ${identity}.`);
      }
      traces[identity] = trace;
    }
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(traces).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

function exactExecutionTrace(executionTraces, identity, resolverEvidence) {
  const focused = resolverEvidence.focused[identity];
  const scenario = resolverEvidence.scenarios[identity];
  let expectedTestIdentities;
  let candidates;
  if (isRecord(focused) && typeof focused.test_identity === "string") {
    expectedTestIdentities = [focused.test_identity];
    candidates = [[identity, executionTraces[identity]]];
  } else if (
    isRecord(scenario) &&
    Array.isArray(scenario.test_identities) &&
    scenario.test_identities.length > 0
  ) {
    expectedTestIdentities = scenario.test_identities;
    const expected = new Set(expectedTestIdentities);
    if (expected.size !== expectedTestIdentities.length) {
      throw new Error(
        `Controlled execution trace ${identity} lacks an exact selected test identity.`,
      );
    }
    candidates = Object.entries(executionTraces).filter(([, trace]) =>
      expected.has(trace?.test_identity),
    );
  } else {
    throw new Error(
      `Controlled execution trace ${identity} lacks an exact selected test identity.`,
    );
  }
  const actualTestIdentities = candidates.map(([, trace]) =>
    isRecord(trace) ? trace.test_identity : undefined,
  );
  if (
    candidates.length !== expectedTestIdentities.length ||
    new Set(actualTestIdentities).size !== expectedTestIdentities.length ||
    expectedTestIdentities.some(
      (testIdentity) => !actualTestIdentities.includes(testIdentity),
    )
  ) {
    throw new Error(
      `Controlled execution trace ${identity} lacks an exact selected test identity.`,
    );
  }
  if (
    candidates.some(
      ([, trace]) =>
        !isRecord(trace) ||
        typeof trace.test_identity !== "string" ||
        !Array.isArray(trace.calls) ||
        trace.calls.length === 0 ||
        trace.calls.some(
          (call) =>
            !isRecord(call) ||
            typeof call.tool !== "string" ||
            !isRecord(call.request) ||
            !isRecord(call.response) ||
            call.response.tool !== call.tool,
        ),
    )
  ) {
    throw new Error(`Controlled execution trace ${identity} is incomplete.`);
  }
  return Object.freeze({
    identity,
    sources: Object.freeze(
      candidates.map(([sourceIdentity, trace]) =>
        Object.freeze({
          identity: sourceIdentity,
          test_identity: trace.test_identity,
        }),
      ),
    ),
    calls: Object.freeze(
      candidates.flatMap(([sourceIdentity, trace]) =>
        trace.calls.map((call) =>
          Object.freeze({
            source_identity: sourceIdentity,
            tool: call.tool,
            request: Object.freeze(structuredClone(call.request)),
            response: Object.freeze(structuredClone(call.response)),
          }),
        ),
      ),
    ),
  });
}

function traceResponseEnvelope(response) {
  if (typeof response.ok === "boolean") return response;
  if (typeof response.wire_response !== "string") return undefined;
  for (const line of response.wire_response.split(/\r?\n/u)) {
    if (!line.startsWith("data: ")) continue;
    try {
      const message = JSON.parse(line.slice("data: ".length));
      const structured = message?.result?.structuredContent;
      if (isRecord(structured) && typeof structured.ok === "boolean") {
        return structured;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function expectedTraceTool(step) {
  if (typeof step.tool === "string") return step.tool;
  if (step.call === "mcp-transport/reconnect") return "mcp_transport_reconnect";
  return undefined;
}

function controlledCallMatchesStep(step, call) {
  const expectedTool = expectedTraceTool(step);
  if (expectedTool === undefined || call.tool !== expectedTool) return false;
  if (expectedTool === "mcp_transport_reconnect") {
    return (
      call.request.transport_principal === step.input.transport_principal &&
      call.response.initialized === true &&
      call.response.device_operation_count === 0
    );
  }
  const response = traceResponseEnvelope(call.response);
  if (response === undefined || response.tool !== expectedTool) return false;
  const expectedErrorCodes = [
    ...step.expect.matchAll(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/gu),
  ].map((match) => match[0]);
  if (expectedErrorCodes.length > 0 && response.ok === false) {
    if (
      !isRecord(response.error) ||
      !expectedErrorCodes.includes(response.error.code)
    ) {
      return false;
    }
    if (
      /\bnot_sent\b/u.test(step.expect) &&
      response.error.outcome !== "not_sent"
    ) {
      return false;
    }
    if (
      /zero (?:downstream |mutation )?writes?/iu.test(step.expect) &&
      (!isRecord(response.error.details) ||
        ![null, 0].includes(
          response.error.details.dispatched_action_count ?? null,
        ) ||
        ![null, 0].includes(
          response.error.details.completed_action_count ?? null,
        ))
    ) {
      return false;
    }
    return true;
  }
  const allowsSuccessAlternative = expectedErrorCodes.some((code) =>
    new RegExp(`\\bor\\s+(?:a|an)\\s+${code}\\b`, "iu").test(step.expect),
  );
  if (
    expectedErrorCodes.length > 0 &&
    (!allowsSuccessAlternative || response.ok !== true)
  ) {
    return false;
  }
  if (response.ok !== true) return false;
  if (
    expectedTool === "jetkvm_session_status" &&
    /\b(?:ready|same explicit device session)\b/iu.test(step.expect) &&
    (response.session_id !== call.request.session_id ||
      response.session_generation !== call.request.session_generation ||
      response.result?.state !== "ready")
  ) {
    return false;
  }
  if (
    /\boutcome applied\b/iu.test(step.expect) &&
    response.result?.outcome !== "applied"
  ) {
    return false;
  }
  if (
    /\balready_applied\b|\balready applied\b/iu.test(step.expect) &&
    response.result?.outcome !== "already_applied"
  ) {
    return false;
  }
  return true;
}

export function buildControlledReleaseEvidence({
  stories,
  plan,
  branchMatrix,
  storyE2e,
  executionTraces,
}) {
  const resolver = createExecutionEvidenceResolver({ branchMatrix, storyE2e });
  const evidence = {};
  for (const story of stories.filter((candidate) =>
    candidate.environments.includes("live"),
  )) {
    const storyPlan = plan[story.id];
    if (!isRecord(storyPlan) || !isRecord(storyPlan.steps)) {
      throw new Error(`Controlled release plan omitted story ${story.id}.`);
    }
    for (const step of story.steps) {
      const assignment = storyPlan.steps[step.id];
      if (!isRecord(assignment) || assignment.mode !== "controlled_live")
        continue;
      const identity = `controlled:${story.id}:${step.id}`;
      const executionIdentities = resolver(story, step, "linked");
      const requestResponseTraces = executionIdentities.map((identity) =>
        exactExecutionTrace(executionTraces, identity, resolver.evidence),
      );
      const expectedTool = expectedTraceTool(step);
      if (
        expectedTool === undefined ||
        requestResponseTraces.some(
          (trace) =>
            !trace.calls.some((call) => controlledCallMatchesStep(step, call)),
        )
      ) {
        throw new Error(
          `Controlled step ${story.id}/${step.id} lacks its exact expected outcome.`,
        );
      }
      evidence[identity] = Object.freeze({
        result: "pass",
        execution_identities: Object.freeze(executionIdentities),
        request_response_traces: Object.freeze(requestResponseTraces),
        request_response_traces_sha256: sha256Canonical(requestResponseTraces),
        branch_matrix_sha256: sha256Canonical(branchMatrix),
        story_e2e_sha256: sha256Canonical(storyE2e),
      });
    }
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(evidence).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

export function validateControlledReleaseEvidence(input) {
  if (!isRecord(input?.evidence)) {
    throw new Error("Controlled release evidence must be an object.");
  }
  const expected = buildControlledReleaseEvidence(input);
  if (canonicalJson(input.evidence) !== canonicalJson(expected)) {
    throw new Error(
      "Controlled release evidence does not match the reviewed inventory and hashes.",
    );
  }
  return expected;
}

export async function writeControlledReleaseEvidence(path, evidence) {
  path = resolve(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function run() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex < 0 || typeof process.argv[outputIndex + 1] !== "string") {
    throw new Error(
      "Usage: node scripts/build-controlled-release-evidence.mjs --output <path>",
    );
  }
  const [
    { loadAcceptanceStories },
    { materializeLiveExecutionPlan },
    branchMatrix,
    storyE2e,
    inputDisplayTraces,
    powerSessionTraces,
    transportSessionTraces,
  ] = await Promise.all([
    import("../dist/stories/manifest.js"),
    import("./live-story-plan.mjs"),
    readFile(resolve(packageRoot, "reports/branch-matrix.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(resolve(packageRoot, "reports/story-e2e.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(
      resolve(packageRoot, "reports/controlled-traces/input-display.json"),
      "utf8",
    ).then(JSON.parse),
    readFile(
      resolve(packageRoot, "reports/controlled-traces/power-session.json"),
      "utf8",
    ).then(JSON.parse),
    readFile(
      resolve(packageRoot, "reports/controlled-traces/transport-session.json"),
      "utf8",
    ).then(JSON.parse),
  ]);
  const executionTraces = mergeControlledTraceReports([
    inputDisplayTraces,
    powerSessionTraces,
    transportSessionTraces,
  ]);
  const stories = await loadAcceptanceStories(
    resolve(packageRoot, "dist/stories"),
  );
  const resolver = createExecutionEvidenceResolver({ branchMatrix, storyE2e });
  const plan = materializeLiveExecutionPlan(stories, resolver);
  const evidence = buildControlledReleaseEvidence({
    stories,
    plan,
    branchMatrix,
    storyE2e,
    executionTraces,
  });
  await writeControlledReleaseEvidence(process.argv[outputIndex + 1], evidence);
  process.stdout.write(
    `Controlled release evidence: ${Object.keys(evidence).length}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run();
}
