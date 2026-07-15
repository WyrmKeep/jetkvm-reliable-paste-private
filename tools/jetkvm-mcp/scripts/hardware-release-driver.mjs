import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { crc32, inflateSync } from "node:zlib";
import jpeg from "jpeg-js";

import {
  buildDirectoryManifest,
  buildProductionResolution,
  isGeneratedInstalledBinLink,
  canonicalJson,
  sha256Canonical,
  sha256File,
} from "./release-evidence.mjs";

const SESSION_TOOLS = new Set([
  "jetkvm_session_status",
  "jetkvm_session_reconnect",
  "jetkvm_display_capture",
  "jetkvm_display_status",
  "jetkvm_input_mouse",
  "jetkvm_input_keyboard",
  "jetkvm_input_paste",
  "jetkvm_input_release",
  "jetkvm_power_control",
]);
const MUTATION_TOOLS = new Set([
  "jetkvm_input_mouse",
  "jetkvm_input_keyboard",
  "jetkvm_input_paste",
  "jetkvm_input_release",
  "jetkvm_power_control",
]);
const OBSERVATION_TOOLS = new Set([
  "jetkvm_input_mouse",
  "jetkvm_input_keyboard",
  "jetkvm_input_paste",
]);

const SESSION_STARTUP_TIMEOUT_MS = 60_000;

export function powerActionRequiresOfflineWait(action) {
  return action === "press_power" || action === "hold_power";
}
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const OMITTED_KEYS = new Set([
  "session_id",
  "operation_id",
  "request_id",
  "observation_id",
  "frame_id",
  "text",
  "message",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableIdentifier(prefix, value) {
  return `${prefix}-${sha256Bytes(value).slice(0, 32)}`;
}

function publicError(error) {
  if (isRecord(error)) {
    const code =
      typeof error.code === "string" ? error.code : "UNEXPECTED_FAILURE";
    return { code };
  }
  return { code: "UNEXPECTED_FAILURE" };
}

function scrubForHash(value) {
  if (Array.isArray(value)) return value.map(scrubForHash);
  if (!isRecord(value)) return value;
  const scrubbed = {};
  for (const [key, child] of Object.entries(value)) {
    if (OMITTED_KEYS.has(key)) continue;
    scrubbed[key] = scrubForHash(child);
  }
  return scrubbed;
}

function decodePng(bytes) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (bytes.byteLength < 45 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("MCP image evidence was not a decodable PNG.");
  }
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let sawHeader = false;
  let sawEnd = false;
  const compressed = [];
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw new Error("MCP image evidence was not a decodable PNG.");
    }
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.byteLength) {
      throw new Error("MCP image evidence was not a decodable PNG.");
    }
    const type = bytes.subarray(offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      crc32(Buffer.concat([type, data])) >>> 0 !==
      bytes.readUInt32BE(offset + 8 + length)
    ) {
      throw new Error("MCP image evidence was not a decodable PNG.");
    }
    const name = type.toString("ascii");
    if (name === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) {
        throw new Error("MCP image evidence was not a decodable PNG.");
      }
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      const validDepths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      }[colorType];
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 16_384 ||
        height > 16_384 ||
        !validDepths?.includes(bitDepth) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        throw new Error("MCP image evidence was not a decodable PNG.");
      }
      sawHeader = true;
    } else if (name === "IDAT") {
      if (!sawHeader || sawEnd) {
        throw new Error("MCP image evidence was not a decodable PNG.");
      }
      compressed.push(data);
    } else if (name === "IEND") {
      if (!sawHeader || length !== 0 || chunkEnd !== bytes.byteLength) {
        throw new Error("MCP image evidence was not a decodable PNG.");
      }
      sawEnd = true;
    }
    offset = chunkEnd;
  }
  if (!sawEnd || compressed.length === 0) {
    throw new Error("MCP image evidence was not a decodable PNG.");
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expectedBytes = (rowBytes + 1) * height;
  if (expectedBytes > 64 * 1024 * 1024) {
    throw new Error("MCP image evidence was not a decodable PNG.");
  }
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: expectedBytes,
    });
  } catch {
    throw new Error("MCP image evidence was not a decodable PNG.");
  }
  if (decoded.byteLength !== expectedBytes) {
    throw new Error("MCP image evidence was not a decodable PNG.");
  }
  for (let row = 0; row < height; row += 1) {
    if (decoded[row * (rowBytes + 1)] > 4) {
      throw new Error("MCP image evidence was not a decodable PNG.");
    }
  }
  return { width, height };
}

function decodeJpeg(bytes) {
  if (
    bytes.byteLength < 16 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    throw new Error("MCP image evidence was not a decodable JPEG.");
  }
  let decoded;
  try {
    decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: 32,
      maxMemoryUsageInMB: 64,
    });
  } catch {
    throw new Error("MCP image evidence was not a decodable JPEG.");
  }
  if (
    !Number.isSafeInteger(decoded.width) ||
    !Number.isSafeInteger(decoded.height) ||
    decoded.width < 1 ||
    decoded.height < 1 ||
    decoded.data.byteLength !== decoded.width * decoded.height * 3
  ) {
    throw new Error("MCP image evidence was not a decodable JPEG.");
  }
  return { width: decoded.width, height: decoded.height };
}

function decodeImage(bytes, mimeType) {
  if (mimeType === "image/png") return decodePng(bytes);
  if (mimeType === "image/jpeg") return decodeJpeg(bytes);
  throw new Error("MCP image evidence used an unsupported MIME type.");
}

function imageEvidence(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, contentIndex) => {
    if (!isRecord(block) || block.type !== "image") return [];
    if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
      throw new Error("MCP image evidence was malformed.");
    }
    const bytes = Buffer.from(block.data, "base64");
    if (bytes.byteLength === 0 || bytes.toString("base64") !== block.data) {
      throw new Error("MCP image evidence was not strict nonempty base64.");
    }
    const dimensions = decodeImage(bytes, block.mimeType);
    return [
      Object.freeze({
        content_index: contentIndex,
        mime_type: block.mimeType,
        byte_length: bytes.byteLength,
        sha256: sha256Bytes(bytes),
        image_width: dimensions.width,
        image_height: dimensions.height,
      }),
    ];
  });
}

