import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import nodeDataChannel, {
  type DataChannel,
  type DescriptionType,
  type PeerConnection,
} from "node-datachannel";
import WebSocket from "ws";

import { buildSaveChordCommand } from "./hidtype.js";
import { checkSaveLanded } from "./rig.js";
import { kvmTarget, runSshCommand, type RigEnv } from "./ssh.js";

export const HID_RPC_MESSAGE_TYPES = {
  Handshake: 0x01,
  KeyboardReport: 0x02,
  KeyboardMacroReport: 0x07,
  KeyboardMacroState: 0x34,
} as const;

export const HID_RPC_VERSION = 0x01;
export const DEFAULT_HIDRPC_DELAY_MS = 6;
export const DEFAULT_HIDRPC_MAX_STEPS_PER_REPORT = 128;
export const DEFAULT_HIDRPC_TIMEOUT_MS = 120_000;

const ZERO_KEYS = Object.freeze([0, 0, 0, 0, 0, 0] as const);

const HID_KEYS = {
  Backquote: 0x35,
  Backslash: 0x31,
  Delete: 0x4c,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Comma: 0x36,
  Digit0: 0x27,
  Digit1: 0x1e,
  Digit2: 0x1f,
  Digit3: 0x20,
  Digit4: 0x21,
  Digit5: 0x22,
  Digit6: 0x23,
  Digit7: 0x24,
  Digit8: 0x25,
  Digit9: 0x26,
  Enter: 0x28,
  Equal: 0x2e,
  IntlBackslash: 0x64,
  KeyA: 0x04,
  KeyB: 0x05,
  KeyC: 0x06,
  KeyD: 0x07,
  KeyE: 0x08,
  KeyF: 0x09,
  KeyG: 0x0a,
  KeyH: 0x0b,
  KeyI: 0x0c,
  KeyJ: 0x0d,
  KeyK: 0x0e,
  KeyL: 0x0f,
  KeyM: 0x10,
  KeyN: 0x11,
  KeyO: 0x12,
  KeyP: 0x13,
  KeyQ: 0x14,
  KeyR: 0x15,
  KeyS: 0x16,
  KeyT: 0x17,
  KeyU: 0x18,
  KeyV: 0x19,
  KeyW: 0x1a,
  KeyX: 0x1b,
  KeyY: 0x1c,
  KeyZ: 0x1d,
  Minus: 0x2d,
  Period: 0x37,
  Quote: 0x34,
  Semicolon: 0x33,
  Slash: 0x38,
  Space: 0x2c,
  Tab: 0x2b,
} as const;

const MODIFIERS = {
  ControlLeft: 0x01,
  ShiftLeft: 0x02,
  AltRight: 0x40,
} as const;

type HidKeyName = keyof typeof HID_KEYS;

interface CharMapping {
  key: HidKeyName;
  shift?: boolean;
  altRight?: boolean;
}

