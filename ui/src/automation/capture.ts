import type { AutomationBridgeErrorCode, CaptureBridgeRequest } from "./protocol";

export interface DecodedVideoSource {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly readyState: number;
  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback(handle: number): void;
}

export interface CaptureCanvasContext {
  drawImage(
    source: DecodedVideoSource,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    destinationWidth: number,
    destinationHeight: number,
  ): void;
}

export interface CaptureCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): CaptureCanvasContext | null;
  toBlob(callback: BlobCallback, type?: string, quality?: number): void;
}

export interface FrameCaptureDependencies {
  readonly createCanvas?: () => CaptureCanvas;
  readonly digest?: (bytes: Uint8Array) => Promise<string>;
  readonly monotonicNow?: () => number;
  readonly nowIso?: () => string;
  readonly verify: () => void;
  readonly signal?: AbortSignal;
}

export interface CapturedFrame {
  readonly frame_sequence: number;
  readonly captured_at: string;
  readonly source_width: number;
  readonly source_height: number;
  readonly image_width: number;
  readonly image_height: number;
  readonly rotation: 0;
  readonly geometry: {
    readonly x: 0;
    readonly y: 0;
    readonly width: number;
    readonly height: number;
  };
  readonly format: "jpeg" | "png";
  readonly mime_type: "image/jpeg" | "image/png";
  readonly byte_length: number;
  readonly sha256: string;
  readonly base64: string;
}

export class FrameCaptureFailure extends Error {
  readonly code: AutomationBridgeErrorCode;

  constructor(code: AutomationBridgeErrorCode) {
    super(code);
    this.name = "FrameCaptureFailure";
    this.code = code;
  }
}

const JPEG_MAX_BYTES = 2 * 1024 * 1024;
const PNG_MAX_BYTES = 8 * 1024 * 1024;

function defaultCreateCanvas(): CaptureCanvas {
  return document.createElement("canvas") as unknown as CaptureCanvas;
}

async function defaultDigest(bytes: Uint8Array): Promise<string> {
  const ownedBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", ownedBytes.buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

function ensurePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export async function captureFreshFrame(
  video: DecodedVideoSource,
  request: CaptureBridgeRequest,
  frameSequence: number,
  dependencies: FrameCaptureDependencies,
): Promise<CapturedFrame> {
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const nowIso = dependencies.nowIso ?? (() => new Date().toISOString());
  const deadline = monotonicNow() + request.timeout_ms;
  const ensureTime = (code: AutomationBridgeErrorCode = "DEADLINE_EXCEEDED") => {
    if (dependencies.signal?.aborted) throw new FrameCaptureFailure("CANCELLED");
    if (monotonicNow() >= deadline) throw new FrameCaptureFailure(code);
  };

  if (
    !ensurePositiveInteger(request.timeout_ms) ||
    !ensurePositiveInteger(request.max_width) ||
    !ensurePositiveInteger(request.max_height) ||
    (request.format !== "jpeg" && request.format !== "png") ||
    !ensurePositiveInteger(frameSequence) ||
    video.readyState < 2 ||
    !ensurePositiveInteger(video.videoWidth) ||
    !ensurePositiveInteger(video.videoHeight) ||
    typeof video.requestVideoFrameCallback !== "function"
  ) {
    throw new FrameCaptureFailure("CAPTURE_FAILED");
  }

  dependencies.verify();
  ensureTime();
  const freshFrame = Promise.withResolvers<void>();
  let frameHandle = 0;
  const onAbort = () => {
    video.cancelVideoFrameCallback(frameHandle);
    freshFrame.reject(new FrameCaptureFailure("CANCELLED"));
  };
  dependencies.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => {
      video.cancelVideoFrameCallback(frameHandle);
      freshFrame.reject(new FrameCaptureFailure("VIDEO_STALLED"));
    },
    Math.max(0, deadline - monotonicNow()),
  );
  frameHandle = video.requestVideoFrameCallback((_now, metadata) => {
    if (
      (typeof metadata.presentedFrames !== "number" || metadata.presentedFrames <= 0) &&
      (typeof metadata.mediaTime !== "number" || metadata.mediaTime < 0)
    ) {
      freshFrame.reject(new FrameCaptureFailure("VIDEO_STALLED"));
      return;
    }
    freshFrame.resolve();
  });

  try {
    await freshFrame.promise;
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", onAbort);
  }
  ensureTime("VIDEO_STALLED");
  dependencies.verify();

  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!ensurePositiveInteger(sourceWidth) || !ensurePositiveInteger(sourceHeight)) {
    throw new FrameCaptureFailure("CAPTURE_FAILED");
  }
  const scale = Math.min(1, request.max_width / sourceWidth, request.max_height / sourceHeight);
  const imageWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const imageHeight = Math.max(1, Math.floor(sourceHeight * scale));
  const canvas = (dependencies.createCanvas ?? defaultCreateCanvas)();
  canvas.width = imageWidth;
  canvas.height = imageHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new FrameCaptureFailure("CAPTURE_FAILED");
  context.drawImage(video, 0, 0, sourceWidth, sourceHeight, 0, 0, imageWidth, imageHeight);

  const expectedMime = request.format === "jpeg" ? "image/jpeg" : "image/png";
  const blobResult = Promise.withResolvers<Blob | null>();
  canvas.toBlob(blobResult.resolve, expectedMime, request.format === "jpeg" ? 0.88 : undefined);
  const blob = await blobResult.promise;
  ensureTime();
  dependencies.verify();
  if (!blob || blob.size === 0) throw new FrameCaptureFailure("CAPTURE_FAILED");
  if (blob.type !== expectedMime) throw new FrameCaptureFailure("MIME_MISMATCH");
  const maxBytes = request.format === "jpeg" ? JPEG_MAX_BYTES : PNG_MAX_BYTES;
  if (blob.size > maxBytes) throw new FrameCaptureFailure("CAPTURE_TOO_LARGE");

  const bytes = new Uint8Array(await blob.arrayBuffer());
  ensureTime();
  if (bytes.byteLength !== blob.size || bytes.byteLength === 0) {
    throw new FrameCaptureFailure("CAPTURE_FAILED");
  }
  const sha256 = await (dependencies.digest ?? defaultDigest)(bytes);
  ensureTime();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new FrameCaptureFailure("CAPTURE_FAILED");

  return Object.freeze({
    frame_sequence: frameSequence,
    captured_at: nowIso(),
    source_width: sourceWidth,
    source_height: sourceHeight,
    image_width: imageWidth,
    image_height: imageHeight,
    rotation: 0,
    geometry: Object.freeze({ x: 0, y: 0, width: imageWidth, height: imageHeight }),
    format: request.format,
    mime_type: expectedMime,
    byte_length: bytes.byteLength,
    sha256,
    base64: encodeBase64(bytes),
  });
}