export function sanitizeToolEvidence(result, context = {}) {
  if (!isRecord(result)) throw new Error("MCP tool result was malformed.");
  const structured = result.structuredContent;
  if (!isRecord(structured)) {
    throw new Error("MCP tool result omitted structured content.");
  }
  const error = isRecord(structured.error) ? structured.error : undefined;
  const operationResult = isRecord(structured.result)
    ? structured.result
    : undefined;
  const scrubbedStructured = scrubForHash(structured);
  const images = imageEvidence(result.content);
  if (structured.tool === "jetkvm_display_capture") {
    const declaredImage = operationResult?.image;
    const image = images[0];
    if (
      images.length !== 1 ||
      !isRecord(declaredImage) ||
      image.content_index !== declaredImage.content_index ||
      image.mime_type !== declaredImage.mime_type ||
      image.byte_length !== declaredImage.byte_length ||
      image.sha256 !== declaredImage.sha256
    ) {
      throw new Error(
        "Display capture omitted its exact declared screenshot image.",
      );
    }
    const geometry = operationResult?.geometry;
    const capturedAt = Date.parse(operationResult?.captured_at ?? "");
    const sourceWidth = operationResult?.source_width;
    const sourceHeight = operationResult?.source_height;
    const imageWidth = operationResult?.image_width;
    const imageHeight = operationResult?.image_height;
    const rotation = operationResult?.rotation;
    const rotatedWidth =
      rotation === 90 || rotation === 270 ? sourceHeight : sourceWidth;
    const rotatedHeight =
      rotation === 90 || rotation === 270 ? sourceWidth : sourceHeight;
    const requestedFormat = context.request?.format;
    if (
      !Number.isFinite(capturedAt) ||
      (Number.isFinite(context.requestedAt) &&
        (capturedAt < context.requestedAt ||
          capturedAt > Date.now() + 1_000)) ||
      !Number.isSafeInteger(sourceWidth) ||
      sourceWidth < 1 ||
      !Number.isSafeInteger(sourceHeight) ||
      sourceHeight < 1 ||
      !Number.isSafeInteger(imageWidth) ||
      imageWidth !== image.image_width ||
      !Number.isSafeInteger(imageHeight) ||
      imageHeight !== image.image_height ||
      ![0, 90, 180, 270].includes(rotation) ||
      imageWidth > rotatedWidth ||
      imageHeight > rotatedHeight ||
      Math.abs(imageWidth * rotatedHeight - imageHeight * rotatedWidth) >
        Math.max(rotatedWidth, rotatedHeight) ||
      (Number.isSafeInteger(context.request?.max_width) &&
        imageWidth > context.request.max_width) ||
      (Number.isSafeInteger(context.request?.max_height) &&
        imageHeight > context.request.max_height) ||
      (requestedFormat === "png" && image.mime_type !== "image/png") ||
      (requestedFormat === "jpeg" && image.mime_type !== "image/jpeg") ||
      !isRecord(geometry) ||
      !Number.isSafeInteger(geometry.content_x) ||
      geometry.content_x < 0 ||
      !Number.isSafeInteger(geometry.content_y) ||
      geometry.content_y < 0 ||
      !Number.isSafeInteger(geometry.content_width) ||
      geometry.content_width < 1 ||
      !Number.isSafeInteger(geometry.content_height) ||
      geometry.content_height < 1 ||
      geometry.content_x + geometry.content_width > imageWidth ||
      geometry.content_y + geometry.content_height > imageHeight
    ) {
      throw new Error(
        "Display capture geometry or freshness did not match the screenshot.",
      );
    }
  }
  const evidence = {
    ok: structured.ok === true,
    tool: typeof structured.tool === "string" ? structured.tool : null,
    session_generation: Number.isSafeInteger(structured.session_generation)
      ? structured.session_generation
      : null,
    outcome:
      typeof operationResult?.outcome === "string"
        ? operationResult.outcome
        : typeof error?.outcome === "string"
          ? error.outcome
          : null,
    verification:
      typeof operationResult?.verification === "string"
        ? operationResult.verification
        : typeof error?.verification === "string"
          ? error.verification
          : null,
    error_code: typeof error?.code === "string" ? error.code : null,
    required_next_step:
      typeof operationResult?.required_next_step === "string"
        ? operationResult.required_next_step
        : typeof error?.required_next_step === "string"
          ? error.required_next_step
          : null,
    dispatched_action_count: Number.isSafeInteger(
      operationResult?.dispatched_action_count,
    )
      ? operationResult.dispatched_action_count
      : Number.isSafeInteger(error?.details?.dispatched_action_count)
        ? error.details.dispatched_action_count
        : null,
    completed_action_count: Number.isSafeInteger(
      operationResult?.completed_action_count,
    )
      ? operationResult.completed_action_count
      : Number.isSafeInteger(error?.details?.completed_action_count)
        ? error.details.completed_action_count
        : null,
    images,
    structured: scrubbedStructured,
    structured_sha256: sha256Canonical(scrubbedStructured),
  };
  return Object.freeze(evidence);
}

export class InstalledMcpClient {
  #options;
  #client;
  #transport;
  #stderrBytes = 0;
  #stderrHash = createHash("sha256");
  #sensitiveValues;
  #stderrLeak = false;
  #stderrTail = "";

  constructor(options) {
    this.#options = options;
    this.#sensitiveValues = (options.sensitiveValues ?? []).filter(
      (value) => typeof value === "string" && value.length > 0,
    );
  }

  async start() {
    if (this.#client !== undefined)
      throw new Error("MCP client is already running.");
    if (
      typeof this.#options.transportFactory !== "function" ||
      typeof this.#options.clientFactory !== "function"
    ) {
      throw new Error("Verified MCP SDK factories are required.");
    }
    const transportOptions = {
      command: this.#options.command,
      args: this.#options.args ?? [],
      cwd: this.#options.cwd,
      env: this.#options.environment,
      stderr: "pipe",
    };
    const transport = this.#options.transportFactory(transportOptions);
    const maximumSensitiveLength = Math.max(
      0,
      ...this.#sensitiveValues.map((value) => value.length),
    );
    transport.stderr?.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      const text = `${this.#stderrTail}${bytes.toString("utf8")}`;
      if (this.#sensitiveValues.some((sensitive) => text.includes(sensitive))) {
        this.#stderrLeak = true;
        transport.close().catch(() => undefined);
      }
      this.#stderrTail =
        maximumSensitiveLength > 1
          ? text.slice(-(maximumSensitiveLength - 1))
          : "";
      this.#stderrBytes += bytes.byteLength;
      this.#stderrHash.update(bytes);
    });
    const client = this.#options.clientFactory();
    try {
      await client.connect(transport);
      const listed = await client.listTools(
        {},
        { timeout: 30_000, maxTotalTimeout: 30_000 },
      );
      if (this.#stderrLeak) {
        throw new Error("MCP stderr exposed a protected value.");
      }
      const names = listed.tools.map((tool) => tool.name);
      if (names.length !== 10 || new Set(names).size !== 10) {
        throw new Error(
          "Installed MCP candidate did not expose exactly ten tools.",
        );
      }
      this.#transport = transport;
      this.#client = client;
      return Object.freeze({
        tool_names_sha256: sha256Canonical(names),
        tool_count: names.length,
      });
    } catch (error) {
      const cleanup = await Promise.allSettled([
        client.close(),
        transport.close(),
      ]);
      const cleanupFailures = cleanup
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "MCP startup and cleanup both failed.",
        );
      }
      throw error;
    }
  }

  async call(name, args, timeoutMs = 60_000) {
    if (this.#client === undefined)
      throw new Error("MCP client is not running.");
    if (this.#stderrLeak) {
      throw new Error("MCP stderr exposed a protected value.");
    }
    const requestedAt = Date.now();
    const result = await this.#client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
    );
    if (this.#stderrLeak) {
      throw new Error("MCP stderr exposed a protected value.");
    }
    if (
      !isRecord(result.structuredContent) ||
      result.structuredContent.tool !== name
    ) {
      throw new Error("MCP response tool identity did not match the request.");
    }
    return Object.freeze({
      raw: result.structuredContent,
      evidence: sanitizeToolEvidence(result, {
        request: args,
        requestedAt,
      }),
    });
  }

  async close() {
    const client = this.#client;
    if (client === undefined) return false;
    await client.close();
    this.#client = undefined;
    this.#transport = undefined;
    return true;
  }

  stderrEvidence() {
    if (this.#stderrLeak) {
      throw new Error("MCP stderr exposed a protected value.");
    }
    return Object.freeze({
      byte_length: this.#stderrBytes,
      sha256: this.#stderrHash.copy().digest("hex"),
    });
  }
}

