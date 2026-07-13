import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Deadline } from "../device/DeviceRpcAdapter.js";
import { materializeCaptureFrame } from "../browser/frames.js";
import { createUiFixture } from "./uiFixture.js";

const deadline: Deadline = {
  timeoutMs: 5_000,
  signal: new AbortController().signal,
};

describe("privacy-safe Playwright UI fixture", () => {
  it("drives exactly the stable facade with every artifact recorder disabled", async () => {
    const fixture = await createUiFixture();
    try {
      expect(fixture.artifactPolicy).toEqual({
        trace: "off",
        video: "off",
        screenshot: "off",
      });
      const snapshot = await fixture.controller.snapshot(deadline);
      expect(snapshot).toMatchObject({
        version: 1,
        state: "ready",
        lifecycle_generation: 2,
        channel_generation: 3,
      });

      const captureRequest = {
        operation_id: "capture-1",
        expected_lifecycle_generation: 2,
        expected_channel_generation: 3,
        timeout_ms: 5_000,
        format: "png" as const,
        max_width: 1280,
        max_height: 720,
      };
      const captureResult = await fixture.controller.capture(
        captureRequest,
        deadline,
      );
      const frame = materializeCaptureFrame(captureResult, captureRequest);
      expect(frame.metadata.byteLength).toBeGreaterThan(0);
      expect(JSON.stringify(frame.metadata)).not.toContain(
        captureResult.base64,
      );

      await expect(
        fixture.controller.mouse(
          {
            operation_id: "mouse-1",
            expected_lifecycle_generation: 2,
            expected_channel_generation: 3,
            expected_display_generation: 4,
            expected_dispatch_generation: 5,
            timeout_ms: 5_000,
            operations: [{ kind: "absolute", x: 10, y: 20, buttons: 0 }],
          },
          deadline,
        ),
      ).resolves.toMatchObject({ dispatched_count: 1, completed_count: 1 });

      await expect(
        fixture.controller.keyboard(
          {
            operation_id: "keyboard-1",
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
          deadline,
        ),
      ).resolves.toMatchObject({ dispatched_count: 2, completed_count: 2 });

      const secret = "\uFEFFprivate\r\ntext";
      const normalized = "private\ntext";
      await expect(
        fixture.controller.paste(
          {
            operation_id: "paste-1",
            expected_lifecycle_generation: 2,
            expected_channel_generation: 3,
            expected_display_generation: 4,
            expected_dispatch_generation: 5,
            timeout_ms: 5_000,
            text: secret,
          },
          deadline,
        ),
      ).resolves.toMatchObject({
        original_byte_count: Buffer.byteLength(secret),
        normalized_byte_count: Buffer.byteLength(normalized),
        normalized_sha256: createHash("sha256")
          .update(normalized)
          .digest("hex"),
        terminal_state: "succeeded",
      });
      expect(fixture.retained()).not.toContain(secret);
      expect(fixture.retained()).not.toContain(normalized);

      await expect(
        fixture.controller.readVideoState(
          {
            operation_id: "read-video-1",
            expected_lifecycle_generation: 2,
            expected_channel_generation: 3,
            timeout_ms: 5_000,
          },
          deadline,
        ),
      ).resolves.toMatchObject({
        result: { validation_poll_completed: true, cached_event: null },
      });

      await expect(
        fixture.controller.release(
          {
            operation_id: "release-1",
            expected_lifecycle_generation: 2,
            expected_channel_generation: 3,
            expected_display_generation: 4,
            expected_dispatch_generation: 5,
            timeout_ms: 5_000,
          },
          deadline,
        ),
      ).resolves.toMatchObject({
        outcome: "released",
        dispatch_generation: 6,
        ordinary_leases_zero: true,
        keyboard_zero: true,
        pointer_zero: true,
      });
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