const UK_CHAR_MAP: Record<string, CharMapping | undefined> = {
  A: { key: "KeyA", shift: true },
  B: { key: "KeyB", shift: true },
  C: { key: "KeyC", shift: true },
  D: { key: "KeyD", shift: true },
  E: { key: "KeyE", shift: true },
  F: { key: "KeyF", shift: true },
  G: { key: "KeyG", shift: true },
  H: { key: "KeyH", shift: true },
  I: { key: "KeyI", shift: true },
  J: { key: "KeyJ", shift: true },
  K: { key: "KeyK", shift: true },
  L: { key: "KeyL", shift: true },
  M: { key: "KeyM", shift: true },
  N: { key: "KeyN", shift: true },
  O: { key: "KeyO", shift: true },
  P: { key: "KeyP", shift: true },
  Q: { key: "KeyQ", shift: true },
  R: { key: "KeyR", shift: true },
  S: { key: "KeyS", shift: true },
  T: { key: "KeyT", shift: true },
  U: { key: "KeyU", shift: true },
  V: { key: "KeyV", shift: true },
  W: { key: "KeyW", shift: true },
  X: { key: "KeyX", shift: true },
  Y: { key: "KeyY", shift: true },
  Z: { key: "KeyZ", shift: true },
  a: { key: "KeyA" },
  b: { key: "KeyB" },
  c: { key: "KeyC" },
  d: { key: "KeyD" },
  e: { key: "KeyE" },
  f: { key: "KeyF" },
  g: { key: "KeyG" },
  h: { key: "KeyH" },
  i: { key: "KeyI" },
  j: { key: "KeyJ" },
  k: { key: "KeyK" },
  l: { key: "KeyL" },
  m: { key: "KeyM" },
  n: { key: "KeyN" },
  o: { key: "KeyO" },
  p: { key: "KeyP" },
  q: { key: "KeyQ" },
  r: { key: "KeyR" },
  s: { key: "KeyS" },
  t: { key: "KeyT" },
  u: { key: "KeyU" },
  v: { key: "KeyV" },
  w: { key: "KeyW" },
  x: { key: "KeyX" },
  y: { key: "KeyY" },
  z: { key: "KeyZ" },
  "1": { key: "Digit1" },
  "!": { key: "Digit1", shift: true },
  "2": { key: "Digit2" },
  '"': { key: "Digit2", shift: true },
  "3": { key: "Digit3" },
  "£": { key: "Digit3", shift: true },
  "4": { key: "Digit4" },
  $: { key: "Digit4", shift: true },
  "€": { key: "Digit4", altRight: true },
  "5": { key: "Digit5" },
  "%": { key: "Digit5", shift: true },
  "6": { key: "Digit6" },
  "^": { key: "Digit6", shift: true },
  "7": { key: "Digit7" },
  "&": { key: "Digit7", shift: true },
  "8": { key: "Digit8" },
  "*": { key: "Digit8", shift: true },
  "9": { key: "Digit9" },
  "(": { key: "Digit9", shift: true },
  "0": { key: "Digit0" },
  ")": { key: "Digit0", shift: true },
  "-": { key: "Minus" },
  _: { key: "Minus", shift: true },
  "=": { key: "Equal" },
  "+": { key: "Equal", shift: true },
  "'": { key: "Quote" },
  "@": { key: "Quote", shift: true },
  ",": { key: "Comma" },
  "<": { key: "Comma", shift: true },
  "/": { key: "Slash" },
  "?": { key: "Slash", shift: true },
  ".": { key: "Period" },
  ">": { key: "Period", shift: true },
  ";": { key: "Semicolon" },
  ":": { key: "Semicolon", shift: true },
  "[": { key: "BracketLeft" },
  "{": { key: "BracketLeft", shift: true },
  "]": { key: "BracketRight" },
  "}": { key: "BracketRight", shift: true },
  "#": { key: "Backslash" },
  "~": { key: "Backslash", shift: true },
  "`": { key: "Backquote" },
  "¬": { key: "Backquote", shift: true },
  "\\": { key: "IntlBackslash" },
  "|": { key: "IntlBackslash", shift: true },
  " ": { key: "Space" },
  "\n": { key: "Enter" },
  "\t": { key: "Tab" },
};

export interface KeyboardMacroStep {
  modifier: number;
  keys: number[];
  delay: number;
}

export interface KeyboardMacroState {
  state: boolean;
  isPaste: boolean;
  failed: boolean;
}

export type ParsedHidRpcMessage =
  | { type: "handshake"; version: number }
  | ({ type: "keyboard-macro-state" } & KeyboardMacroState)
  | { type: "unknown"; messageType: number; payload: Buffer };

export interface BuildKeyboardMacroOptions {
  delayMs?: number;
}

export interface HidRpcRunOptions extends BuildKeyboardMacroOptions {
  host?: string;
  timeoutMs?: number | undefined;
  maxStepsPerReport?: number | undefined;
  clearBefore?: boolean;
  saveAfter?: boolean;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: number) => void) | undefined;
}

export interface HidRpcRunResult {
  handshakeAck: boolean;
  protocolVersion: number;
  completed: boolean;
  failed: boolean;
  stepCount: number;
  batchCount: number;
  hidOutputReports: number;
  stateMessages: KeyboardMacroState[];
  saved: boolean;
  durationMs: number;
}

interface LoginResponse {
  cookie: string;
}