export async function finalizeLiveHardwareResources({
  driver,
  driverFinalization,
  clients = [],
  hardwareTouched = driver !== undefined,
  now = () => new Date(),
}) {
  const failures = [];
  const failureStages = [];
  let releaseAndBaseline = driverFinalization;
  if (driver !== undefined && releaseAndBaseline === undefined) {
    try {
      releaseAndBaseline = await driver.finalizeRun();
    } catch (error) {
      failures.push(error);
      failureStages.push("driver-finalization");
    }
  }
  const clientRecords = [];
  const seenClients = new Set();
  for (const entry of clients) {
    if (entry?.client === undefined || seenClients.has(entry.client)) continue;
    seenClients.add(entry.client);
    let closed = false;
    let stderr;
    try {
      await entry.client.close();
      closed = true;
    } catch (error) {
      failures.push(error);
      failureStages.push(`${entry.label}-close`);
    }
    try {
      stderr = entry.client.stderrEvidence();
    } catch (error) {
      failures.push(error);
      failureStages.push(`${entry.label}-stderr`);
    }
    clientRecords.push(
      Object.freeze({
        label: entry.label,
        closed,
        stderr: stderr ?? null,
      }),
    );
  }
  const safeBaselineProven = driver?.state?.safeBaselineProven === true;
  if (hardwareTouched && !safeBaselineProven) {
    failures.push(
      new Error(
        "The post-run device baseline is unproven; manual recovery is required.",
      ),
    );
    failureStages.push("safe-baseline");
  }
  return Object.freeze({
    record: Object.freeze({
      schema_version: 1,
      kind: "jetkvm-mcp-hardware-finalization",
      result: failures.length === 0 ? "pass" : "fail",
      completed_at: now().toISOString(),
      release_and_baseline_evidence_sha256:
        releaseAndBaseline?.evidence_sha256 ?? null,
      safe_baseline_proven: safeBaselineProven,
      manual_recovery_required: hardwareTouched && !safeBaselineProven,
      clients: clientRecords,
      failure_count: failures.length,
      failure_stages: Object.freeze(failureStages),
    }),
    failures: Object.freeze(failures),
  });
}

export class LiveStepBindings {
  #runId;
  #requestIds = new Map();
  #requestBindings = new Map();

  constructor(runId) {
    this.#runId = runId;
  }

  adapt(step, state) {
    const input = structuredClone(step.input ?? {});
    const staleSession =
      /(?:stale[^/]*generation|old-generation|replaced-session|closed-session)/u.test(
        step.id,
      );
    const staleObservation = /(?:old-observation|foreign-observation)/u.test(
      step.id,
    );
    const session = staleSession
      ? (state.previousSession ?? state.session)
      : state.session;
    const observation = staleObservation
      ? (state.previousObservation ?? state.observation)
      : state.observation;
    const canonicalRequestId = input.request_id;
    if (typeof canonicalRequestId === "string") {
      if (!this.#requestIds.has(canonicalRequestId)) {
        this.#requestIds.set(
          canonicalRequestId,
          stableIdentifier("req", `${this.#runId}:${canonicalRequestId}`),
        );
        this.#requestBindings.set(canonicalRequestId, {
          sessionId: session?.id,
          sessionGeneration: session?.generation,
          observationId: observation?.id,
        });
      }
      input.request_id = this.#requestIds.get(canonicalRequestId);
    }
    const requestBinding =
      typeof canonicalRequestId === "string"
        ? this.#requestBindings.get(canonicalRequestId)
        : undefined;
    if (Object.hasOwn(input, "session_id")) {
      input.session_id =
        requestBinding?.sessionId ?? session?.id ?? "invalid-session";
    }
    if (Object.hasOwn(input, "session_generation")) {
      input.session_generation =
        requestBinding?.sessionGeneration ?? session?.generation ?? 0;
    }
    if (Object.hasOwn(input, "observation_id")) {
      input.observation_id =
        requestBinding?.observationId ??
        observation?.id ??
        "invalid-observation";
    }
    if (Number.isSafeInteger(input.timeout_ms)) {
      input.timeout_ms =
        /(?:duplicate|same-release|changed-release)/u.test(step.id) &&
        input.timeout_ms !== 1_000
          ? 30_001
          : Math.max(input.timeout_ms, 30_000);
    }
    return input;
  }
}

export function assertHardwareCallExpectation(
  step,
  raw,
  protocolError,
  input = step.input,
) {
  if (protocolError !== undefined) {
    const schemaRejectionExpected =
      /reject-strict-schema/u.test(step.id) ||
      /(?:schema rejection|schema-rejected|schema rejects)/iu.test(step.expect);
    if (schemaRejectionExpected && protocolError.code === -32602) {
      return;
    }
    throw protocolError;
  }
  if (!isRecord(raw) || typeof raw.ok !== "boolean") {
    throw new Error(
      `Hardware step ${step.id} returned malformed structured content.`,
    );
  }
  if (!raw.ok) {
    const code =
      isRecord(raw.error) && typeof raw.error.code === "string"
        ? raw.error.code
        : undefined;
    const expectedCode =
      code !== undefined &&
      (new RegExp(`\\b${code}\\b`, "u").test(step.expect) ||
        new RegExp(
          `\\b${code.toLowerCase().replace(/^session_/u, "")}\\b`,
          "iu",
        ).test(step.expect));
    if (!expectedCode) {
      throw new Error(
        `Hardware step ${step.id} returned an unexpected public error.`,
      );
    }
    const expectsZeroWrite =
      /\bnot_sent\b|zero (?:downstream |mutation )?writes?/iu.test(step.expect);
    if (
      expectsZeroWrite &&
      (!isRecord(raw.error) ||
        raw.error.outcome !== "not_sent" ||
        raw.error.verification !== "none" ||
        ![null, 0].includes(
          raw.error.details?.dispatched_action_count ?? null,
        ) ||
        ![null, 0].includes(raw.error.details?.completed_action_count ?? null))
    ) {
      throw new Error(
        `Hardware step ${step.id} did not prove zero-write error semantics.`,
      );
    }
    return;
  }
  if (/(?:already_applied|already applied)/iu.test(step.expect)) {
    if (
      !isRecord(raw.result) ||
      raw.result.outcome !== "already_applied" ||
      raw.result.request_id !== input?.request_id ||
      typeof raw.result.verification !== "string" ||
      raw.result.verification === "none"
    ) {
      throw new Error(
        `Hardware step ${step.id} did not return a correlated cached mutation receipt.`,
      );
    }
  } else if (MUTATION_TOOLS.has(step.tool)) {
    if (
      !isRecord(raw.result) ||
      raw.result.outcome !== "applied" ||
      raw.result.request_id !== input?.request_id ||
      typeof raw.result.verification !== "string" ||
      raw.result.verification === "none"
    ) {
      throw new Error(
        `Hardware step ${step.id} did not return a correlated applied verification.`,
      );
    }
  }
  if (step.tool === "jetkvm_power_control" && isRecord(raw.result)) {
    const semantic = {
      press_power: { wire: "power-short", duration: 200 },
      hold_power: { wire: "power-long", duration: 5_000 },
      press_reset: { wire: "reset", duration: 200 },
    }[input?.action];
    if (
      semantic === undefined ||
      raw.result.action !== input.action ||
      raw.result.wire_action !== semantic.wire ||
      raw.result.fixed_press_ms !== semantic.duration ||
      raw.result.serial_sequence_completed !== true
    ) {
      throw new Error(
        `Hardware step ${step.id} did not return its semantic ATX receipt.`,
      );
    }
  }
  if (
    /\bCONTROL_BUSY\b|\bSTALE_|\bOBSERVATION_CONSUMED\b|\bREQUEST_ID_REUSED_/u.test(
      step.expect,
    )
  ) {
    throw new Error(`Hardware step ${step.id} unexpectedly succeeded.`);
  }
}

