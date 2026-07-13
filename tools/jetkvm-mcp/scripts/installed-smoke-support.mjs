import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function prepareInstalledPackage(
  label,
  {
    execFileImpl = execFileAsync,
    mkdirImpl = mkdir,
    mkdtempImpl = mkdtemp,
    rmImpl = rm,
    writeFileImpl = writeFile,
  } = {},
) {
  const root = await mkdtempImpl(join(tmpdir(), `jetkvm-mcp-${label}-`));
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= Promise.resolve().then(() =>
      rmImpl(root, { recursive: true, force: true }),
    );
    return cleanupPromise;
  };

  try {
    const artifacts = join(root, "artifacts");
    const consumer = join(root, "consumer");
    await mkdirImpl(artifacts);
    await mkdirImpl(consumer);
    await writeFileImpl(
      join(consumer, "package.json"),
      `${JSON.stringify({ private: true, type: "module" })}\n`,
    );

    const packed = await execFileImpl(
      process.env.npm_execpath ?? "npm",
      ["pack", "--json", "--pack-destination", artifacts],
      { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
    );
    const packResult = JSON.parse(packed.stdout);
    if (
      !Array.isArray(packResult) ||
      typeof packResult[0]?.filename !== "string"
    ) {
      throw new Error("npm pack did not report a tarball");
    }
    const tarball = join(artifacts, packResult[0].filename);
    await execFileImpl(
      process.env.npm_execpath ?? "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      { cwd: consumer, maxBuffer: 4 * 1024 * 1024 },
    );
    await writeDeterministicHandlers(consumer, writeFileImpl);

    return {
      root,
      consumer,
      cleanup,
    };
  } catch (preparationError) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [preparationError, cleanupError],
        "Installed package preparation and temporary-directory cleanup both failed",
        { cause: preparationError },
      );
    }
    throw preparationError;
  }
}

export async function runInstalledModule(consumer, filename, source) {
  const path = join(consumer, filename);
  await writeFile(path, source);
  return execFileAsync(process.execPath, [path], {
    cwd: consumer,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function writeDeterministicHandlers(consumer, writeFileImpl) {
  await writeFileImpl(
    join(consumer, "deterministic-handlers.mjs"),
    `import { JETKVM_TOOL_NAMES } from "@wyrmkeep/jetkvm-mcp/dist/domain.js";

export const validInputs = {
  jetkvm_session_connect: { request_id: "success", timeout_ms: 100 },
  jetkvm_session_status: { session_id: "session-1", session_generation: 1, timeout_ms: 100 },
  jetkvm_session_reconnect: { session_id: "session-1", session_generation: 1, request_id: "request-reconnect", timeout_ms: 100 },
  jetkvm_display_capture: { session_id: "session-1", session_generation: 1, timeout_ms: 100 },
  jetkvm_display_status: { session_id: "session-1", session_generation: 1, timeout_ms: 100 },
  jetkvm_input_mouse: { session_id: "session-1", session_generation: 1, observation_id: "observation-1", request_id: "request-mouse", actions: [{ type: "move", x: 0, y: 0 }], timeout_ms: 100 },
  jetkvm_input_keyboard: { session_id: "session-1", session_generation: 1, observation_id: "observation-1", request_id: "request-keyboard", actions: [{ type: "key_press", key: "Enter" }], timeout_ms: 100 },
  jetkvm_input_paste: { session_id: "session-1", session_generation: 1, observation_id: "observation-1", request_id: "request-paste", text: "installed smoke", timeout_ms: 100 },
  jetkvm_input_release: { session_id: "session-1", session_generation: 1, request_id: "request-release", timeout_ms: 100 },
  jetkvm_power_control: { session_id: "session-1", session_generation: 1, request_id: "request-power", action: "press_power", timeout_ms: 100 },
};

const capabilities = {
  session_status: true,
  display_capture: true,
  display_status: true,
  mouse: true,
  absolute_pointer: true,
  keyboard: true,
  reliable_paste: true,
  input_release: true,
  power_control: true,
  edid_read: true,
};

export const handlerCalls = Object.fromEntries(JETKVM_TOOL_NAMES.map((name) => [name, 0]));

function textResult(payload, isError) {
  return {
    ...(isError ? { isError: true } : {}),
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function success() {
  return textResult({
    ok: true,
    tool: "jetkvm_session_connect",
    operation_id: "operation-success",
    session_id: "session-1",
    session_generation: 1,
    duration_ms: 0,
    result: {
      request_id: "success",
      outcome: "applied",
      verification: "device_ack_only",
      safe_to_retry: false,
      required_next_step: "none",
      state: "ready",
      connection_epoch: 1,
      display_generation: 1,
      takeover_performed: false,
      fresh_capture_required: true,
      permissions: ["session.connect"],
      capabilities,
    },
  }, false);
}

function businessError(tool) {
  const isRead =
    tool === "jetkvm_display_capture" ||
    tool === "jetkvm_display_status" ||
    tool === "jetkvm_session_status";
  return textResult({
    ok: false,
    tool,
    operation_id: \`operation-\${tool}\`,
    session_id: tool === "jetkvm_session_connect" ? null : "session-1",
    session_generation: tool === "jetkvm_session_connect" ? null : 1,
    duration_ms: 0,
    error: {
      code: "CONFIG_INVALID",
      message: "deterministic installed handler",
      phase: "validate",
      outcome: isRead ? null : "not_sent",
      verification: "none",
      safe_to_retry: false,
      required_next_step: "none",
      details: {
        permission: null,
        capability: null,
        failed_action_index: null,
        dispatched_action_count: null,
        completed_action_count: null,
        downstream_stage: "none",
        expected_generation: null,
        actual_generation: null,
        observation_id: null,
      },
    },
  }, true);
}

export const handlers = Object.fromEntries(
  JETKVM_TOOL_NAMES.map((name) => [name, async (input) => {
    handlerCalls[name] += 1;
    return name === "jetkvm_session_connect" && input.request_id === "success"
      ? success()
      : businessError(name);
  }]),
);
`,
  );
}