export function buildKeyboardMacroStepsForText(
  text: string,
  options: BuildKeyboardMacroOptions = {},
): KeyboardMacroStep[] {
  const delayMs = options.delayMs ?? DEFAULT_HIDRPC_DELAY_MS;
  assertUint16(delayMs, "delayMs");
  const resetDelayMs = delayMs || 25;
  const steps: KeyboardMacroStep[] = [];

  for (const char of text.normalize("NFC")) {
    const mapping = UK_CHAR_MAP[char];
    if (mapping === undefined) {
      throw new Error(`unsupported UK HIDRPC character ${formatUnsupportedChar(char)}`);
    }

    const modifier = modifierMask(mapping);
    const key = HID_KEYS[mapping.key];
    const keys = padKeys([key]);
    const pressHoldMs = modifier > 0 ? 10 : 5;
    steps.push({ modifier, keys, delay: pressHoldMs });
    steps.push({ modifier: 0, keys: [...ZERO_KEYS], delay: resetDelayMs });
  }

  return steps;
}

export function buildClearDocumentMacroSteps(): KeyboardMacroStep[] {
  return [
    { modifier: 0, keys: [...ZERO_KEYS], delay: 0 },
    { modifier: MODIFIERS.ControlLeft, keys: padKeys([HID_KEYS.KeyA]), delay: 30 },
    { modifier: 0, keys: [...ZERO_KEYS], delay: 50 },
    { modifier: 0, keys: padKeys([HID_KEYS.Delete]), delay: 30 },
    { modifier: 0, keys: [...ZERO_KEYS], delay: 300 },
    { modifier: 0, keys: [...ZERO_KEYS], delay: 0 },
  ];
}

export function chunkKeyboardMacroSteps(
  steps: readonly KeyboardMacroStep[],
  maxStepsPerReport = DEFAULT_HIDRPC_MAX_STEPS_PER_REPORT,
): KeyboardMacroStep[][] {
  if (!Number.isInteger(maxStepsPerReport) || maxStepsPerReport <= 0) {
    throw new Error("maxStepsPerReport must be a positive integer");
  }
  const chunks: KeyboardMacroStep[][] = [];
  for (let offset = 0; offset < steps.length; offset += maxStepsPerReport) {
    chunks.push(steps.slice(offset, offset + maxStepsPerReport).map(cloneStep));
  }
  return chunks;
}

export function marshalKeyboardMacroReport(
  steps: readonly KeyboardMacroStep[],
  isPaste = true,
): Buffer {
  if (steps.length > 0xffffffff) {
    throw new Error("step count exceeds uint32 range");
  }
  const data = Buffer.alloc(6 + steps.length * 9);
  data[0] = HID_RPC_MESSAGE_TYPES.KeyboardMacroReport;
  data[1] = isPaste ? 1 : 0;
  data.writeUInt32BE(steps.length, 2);

  let offset = 6;
  for (const step of steps) {
    assertUint8(step.modifier, "modifier");
    assertUint16(step.delay, "delay");
    if (step.keys.length !== 6) {
      throw new Error(`macro step keys must contain 6 bytes, got ${step.keys.length}`);
    }
    data[offset] = step.modifier;
    for (let index = 0; index < 6; index += 1) {
      const key = step.keys[index];
      assertUint8(key, `keys[${index}]`);
      data[offset + 1 + index] = key;
    }
    data.writeUInt16BE(step.delay, offset + 7);
    offset += 9;
  }

  return data;
}

export function marshalKeyboardReport(modifier: number, keys: readonly number[]): Buffer {
  const padded = padKeys(keys);
  const data = Buffer.alloc(8);
  data[0] = HID_RPC_MESSAGE_TYPES.KeyboardReport;
  data[1] = modifier;
  for (let index = 0; index < 6; index += 1) {
    data[index + 2] = padded[index] ?? 0;
  }
  return data;
}