function hardwareResult(startedAt, evidence) {
  return Object.freeze({
    result: "pass",
    duration_ms: Date.now() - startedAt,
    evidence,
    evidence_sha256: sha256Canonical(evidence),
  });
}

export function compareSafeBaselines(before, after) {
  const exactFields = [
    "candidate_revision",
    "display",
    "layout",
    "lock_keys",
    "atx",
    "browser",
    "fixture",
    "host_online",
    "held_input",
  ];
  for (const field of exactFields) {
    if (canonicalJson(before[field]) !== canonicalJson(after[field])) {
      throw new Error(`Safe baseline field ${field} was not restored.`);
    }
  }
  if (
    !Number.isSafeInteger(before.session_generation) ||
    !Number.isSafeInteger(after.session_generation) ||
    after.session_generation < before.session_generation
  ) {
    throw new Error("Safe baseline session generation regressed.");
  }
  return Object.freeze({
    result: "pass",
    evidence_sha256: sha256Canonical({ before, after }),
  });
}

export function assertAuthoritativeRelease(raw) {
  const result = isRecord(raw?.result) ? raw.result : undefined;
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !isRecord(result) ||
    result.mutation_gate_closed !== true ||
    result.deferred_producers_joined !== true ||
    !["cancelled", "inactive"].includes(result.paste_terminal) ||
    result.ordinary_leases_zero !== true ||
    result.keyboard_zero !== true ||
    result.pointer_zero !== true ||
    result.generation_drained !== true
  ) {
    throw new Error(
      "Authoritative input release did not prove producer join and zero input.",
    );
  }
  return raw;
}
export function heldInputFacts(releaseResult) {
  if (
    !isRecord(releaseResult) ||
    releaseResult.keyboard_zero !== true ||
    releaseResult.pointer_zero !== true
  ) {
    throw new Error(
      "Authoritative release did not report an authoritative zero-input state.",
    );
  }
  return Object.freeze({ keys: 0, buttons: 0 });
}

