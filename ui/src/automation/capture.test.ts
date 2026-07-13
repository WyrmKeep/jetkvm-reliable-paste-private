import { describe, expect, it, vi } from "vitest";

import {
  captureFreshFrame,
  type CaptureCanvas,
  type CaptureCanvasContext,
  type DecodedVideoSource,
} from "./capture";
import type { CaptureBridgeRequest } from "./protocol";

const request = (format: "jpeg" | "png" = "jpeg"): CaptureBridgeRequest => ({
  operation_id: "capture-1",
  expected_lifecycle_generation: 2,
  expected_channel_generation: 3,
  timeout_ms: 100,
  format,
  max_width: 1000,
  max_height: 1000,
});

class FakeVideo implements DecodedVideoSource {
  videoWidth = 1920;
  videoHeight = 1080;
  readyState = 4;
  private callback: VideoFrameRequestCallback | null = null;

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    this.callback = callback;
    return 1;
  }

  cancelVideoFrameCallback(): void {
    this.callback = null;
  }

  advance(metadata: Partial<VideoFrameCallbackMetadata> = {}): void {
    const callback = this.callback;
    this.callback = null;
    callback?.(1, {
      expectedDisplayTime: 1,
      height: this.videoHeight,
      mediaTime: 1,
      presentationTime: 1,
      presentedFrames: 2,
      width: this.videoWidth,
      ...metadata,
    });
  }
}

function harness(bytes: Uint8Array, mimeType = "image/jpeg") {
  const drawImage = vi.fn();
  const context: CaptureCanvasContext = { drawImage };
  const canvas: CaptureCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: callback => callback(new Blob([Uint8Array.from(bytes).buffer], { type: mimeType })),
  };
  return {
    canvas,
    context,
    drawImage,
    createCanvas: vi.fn(() => canvas),
  };
}

describe("captureFreshFrame", () => {
  it("waits for a fresh decoded frame and captures the full source without crop or upscale", async () => {
    const video = new FakeVideo();
    const drawing = harness(new Uint8Array([1, 2, 3]));
    const verify = vi.fn();
    const pending = captureFreshFrame(video, request(), 7, {
      ...drawing,
      verify,
      nowIso: () => "2026-07-13T00:00:00.000Z",
      digest: async () => "a".repeat(64),
    });

    expect(drawing.drawImage).not.toHaveBeenCalled();
    video.advance();
    const result = await pending;

    expect(verify).toHaveBeenCalledTimes(3);
    expect(drawing.drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080, 0, 0, 1000, 562);
    expect(result).toMatchObject({
      frame_sequence: 7,
      source_width: 1920,
      source_height: 1080,
      image_width: 1000,
      image_height: 562,
      rotation: 0,
      geometry: { x: 0, y: 0, width: 1000, height: 562 },
      format: "jpeg",
      mime_type: "image/jpeg",
      byte_length: 3,
      base64: "AQID",
    });
  });

  it("never upscales a small decoded frame", async () => {
    const video = new FakeVideo();
    video.videoWidth = 320;
    video.videoHeight = 200;
    const drawing = harness(new Uint8Array([1]));
    const pending = captureFreshFrame(
      video,
      { ...request(), max_width: 4000, max_height: 4000 },
      1,
      {
        ...drawing,
        verify: () => undefined,
        digest: async () => "b".repeat(64),
      },
    );
    video.advance();

    const result = await pending;
    expect(result.image_width).toBe(320);
    expect(result.image_height).toBe(200);
  });

  it.each([
    { label: "wrong MIME", bytes: new Uint8Array([1]), mime: "image/png", code: "MIME_MISMATCH" },
    { label: "empty blob", bytes: new Uint8Array(), mime: "image/jpeg", code: "CAPTURE_FAILED" },
    {
      label: "oversize JPEG",
      bytes: new Uint8Array(2 * 1024 * 1024 + 1),
      mime: "image/jpeg",
      code: "CAPTURE_TOO_LARGE",
    },
  ])("rejects $label before base64", async ({ bytes, mime, code }) => {
    const video = new FakeVideo();
    const drawing = harness(bytes, mime);
    const digest = vi.fn(async () => "c".repeat(64));
    const pending = captureFreshFrame(video, request(), 1, {
      ...drawing,
      verify: () => undefined,
      digest,
    });
    video.advance();

    await expect(pending).rejects.toMatchObject({ code });
    expect(digest).not.toHaveBeenCalled();
  });

  it("rejects when the owner changes after frame advance", async () => {
    const video = new FakeVideo();
    const drawing = harness(new Uint8Array([1]));
    let checks = 0;
    const pending = captureFreshFrame(video, request(), 1, {
      ...drawing,
      verify: () => {
        checks++;
        if (checks === 2) throw new Error("stale owner");
      },
      digest: async () => "d".repeat(64),
    });
    video.advance();

    await expect(pending).rejects.toThrow("stale owner");
    expect(drawing.drawImage).not.toHaveBeenCalled();
  });

  it("cancels a pending decoded-frame callback", async () => {
    const video = new FakeVideo();
    const drawing = harness(new Uint8Array([1]));
    const abort = new AbortController();
    const pending = captureFreshFrame(video, request(), 1, {
      ...drawing,
      verify: () => undefined,
      digest: async () => "e".repeat(64),
      signal: abort.signal,
    });

    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(drawing.drawImage).not.toHaveBeenCalled();
  });

  it("fails a stalled video at the single request deadline", async () => {
    const video = new FakeVideo();
    const drawing = harness(new Uint8Array([1]));

    await expect(
      captureFreshFrame(video, { ...request(), timeout_ms: 1 }, 1, {
        ...drawing,
        verify: () => undefined,
        digest: async () => "e".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "VIDEO_STALLED" });
  });
});