export function parseHidRpcMessage(data: Buffer | Uint8Array | ArrayBuffer): ParsedHidRpcMessage {
  const buffer = Buffer.isBuffer(data)
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data);
  if (buffer.length < 1) {
    throw new Error("empty HIDRPC message");
  }

  const messageType = buffer[0] ?? 0;
  const payload = buffer.subarray(1);
  switch (messageType) {
    case HID_RPC_MESSAGE_TYPES.Handshake:
      if (payload.length < 1) {
        throw new Error("handshake payload missing version");
      }
      return { type: "handshake", version: payload[0] ?? 0 };
    case HID_RPC_MESSAGE_TYPES.KeyboardMacroState:
      if (payload.length < 2) {
        throw new Error("keyboard macro state payload must contain state and isPaste");
      }
      return {
        type: "keyboard-macro-state",
        state: payload[0] === 1,
        isPaste: payload[1] === 1,
        failed: payload[2] === 1,
      };
    default:
      return { type: "unknown", messageType, payload };
  }
}

export function decodeCliText(text: string): string {
  let decoded = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      decoded += "\\";
      continue;
    }
    index += 1;
    switch (next) {
      case "n":
        decoded += "\n";
        break;
      case "r":
        decoded += "\r";
        break;
      case "t":
        decoded += "\t";
        break;
      case "\\":
        decoded += "\\";
        break;
      default:
        decoded += next;
        break;
    }
  }
  return decoded;
}

export function buildHidRpcSignalingUrl(host: string): string {
  const base = parseHostUrl(host);
  base.protocol = base.protocol === "https:" || base.protocol === "wss:" ? "wss:" : "ws:";
  base.pathname = "/webrtc/signaling/client";
  base.search = "";
  base.hash = "";
  return base.toString();
}

export function buildHttpBaseUrl(host: string): string {
  const base = parseHostUrl(host);
  base.protocol = base.protocol === "https:" || base.protocol === "wss:" ? "https:" : "http:";
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  return base.toString().replace(/\/$/, "");
}

export async function loadTextForHidRpc(args: { text?: string | undefined; textFile?: string | undefined }): Promise<string> {
  if (args.text !== undefined) {
    return decodeCliText(args.text);
  }
  if (args.textFile !== undefined) {
    return readFile(args.textFile, "utf8");
  }
  throw new Error("missing --text or --text-file");
}

export async function loginLocal(host: string, password: string): Promise<LoginResponse> {
  const url = `${buildHttpBaseUrl(host)}/auth/login-local`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error(`login-local failed with HTTP ${response.status}`);
  }
  const cookie = extractAuthCookie(response.headers);
  if (cookie === undefined) {
    throw new Error("login-local succeeded but did not return an authToken cookie");
  }
  return { cookie };
}