export function createLiveHardwareDriver({
  mcp,
  rig,
  candidate,
  runId,
  executionResolver,
  controlledExecution,
}) {
  const state = {
    session: undefined,
    previousSession: undefined,
    observation: undefined,
    previousObservation: undefined,
    baseline: undefined,
    lastRelease: undefined,
    emergencyPaste: undefined,
    emergencyProducers: undefined,
    emergencyPendingAtRelease: undefined,
    emergencyHeldKeyEvidence: undefined,
    pasteVerification: undefined,
    atxProof:
      candidate.hardware_validation?.profile === "atx_unavailable"
        ? Object.freeze({
            validation: "not_performed",
            exception_code: candidate.hardware_validation.exception_code,
          })
        : undefined,
    safeBaselineProven: false,
  };
  const bindings = new LiveStepBindings(runId);

  async function callRaw(name, input, timeoutMs) {
    return mcp.call(name, input, Math.max(timeoutMs + 5_000, 30_000));
  }

  function updateState(tool, raw) {
    if (!isRecord(raw) || raw.ok !== true) return;
    if (
      (tool === "jetkvm_session_connect" ||
        tool === "jetkvm_session_reconnect") &&
      typeof raw.session_id === "string" &&
      Number.isSafeInteger(raw.session_generation)
    ) {
      if (state.session !== undefined) state.previousSession = state.session;
      if (state.observation !== undefined) {
        state.previousObservation = state.observation;
      }
      state.session = {
        id: raw.session_id,
        generation: raw.session_generation,
      };
      state.observation = undefined;
    }
    if (
      tool === "jetkvm_display_capture" &&
      isRecord(raw.result) &&
      typeof raw.result.observation_id === "string"
    ) {
      if (state.observation !== undefined) {
        state.previousObservation = state.observation;
      }
      state.observation = { id: raw.result.observation_id };
    }
    if (tool === "jetkvm_input_release") {
      state.lastRelease = raw;
      state.previousSession = state.session;
      state.previousObservation = state.observation;
      state.session = undefined;
      state.observation = undefined;
    }
  }

  async function callStep(step, inputOverride) {
    const startedAt = Date.now();
    const input = inputOverride ?? bindings.adapt(step, state);
    let response;
    let protocolError;
    try {
      response = await callRaw(step.tool, input, step.timeout_ms);
    } catch (error) {
      protocolError = error;
    }
    assertHardwareCallExpectation(step, response?.raw, protocolError, input);
    if (response !== undefined) updateState(step.tool, response.raw);
    return {
      startedAt,
      response,
      input_sha256: sha256Canonical(scrubForHash(input)),
    };
  }

  async function ensureSession() {
    if (state.session !== undefined) return;
    const requestId = stableIdentifier(
      "req",
      `${runId}:ensure:${randomUUID()}`,
    );
    const response = await callRaw(
      "jetkvm_session_connect",
      {
        request_id: requestId,
        takeover: false,
        timeout_ms: SESSION_STARTUP_TIMEOUT_MS,
      },
      SESSION_STARTUP_TIMEOUT_MS,
    );
    if (
      isRecord(response.raw) &&
      response.raw.ok === false &&
      response.raw.error?.code === "CONTROL_BUSY"
    ) {
      const takeover = await callRaw(
        "jetkvm_session_connect",
        {
          request_id: stableIdentifier(
            "req",
            `${runId}:recover:${randomUUID()}`,
          ),
          takeover: true,
          timeout_ms: SESSION_STARTUP_TIMEOUT_MS,
        },
        SESSION_STARTUP_TIMEOUT_MS,
      );
      if (!isRecord(takeover.raw) || takeover.raw.ok !== true) {
        throw new Error("Could not recover the live release session.");
      }
      updateState("jetkvm_session_connect", takeover.raw);
      return;
    }
    if (!isRecord(response.raw) || response.raw.ok !== true) {
      throw new Error("Could not establish the live release session.");
    }
    updateState("jetkvm_session_connect", response.raw);
  }

  async function reconnectSession() {
    await ensureSession();
    const response = await callRaw(
      "jetkvm_session_reconnect",
      {
        session_id: state.session.id,
        session_generation: state.session.generation,
        request_id: stableIdentifier(
          "req",
          `${runId}:baseline-reconnect:${randomUUID()}`,
        ),
        takeover: false,
        timeout_ms: 30_000,
      },
      30_000,
    );
    if (!isRecord(response.raw) || response.raw.ok !== true) {
      throw new Error("Could not reconnect the live baseline session.");
    }
    updateState("jetkvm_session_reconnect", response.raw);
    return response;
  }

  async function captureObservation() {
    await ensureSession();
    const response = await callRaw(
      "jetkvm_display_capture",
      {
        session_id: state.session.id,
        session_generation: state.session.generation,
        timeout_ms: 30_000,
      },
      30_000,
    );
    if (!isRecord(response.raw) || response.raw.ok !== true) {
      throw new Error("Could not capture a live release observation.");
    }
    updateState("jetkvm_display_capture", response.raw);
    return response;
  }

  async function releaseInput() {
    await ensureSession();
    const response = await callRaw(
      "jetkvm_input_release",
      {
        session_id: state.session.id,
        session_generation: state.session.generation,
        request_id: stableIdentifier("req", `${runId}:release:${randomUUID()}`),
        timeout_ms: 30_000,
      },
      30_000,
    );
    assertAuthoritativeRelease(response.raw);
    updateState("jetkvm_input_release", response.raw);
    return response;
  }

  async function ensureHostOnline() {
    const powerState = await rig.hostPowerState();
    if (powerState === "online") return;
    if (powerState !== "offline") {
      throw new Error(
        "Windows host power state is unknown; refusing to pulse the ATX power input.",
      );
    }
    if (
      typeof rig.consumeConfirmedOffline !== "function" ||
      rig.consumeConfirmedOffline() !== true
    ) {
      throw new Error(
        "Windows host physical-off proof was unavailable; refusing to pulse the ATX power input.",
      );
    }
    await ensureSession();
    const response = await callRaw(
      "jetkvm_power_control",
      {
        session_id: state.session.id,
        session_generation: state.session.generation,
        request_id: stableIdentifier(
          "req",
          `${runId}:power-on:${randomUUID()}`,
        ),
        action: "press_power",
        timeout_ms: 30_000,
      },
      30_000,
    );
    if (!isRecord(response.raw) || response.raw.ok !== true) {
      throw new Error("Power baseline restoration command failed.");
    }
    await rig.waitForHostOnline();
  }

  async function baselineFacts(phase) {
    await ensureHostOnline();
    if (phase === "before") {
      state.safeBaselineProven = false;
      await rig.pinUkLayout();
      await rig.resetNotepad();
    }
    const reconnect = await reconnectSession();
    const sessionResponse = await callRaw(
      "jetkvm_session_status",
      {
        session_id: state.session.id,
        session_generation: state.session.generation,
        timeout_ms: 30_000,
      },
      30_000,
    );
    if (!isRecord(sessionResponse.raw) || sessionResponse.raw.ok !== true) {
      throw new Error("Live release session status baseline failed.");
    }
    const capture = await captureObservation();
    const windows = await rig.captureSafeBaselineFacts();
    const generation = state.session.generation;
    const release = await releaseInput();
    const captureResult = isRecord(capture.raw?.result)
      ? capture.raw.result
      : {};
    const statusResult = isRecord(sessionResponse.raw.result)
      ? sessionResponse.raw.result
      : {};
    const facts = Object.freeze({
      candidate_revision: candidate.source.commit_sha,
      display: Object.freeze({
        source_width: captureResult.source_width,
        source_height: captureResult.source_height,
        image_width: captureResult.image_width,
        image_height: captureResult.image_height,
        rotation: captureResult.rotation,
        signal: statusResult.native_capture_facts?.signal?.value ?? "unknown",
        resolution:
          statusResult.native_capture_facts?.resolution?.value ?? null,
        hid: statusResult.hid ?? "unknown",
        decoded_video: statusResult.decoded_video ?? "unknown",
        web_rtc: statusResult.web_rtc ?? "unknown",
        rpc_reachability: statusResult.rpc_reachability ?? "unknown",
      }),
      layout: windows.layout,
      lock_keys: windows.lock_keys,
      atx: state.atxProof,
      browser: candidate.runtime.browser,
      fixture: windows.fixture,
      host_online: windows.host_online,
      held_input: heldInputFacts(release.raw?.result),
      transport_evidence: Object.freeze({
        reconnect: reconnect.evidence,
        status: sessionResponse.evidence,
        capture: capture.evidence,
        release: release.evidence,
      }),
      session_generation: generation,
    });
    if (phase === "before" && state.baseline === undefined)
      state.baseline = facts;
    return facts;
  }

  async function verifyTargetText(expected, label) {
    await captureObservation();
    const saveStartedAt = new Date().toISOString();
    const save = await callRaw(
      "jetkvm_input_keyboard",
      {
        session_id: state.session.id,
        session_generation: state.session.generation,
        observation_id: state.observation.id,
        request_id: stableIdentifier(
          "req",
          `${runId}:save:${label}:${randomUUID()}`,
        ),
        actions: [{ type: "chord", keys: ["ControlLeft", "KeyS"] }],
        timeout_ms: 30_000,
      },
      30_000,
    );
    if (!isRecord(save.raw) || save.raw.ok !== true) {
      throw new Error(`Could not save target-visible ${label}.`);
    }
    await rig.waitForSave(saveStartedAt);
    const saved = await rig.readRecvSnapshot();
    const comparison = rig.compareText(expected, saved.bytes);
    if (!comparison.equal) {
      throw new Error(`Target-visible ${label} did not match.`);
    }
    return Object.freeze({
      expected_sha256: sha256Bytes(expected),
      actual_sha256: sha256Bytes(saved.bytes),
      byte_length: saved.bytes.byteLength,
      save: save.evidence,
    });
  }

  async function startEmergencyInput() {
    await ensureSession();
    await rig.pinUkLayout();
    await rig.resetNotepad();
    await captureObservation();
    const heldKey = await callRaw(
      "jetkvm_input_keyboard",
      {
        session_id: state.session.id,
        session_generation: state.session.generation,
        observation_id: state.observation.id,
        request_id: stableIdentifier(
          "req",
          `${runId}:emergency-held-key:${randomUUID()}`,
        ),
        actions: [{ type: "key_down", key: "ShiftLeft" }],
        timeout_ms: 30_000,
      },
      30_000,
    );
    if (!isRecord(heldKey.raw) || heldKey.raw.ok !== true) {
      throw new Error(
        "Could not establish active held input for emergency release.",
      );
    }
    state.emergencyHeldKeyEvidence = heldKey.evidence;

    const observations = [];
    for (let index = 0; index < 4; index += 1) {
      await captureObservation();
      observations.push(state.observation.id);
    }
    const session = { ...state.session };
    const requests = [
      {
        label: "keyboard-macro",
        tool: "jetkvm_input_keyboard",
        observationId: observations[0],
        input: {
          actions: Array.from({ length: 64 }, () => ({
            type: "key_press",
            key: "KeyA",
          })),
        },
      },
      {
        label: "pointer-drag",
        tool: "jetkvm_input_mouse",
        observationId: observations[1],
        input: {
          actions: [
            {
              type: "drag",
              button: "left",
              path: Array.from({ length: 64 }, (_, index) => ({
                x: 40 + index,
                y: 50 + (index % 8),
              })),
            },
          ],
        },
      },
      {
        label: "wheel",
        tool: "jetkvm_input_mouse",
        observationId: observations[2],
        input: {
          actions: Array.from({ length: 16 }, (_, index) => ({
            type: "scroll",
            x: 100,
            y: 100,
            delta_y: index % 2 === 0 ? 1 : -1,
            delta_x: 0,
          })),
        },
      },
      {
        label: "reliable-paste",
        tool: "jetkvm_input_paste",
        observationId: observations[3],
        input: {
          text: "EmergencyReleaseRace".repeat(80),
        },
      },
    ];
    const producers = requests.map((request) => {
      const producer = {
        label: request.label,
        settled: false,
        promise: undefined,
      };
      producer.promise = callRaw(
        request.tool,
        {
          session_id: session.id,
          session_generation: session.generation,
          observation_id: request.observationId,
          request_id: stableIdentifier(
            "req",
            `${runId}:emergency:${request.label}:${randomUUID()}`,
          ),
          ...request.input,
          timeout_ms: 60_000,
        },
        60_000,
      )
        .catch((error) => ({ error: publicError(error) }))
        .finally(() => {
          producer.settled = true;
        });
      return producer;
    });
    state.emergencyProducers = producers;
    state.emergencyPaste = producers.find(
      (producer) => producer.label === "reliable-paste",
    ).promise;
  }

  async function executeFixtureStep(story, step) {
    const startedAt = Date.now();
    const call = step.call;
    if (step.id === "prepare-duplicate-session-connect-case") {
      if (state.session !== undefined) await releaseInput();
      return hardwareResult(startedAt, {
        story_id: story.id,
        step_id: step.id,
        call,
        result: "pass",
      });
    }
    if (/capture-stale-age/u.test(step.id)) {
      await captureObservation();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 31_000));
    } else if (
      /reconnect-and-capture|recover-for-next-tool|inspect-release-reconnect-and-capture/u.test(
        call,
      )
    ) {
      await releaseInput();
      await ensureSession();
      await captureObservation();
    } else if (
      /restore-and-prove|prove-ready-baseline|prepare-|safe-baseline|restore-baseline/u.test(
        call,
      )
    ) {
      await ensureHostOnline();
      await rig.pinUkLayout();
      await rig.resetNotepad();
      await ensureSession();
      await captureObservation();
    } else if (/save-and-read-correlated-terminal/u.test(call)) {
      if (state.pasteVerification === undefined) {
        throw new Error("Paste verification had no expected corpus.");
      }
      await verifyTargetText(state.pasteVerification, "paste corpus");
    } else if (/atx|power/u.test(call)) {
      await ensureHostOnline();
    }
    return hardwareResult(startedAt, {
      story_id: story.id,
      step_id: step.id,
      call,
      result: "pass",
    });
  }

  async function supplementalMouseActions() {
    const actions = [
      [{ type: "click", x: 40, y: 50, button: "left" }],
      [{ type: "double_click", x: 40, y: 50, button: "left" }],
      [
        {
          type: "drag",
          button: "left",
          path: [
            { x: 40, y: 50 },
            { x: 45, y: 55 },
          ],
        },
      ],
    ];
    const evidence = [];
    for (const actionSet of actions) {
      await captureObservation();
      const response = await callRaw(
        "jetkvm_input_mouse",
        {
          session_id: state.session.id,
          session_generation: state.session.generation,
          observation_id: state.observation.id,
          request_id: stableIdentifier(
            "req",
            `${runId}:mouse-extra:${randomUUID()}`,
          ),
          actions: actionSet,
          timeout_ms: 30_000,
        },
        30_000,
      );
      if (!isRecord(response.raw) || response.raw.ok !== true) {
        throw new Error("Supplemental mouse action failed.");
      }
      evidence.push(response.evidence);
    }
    return evidence;
  }

  async function supplementalUkKeyboard() {
    await rig.resetNotepad();
    await captureObservation();
    const actions = [
      { type: "chord", keys: ["ShiftLeft", "Digit2"] },
      { type: "chord", keys: ["ShiftLeft", "Quote"] },
      { type: "key_press", key: "Backslash" },
      { type: "key_press", key: "IntlBackslash" },
      { type: "chord", keys: ["ShiftLeft", "IntlBackslash"] },
      { type: "key_press", key: "Semicolon" },
      { type: "chord", keys: ["ShiftLeft", "Semicolon"] },
      { type: "chord", keys: ["ShiftLeft", "Slash"] },
    ];
    const response = await callRaw(
      "jetkvm_input_keyboard",
      {
        session_id: state.session.id,
        session_generation: state.session.generation,
        observation_id: state.observation.id,
        request_id: stableIdentifier(
          "req",
          `${runId}:uk-keyboard:${randomUUID()}`,
        ),
        actions,
        timeout_ms: 30_000,
      },
      30_000,
    );
    if (!isRecord(response.raw) || response.raw.ok !== true) {
      throw new Error("Supplemental UK physical-key action failed.");
    }
    const target = await verifyTargetText(
      '"@#\\|;:?',
      "UK physical-key corpus",
    );
    return Object.freeze({ tool: response.evidence, target });
  }

  async function supplementalNormalizationPaste() {
    await rig.resetNotepad();
    await captureObservation();
    const corpus = 'L1 @ " # £ \\ | <> ?\nL2 mixedCase 2" 3£';
    const response = await callRaw(
      "jetkvm_input_paste",
      {
        session_id: state.session.id,
        session_generation: state.session.generation,
        observation_id: state.observation.id,
        request_id: stableIdentifier(
          "req",
          `${runId}:normalization-paste:${randomUUID()}`,
        ),
        text: corpus,
        timeout_ms: 30_000,
      },
      30_000,
    );
    if (!isRecord(response.raw) || response.raw.ok !== true) {
      throw new Error(
        "Supplemental Reliable Paste normalization action failed.",
      );
    }
    const target = await verifyTargetText(
      corpus,
      "Reliable Paste normalization corpus",
    );
    return Object.freeze({ tool: response.evidence, target });
  }

  async function supplementalScroll(deltaY) {
    await captureObservation();
    const response = await callRaw(
      "jetkvm_input_mouse",
      {
        session_id: state.session.id,
        session_generation: state.session.generation,
        observation_id: state.observation.id,
        request_id: stableIdentifier(
          "req",
          `${runId}:scroll:${deltaY}:${randomUUID()}`,
        ),
        actions: [
          { type: "scroll", x: 40, y: 50, delta_y: deltaY, delta_x: 0 },
        ],
        timeout_ms: 30_000,
      },
      30_000,
    );
    if (!isRecord(response.raw) || response.raw.ok !== true) {
      throw new Error(`Supplemental scroll ${deltaY} failed.`);
    }
    return response.evidence;
  }

  async function executeHardwareStep(story, step) {
    if (step.tool === null) return executeFixtureStep(story, step);
    if (
      step.tool === "jetkvm_session_connect" &&
      (step.id === "connect-without-takeover" ||
        step.id === "authorized-takeover")
    ) {
      await ensureSession();
    }
    if (
      SESSION_TOOLS.has(step.tool) &&
      step.tool !== "jetkvm_session_connect"
    ) {
      await ensureSession();
    }
    const invalidWithoutObservation =
      /(?:old-observation|foreign-observation|stale-|schema|reject-(?:zero|fractional|overflow|horizontal))/u.test(
        step.id,
      );
    if (
      OBSERVATION_TOOLS.has(step.tool) &&
      state.observation === undefined &&
      !invalidWithoutObservation
    ) {
      await captureObservation();
    }
    if (step.id === "release-all-input") {
      await startEmergencyInput();
      state.emergencyPendingAtRelease = Object.fromEntries(
        state.emergencyProducers.map((producer) => [
          producer.label,
          !producer.settled,
        ]),
      );
    }
    if (step.id === "submit-correlated-terminal-paste") {
      state.pasteVerification = step.input.text;
    }
    const executed = await callStep(step);
    if (step.id === "capture-stale-age-observation") {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 31_000));
    }
    const extraEvidence = [];
    if (step.id === "consume-observation") {
      extraEvidence.push(...(await supplementalMouseActions()));
    }
    if (step.id === "send-physical-keys") {
      extraEvidence.push(await supplementalUkKeyboard());
    }
    if (step.id === "submit-correlated-terminal-paste") {
      extraEvidence.push(
        await verifyTargetText(
          state.pasteVerification,
          "canonical 91cps paste corpus",
        ),
      );
      extraEvidence.push(await supplementalNormalizationPaste());
    }
    if (step.id === "scroll-negative-bound") {
      extraEvidence.push(await supplementalScroll(-1));
    }
    if (step.id === "scroll-positive-bound") {
      extraEvidence.push(await supplementalScroll(1));
    }
    if (
      step.id === "release-all-input" &&
      state.emergencyProducers !== undefined
    ) {
      const releaseResult = executed.response?.raw?.result;
      if (
        !isRecord(releaseResult) ||
        releaseResult.keyboard_zero !== true ||
        releaseResult.pointer_zero !== true ||
        releaseResult.ordinary_leases_zero !== true ||
        releaseResult.deferred_producers_joined !== true ||
        releaseResult.generation_drained !== true ||
        releaseResult.paste_terminal !== "cancelled"
      ) {
        throw new Error(
          "Emergency release did not prove authoritative zero state.",
        );
      }
      const producerResults = await Promise.all(
        state.emergencyProducers.map(async (producer) => ({
          label: producer.label,
          result: await producer.promise,
        })),
      );
      const expectedLabels = [
        "keyboard-macro",
        "pointer-drag",
        "wheel",
        "reliable-paste",
      ];
      const producersWerePending = expectedLabels.every(
        (label) => state.emergencyPendingAtRelease?.[label] === true,
      );
      const malformedProducer = producerResults.find(
        ({ result }) =>
          isRecord(result.error) ||
          !isRecord(result.raw) ||
          typeof result.raw.ok !== "boolean",
      );
      const pasteResult = producerResults.find(
        ({ label }) => label === "reliable-paste",
      )?.result;
      if (
        !producersWerePending ||
        malformedProducer !== undefined ||
        !isRecord(pasteResult?.raw) ||
        pasteResult.raw.ok !== false
      ) {
        throw new Error(
          "Emergency release did not race and join every input producer.",
        );
      }
      extraEvidence.push({
        held_key: state.emergencyHeldKeyEvidence,
        pending_at_release: state.emergencyPendingAtRelease,
        producers: producerResults.map(({ label, result }) => ({
          label,
          evidence: result.evidence,
        })),
      });
      state.emergencyPaste = undefined;
      state.emergencyProducers = undefined;
      state.emergencyPendingAtRelease = undefined;
      state.emergencyHeldKeyEvidence = undefined;
    }
    if (
      step.tool === "jetkvm_power_control" &&
      isRecord(executed.response?.raw) &&
      executed.response.raw.ok === true &&
      executed.response.raw.result?.outcome === "applied"
    ) {
      state.atxProof = Object.freeze({
        extension: true,
        serial_ready:
          executed.response.raw.result?.serial_sequence_completed === true,
      });
      const action = step.input.action;
      if (action === "press_reset") await rig.waitForHostRestart();
      if (powerActionRequiresOfflineWait(action)) {
        await rig.waitForHostOffline({
          started_at: executed.startedAt,
          atx_led_observation:
            executed.response.raw.result?.atx_led_observation,
        });
      }
    }
    return hardwareResult(executed.startedAt, {
      story_id: story.id,
      step_id: step.id,
      input_sha256: executed.input_sha256,
      tool_evidence: executed.response?.evidence ?? {
        protocol_error: "INVALID_PARAMS",
      },
      supplemental_evidence: extraEvidence,
    });
  }

  function evidenceForAssertions(story, step, assignment) {
    const identities =
      assignment.assertion_ids ??
      executionResolver(story, step, assignment.mode);
    const evidence = [];
    for (const identity of identities) {
      if (identity.startsWith("focused:")) {
        const resolved = executionResolver.evidence.focused[identity];
        if (resolved === undefined)
          throw new Error(`Missing focused evidence ${identity}.`);
        evidence.push({ identity, ...resolved });
      } else if (identity.startsWith("scenario:")) {
        const resolved = executionResolver.evidence.scenarios[identity];
        if (resolved === undefined)
          throw new Error(`Missing scenario evidence ${identity}.`);
        evidence.push({ identity, ...resolved });
      } else if (identity.startsWith("controlled:")) {
        const resolved = controlledExecution[identity];
        if (resolved === undefined)
          throw new Error(`Missing controlled evidence ${identity}.`);
        evidence.push({ identity, ...resolved });
      } else {
        throw new Error(`Unknown release evidence identity ${identity}.`);
      }
    }
    return evidence;
  }

  return Object.freeze({
    state,
    async proveAtx() {
      const startedAt = Date.now();
      await ensureHostOnline();
      await ensureSession();
      const response = await callRaw(
        "jetkvm_power_control",
        {
          session_id: state.session.id,
          session_generation: state.session.generation,
          request_id: stableIdentifier("req", `${runId}:preflight-atx-reset`),
          action: "press_reset",
          timeout_ms: 30_000,
        },
        30_000,
      );
      if (
        !isRecord(response.raw) ||
        response.raw.ok !== true ||
        response.raw.result?.serial_sequence_completed !== true
      ) {
        throw new Error("ATX extension and serial readiness preflight failed.");
      }
      state.atxProof = Object.freeze({ extension: true, serial_ready: true });
      await rig.waitForHostRestart();
      await rig.pinUkLayout();
      await rig.resetNotepad();
      await releaseInput();
      return hardwareResult(startedAt, response.evidence);
    },
    async captureBaseline(_story, phase) {
      return baselineFacts(phase);
    },
    executeHardwareStep,
    async executeControlledStep(story, step, assignment) {
      const startedAt = Date.now();
      const evidence = evidenceForAssertions(story, step, assignment);
      return hardwareResult(startedAt, evidence);
    },
    async resolveLinkedStep(story, step, assignment) {
      const startedAt = Date.now();
      const evidence = evidenceForAssertions(story, step, assignment);
      return hardwareResult(startedAt, evidence);
    },
    async restore(_story, restore) {
      const startedAt = Date.now();
      if (restore.id === "release-input" || restore.id === "stop-paste") {
        await releaseInput();
      } else if (restore.id === "zero-held-input") {
        await releaseInput();
      } else if (restore.id === "close-story-session") {
        if (state.session !== undefined) await releaseInput();
      } else if (restore.id === "reset-fixture") {
        await ensureHostOnline();
        await rig.pinUkLayout();
        await rig.resetNotepad();
      } else if (restore.id === "restore-power-baseline") {
        await ensureHostOnline();
      } else {
        throw new Error(`Unknown restore action ${restore.id}.`);
      }
      return hardwareResult(startedAt, {
        restore_id: restore.id,
        result: "pass",
      });
    },
    async compareBaseline(_story, before, after) {
      return compareSafeBaselines(before, after);
    },
    async finalizeRun() {
      const startedAt = Date.now();
      const failures = [];
      let releaseEvidence;
      let baselineEvidence;
      try {
        releaseEvidence = (await releaseInput()).evidence;
      } catch (error) {
        failures.push(error);
      }
      const unfinishedProducers =
        state.emergencyProducers ??
        (state.emergencyPaste === undefined
          ? []
          : [{ label: "reliable-paste", promise: state.emergencyPaste }]);
      if (unfinishedProducers.length > 0) {
        try {
          const results = await Promise.all(
            unfinishedProducers.map(async (producer) => ({
              label: producer.label,
              result: await producer.promise,
            })),
          );
          if (
            results.some(
              ({ result }) =>
                isRecord(result.error) ||
                !isRecord(result.raw) ||
                typeof result.raw.ok !== "boolean",
            )
          ) {
            throw new Error(
              "Final input release did not join every active producer.",
            );
          }
        } catch (error) {
          failures.push(error);
        } finally {
          state.emergencyPaste = undefined;
          state.emergencyProducers = undefined;
          state.emergencyPendingAtRelease = undefined;
          state.emergencyHeldKeyEvidence = undefined;
        }
      }
      try {
        if (state.baseline === undefined) {
          throw new Error("No pre-run safe baseline was captured.");
        }
        await ensureHostOnline();
        await rig.pinUkLayout();
        await rig.resetNotepad();
        const after = await baselineFacts("after");
        const comparison = compareSafeBaselines(state.baseline, after);
        state.safeBaselineProven = true;
        baselineEvidence = comparison.evidence_sha256;
      } catch (error) {
        state.safeBaselineProven = false;
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Live hardware run finalization failed.",
        );
      }
      return hardwareResult(startedAt, {
        release: releaseEvidence,
        baseline_evidence_sha256: baselineEvidence,
        safe_baseline_proven: true,
      });
    },
  });
}