export async function runHidRpcText(env: RigEnv, text: string, options: HidRpcRunOptions = {}): Promise<HidRpcRunResult> {
  const host = options.host ?? env.KVM_PRIMARY;
  const password = env.JETKVM_PASSWORD;
  if (password === undefined || password.length === 0) {
    throw new Error("JETKVM_PASSWORD is required in .env.paste-rig for HIDRPC login");
  }

  const startedAtUtc = new Date().toISOString();
  const startedAtMs = Date.now();
  const textSteps = buildKeyboardMacroStepsForText(text, options);
  const steps = options.clearBefore === true ? [...buildClearDocumentMacroSteps(), ...textSteps] : textSteps;
  const batches = chunkKeyboardMacroSteps(steps, options.maxStepsPerReport);
  const login = await loginLocal(host, password);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HIDRPC_TIMEOUT_MS;
  const result = await runHidRpcBatches({
    host,
    cookie: login.cookie,
    batches,
    timeoutMs,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  let saved = false;
  let hidOutputReports = steps.length;
  if (options.saveAfter === true) {
    await saveRecvTxtViaHid(env, startedAtUtc);
    saved = true;
    hidOutputReports += 2;
  }

  return {
    ...result,
    stepCount: steps.length,
    batchCount: batches.length,
    hidOutputReports,
    saved,
    durationMs: Date.now() - startedAtMs,
  };
}

async function runHidRpcBatches(args: {
  host: string;
  cookie: string;
  batches: readonly KeyboardMacroStep[][];
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: number) => void) | undefined;
}): Promise<Omit<HidRpcRunResult, "stepCount" | "batchCount" | "hidOutputReports" | "saved" | "durationMs">> {
  if (args.batches.length === 0) {
    return {
      handshakeAck: false,
      protocolVersion: 0,
      completed: true,
      failed: false,
      stateMessages: [],
    };
  }

  return new Promise((resolve, reject) => {
    let ws: WebSocket | undefined;
    let pc: PeerConnection | undefined;
    let hidChannel: DataChannel | undefined;
    let settled = false;
    let handshakeAck = false;
    let protocolVersion = 0;
    let seenPasteStart = false;
    let sentBatches = false;
    const stateMessages: KeyboardMacroState[] = [];

    const timeout = setTimeout(() => {
      fail(new Error(`HIDRPC run timed out after ${args.timeoutMs}ms`));
    }, args.timeoutMs);

    const abortHandler = () => {
      fail(args.signal?.reason instanceof Error ? args.signal.reason : new Error("aborted"));
    };
    args.signal?.addEventListener("abort", abortHandler, { once: true });

    const cleanup = () => {
      clearTimeout(timeout);
      args.signal?.removeEventListener("abort", abortHandler);
      try {
        hidChannel?.close();
      } catch {
        // best effort
      }
      try {
        pc?.close();
      } catch {
        // best effort
      }
      try {
        ws?.close();
      } catch {
        // best effort
      }
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const complete = (failed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        handshakeAck,
        protocolVersion,
        completed: !failed,
        failed,
        stateMessages,
      });
    };

    const sendBatches = () => {
      if (sentBatches || hidChannel === undefined) {
        return;
      }
      sentBatches = true;
      args.onProgress?.(0);
      for (let index = 0; index < args.batches.length; index += 1) {
        const batch = args.batches[index];
        if (batch === undefined) {
          continue;
        }
        const sent = hidChannel.sendMessageBinary(marshalKeyboardMacroReport(batch, true));
        if (!sent) {
          fail(new Error(`failed to send HIDRPC macro batch ${index + 1}`));
          return;
        }
        args.onProgress?.((index + 1) / args.batches.length);
      }
    };

    const handleHidMessage = (message: string | Buffer | ArrayBuffer) => {
      if (typeof message === "string") {
        return;
      }
      let parsed: ParsedHidRpcMessage;
      try {
        parsed = parseHidRpcMessage(message);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (parsed.type === "handshake") {
        handshakeAck = true;
        protocolVersion = parsed.version;
        sendBatches();
        return;
      }

      if (parsed.type !== "keyboard-macro-state" || !parsed.isPaste) {
        return;
      }
      stateMessages.push({
        state: parsed.state,
        isPaste: parsed.isPaste,
        failed: parsed.failed,
      });
      if (parsed.state) {
        seenPasteStart = true;
        return;
      }
      if (seenPasteStart) {
        complete(parsed.failed);
      }
    };

    const setupPeerConnection = () => {
      pc = new nodeDataChannel.PeerConnection("jetkvm-paste-harness", { iceServers: [] });
      pc.onLocalDescription((sdp, type) => {
        ws?.send(
          JSON.stringify({
            type: "offer",
            data: { sd: Buffer.from(JSON.stringify({ type, sdp }), "utf8").toString("base64") },
          }),
        );
      });
      pc.onLocalCandidate((candidate, mid) => {
        if (!candidate) {
          return;
        }
        ws?.send(
          JSON.stringify({
            type: "new-ice-candidate",
            data: {
              candidate,
              sdpMid: mid,
              sdpMLineIndex: Number.isFinite(Number(mid)) ? Number(mid) : 0,
            },
          }),
        );
      });
      pc.onStateChange((state) => {
        if (state === "failed" || state === "closed") {
          fail(new Error(`peer connection ${state}`));
        }
      });

      pc.createDataChannel("rpc");
      hidChannel = pc.createDataChannel("hidrpc");
      hidChannel.onOpen(() => {
        const sent = hidChannel?.sendMessageBinary(Buffer.from([HID_RPC_MESSAGE_TYPES.Handshake, HID_RPC_VERSION]));
        if (!sent) {
          fail(new Error("failed to send HIDRPC handshake"));
        }
      });
      hidChannel.onMessage(handleHidMessage);
      hidChannel.onError((error) => fail(new Error(`hidrpc data channel error: ${error}`)));
      hidChannel.onClosed(() => {
        if (!settled) {
          fail(new Error("hidrpc data channel closed before completion"));
        }
      });

      pc.setLocalDescription("offer" as DescriptionType);
    };

    ws = new WebSocket(buildHidRpcSignalingUrl(args.host), {
      headers: { cookie: args.cookie },
    });
    ws.on("open", setupPeerConnection);
    ws.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    ws.on("close", () => {
      if (!settled) {
        fail(new Error("signaling websocket closed before completion"));
      }
    });
    ws.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as {
          type?: string;
          data?: unknown;
          error?: unknown;
        };
        if (payload.error !== undefined) {
          fail(new Error(`signaling error: ${String(payload.error)}`));
          return;
        }
        if (payload.type === "answer") {
          const sd = decodeSessionDescription(payload.data);
          pc?.setRemoteDescription(sd.sdp, sd.type as DescriptionType);
        } else if (payload.type === "new-ice-candidate") {
          const candidate = decodeIceCandidate(payload.data);
          if (candidate !== undefined) {
            pc?.addRemoteCandidate(candidate.candidate, candidate.mid);
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function saveRecvTxtViaHid(env: RigEnv, startedAtUtc: string): Promise<void> {
  const saveResult = await runSshCommand(kvmTarget(env.KVM_PRIMARY), buildSaveChordCommand(), {
    timeoutMs: 10_000,
  });
  if (saveResult.exitCode !== 0) {
    throw new Error(`failed to save recv.txt via HID: ${saveResult.stderr || saveResult.stdout}`);
  }
  const saveLanded = await checkSaveLanded(startedAtUtc, env);
  if (saveLanded.ok === false || saveLanded.saveLanded === false) {
    throw new Error(`recv.txt save did not land: ${JSON.stringify(saveLanded)}`);
  }
}

function decodeSessionDescription(value: unknown): { type: string; sdp: string } {
  if (typeof value !== "string") {
    throw new Error("answer message data must be a base64 session description");
  }
  const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as {
    type?: unknown;
    sdp?: unknown;
  };
  if (typeof parsed.type !== "string" || typeof parsed.sdp !== "string") {
    throw new Error("answer session description is missing type or sdp");
  }
  return { type: parsed.type, sdp: parsed.sdp };
}

function decodeIceCandidate(value: unknown): { candidate: string; mid: string } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const candidate = record.candidate;
  if (typeof candidate !== "string" || candidate.length === 0) {
    return undefined;
  }
  const mid = typeof record.sdpMid === "string" ? record.sdpMid : "0";
  return { candidate, mid };
}

function extractAuthCookie(headers: Headers): string | undefined {
  const headerWithGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headerWithGetSetCookie.getSetCookie?.() ?? [];
  const fallback = headers.get("set-cookie");
  if (fallback !== null) {
    cookies.push(fallback);
  }

  for (const cookie of cookies) {
    const match = /(?:^|,\s*)(authToken=[^;,]+)/.exec(cookie);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function parseHostUrl(host: string): URL {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    return new URL(host);
  }
  return new URL(`http://${host}`);
}

function modifierMask(mapping: CharMapping): number {
  let mask = 0;
  if (mapping.shift) {
    mask += MODIFIERS.ShiftLeft;
  }
  if (mapping.altRight) {
    mask += MODIFIERS.AltRight;
  }
  return mask;
}

function padKeys(keys: readonly number[]): number[] {
  if (keys.length > 6) {
    throw new Error(`HID keyboard report supports at most 6 keys, got ${keys.length}`);
  }
  const padded = [...keys];
  while (padded.length < 6) {
    padded.push(0);
  }
  for (let index = 0; index < padded.length; index += 1) {
    assertUint8(padded[index], `keys[${index}]`);
  }
  return padded;
}

function cloneStep(step: KeyboardMacroStep): KeyboardMacroStep {
  return {
    modifier: step.modifier,
    keys: [...step.keys],
    delay: step.delay,
  };
}

function assertUint8(value: number | undefined, field: string): asserts value is number {
  if (value === undefined || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${field} must be a uint8 byte`);
  }
}

function assertUint16(value: number | undefined, field: string): asserts value is number {
  if (value === undefined || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${field} must be a uint16 value`);
  }
}

function formatUnsupportedChar(char: string): string {
  const codePoint = char.codePointAt(0);
  return `${JSON.stringify(char)}${codePoint === undefined ? "" : ` (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})`}`;
}