export async function verifyInstalledPackageIdentity(
  candidate,
  packageRoot,
  { installationRoot, candidateDirectory } = {},
) {
  packageRoot = resolve(packageRoot);
  installationRoot ??= resolve(packageRoot, "../../..");
  if (
    typeof candidateDirectory !== "string" ||
    candidateDirectory.length === 0
  ) {
    throw new Error("Candidate artifact directory is required.");
  }
  candidateDirectory = resolve(candidateDirectory);
  const packageJsonPath = resolve(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (
    packageJson.name !== candidate.package.name ||
    packageJson.version !== candidate.package.version
  ) {
    throw new Error(
      "Installed package identity did not match the frozen candidate.",
    );
  }
  const packageJsonSha256 = await sha256File(packageJsonPath);
  const packageTree = await buildDirectoryManifest(packageRoot);
  if (packageTree.sha256 !== candidate.artifact.package_tree_sha256) {
    throw new Error(
      "Installed package tree did not match the frozen candidate.",
    );
  }
  const installedStories = await buildDirectoryManifest(
    resolve(packageRoot, "dist/stories"),
    { include: (path) => path.endsWith(".json") },
  );
  const installedSchemas = await buildDirectoryManifest(
    resolve(packageRoot, "schemas"),
    { include: (path) => path.endsWith(".json") },
  );
  if (
    installedStories.sha256 !== candidate.source.story_manifest.sha256 ||
    installedStories.files.length !== candidate.source.story_manifest.count ||
    installedSchemas.sha256 !== candidate.source.schemas.sha256 ||
    installedSchemas.files.length !== candidate.source.schemas.count
  ) {
    throw new Error(
      "Installed contracts did not match the frozen source manifests.",
    );
  }
  const consumerPackagePath = resolve(installationRoot, "package.json");
  const consumerPackageLockPath = resolve(
    installationRoot,
    "package-lock.json",
  );
  const [
    consumerPackageSha256,
    consumerPackageLockSha256,
    shippedConsumerPackageSha256,
    shippedConsumerPackageLockSha256,
  ] = await Promise.all([
    sha256File(consumerPackagePath),
    sha256File(consumerPackageLockPath),
    sha256File(
      resolve(candidateDirectory, candidate.installation.package_json.filename),
    ),
    sha256File(
      resolve(candidateDirectory, candidate.installation.package_lock.filename),
    ),
  ]);
  if (
    consumerPackageSha256 !== candidate.installation.package_json.sha256 ||
    shippedConsumerPackageSha256 !==
      candidate.installation.package_json.sha256 ||
    consumerPackageLockSha256 !== candidate.installation.package_lock.sha256 ||
    shippedConsumerPackageLockSha256 !==
      candidate.installation.package_lock.sha256
  ) {
    throw new Error(
      "Installed or shipped consumer lock artifacts drifted from the candidate.",
    );
  }
  const consumerLock = JSON.parse(
    await readFile(consumerPackageLockPath, "utf8"),
  );
  const productionResolutionSha256 = sha256Canonical(
    buildProductionResolution(consumerLock, [candidate.package.name]),
  );
  if (
    productionResolutionSha256 !==
    candidate.installation.production_resolution_sha256
  ) {
    throw new Error(
      "Installed production dependency resolution drifted from the candidate.",
    );
  }
  const installationTree = await buildDirectoryManifest(
    resolve(installationRoot, "node_modules"),
    { excludeSymlink: isGeneratedInstalledBinLink },
  );
  if (
    installationTree.sha256 !== candidate.installation.node_modules_tree_sha256
  ) {
    throw new Error(
      "Installed node_modules tree did not match the frozen candidate.",
    );
  }
  return Object.freeze({
    package_name: packageJson.name,
    package_version: packageJson.version,
    package_json_sha256: packageJsonSha256,
    package_tree_sha256: packageTree.sha256,
    installed_story_manifest_sha256: installedStories.sha256,
    installed_schemas_sha256: installedSchemas.sha256,
    consumer_package_sha256: consumerPackageSha256,
    consumer_package_lock_sha256: consumerPackageLockSha256,
    production_resolution_sha256: productionResolutionSha256,
    node_modules_tree_sha256: installationTree.sha256,
  });
}

export function assertPrivateEnvironmentFile(stat, path) {
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Protected environment file is not owner-only: ${path}`);
  }
}

export function assertPublicIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is not a valid public identifier.`);
  }
  return value;
}
