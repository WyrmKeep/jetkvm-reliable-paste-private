import { chromium, type Browser, type BrowserContext } from "playwright";

import { BrowserController } from "../browser/BrowserController.js";
import type { AutomationSnapshot } from "../browser/bridgeProtocol.js";

export const UI_FIXTURE_ARTIFACT_POLICY = Object.freeze({
  trace: "off",
  video: "off",
  screenshot: "off",
} as const);

export interface UiFixture {
  readonly controller: BrowserController;
  readonly artifactPolicy: typeof UI_FIXTURE_ARTIFACT_POLICY;
  /** Sanitized fixture-owned state only; never frame bytes, base64, paste text, or target data. */
  retained(): string;
  close(): Promise<void>;
}

const INITIAL_SNAPSHOT: AutomationSnapshot = Object.freeze({
  version: 1,
  state: "ready",
  lifecycle_generation: 2,
  channel_generation: 3,
  display_generation: 4,
  dispatch_generation: 5,
  rpc_ready: true,
  hid_ready: true,
  video_ready: true,
  absolute_pointer: true,
  scroll_throttling_disabled: true,
  keyboard_layout: "en-US",
  reliable_paste: true,
  source_width: 1920,
  source_height: 1080,
});

async function closeFixtureResources(
  controller: BrowserController | null,
  context: BrowserContext | null,
  browser: Browser | null,
): Promise<void> {
  await controller
    ?.close({ timeoutMs: 1_000, signal: new AbortController().signal })
    .catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}

async function launchFixtureBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return chromium.launch({ headless: true, channel: "chrome" });
  }
}

export async function createUiFixture(): Promise<UiFixture> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let controller: BrowserController | null = null;
  try {
    browser = await launchFixtureBrowser();
    // Tracing is never started, recordVideo is intentionally absent, and this
    // fixture does not use the Playwright test runner's screenshot facility.
    context = await browser.newContext();
    await context.route("https://fixture.invalid/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      });
    });
    const page = await context.newPage();
    await page.goto("https://fixture.invalid/", {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate((initialSnapshot) => {
      type JsonValue =
        | boolean
        | number
        | string
        | null
        | { readonly [key: string]: JsonValue }
        | readonly JsonValue[];
      type Snapshot = typeof initialSnapshot;
      type CommonRequest = {
        readonly operation_id: string;
        readonly expected_lifecycle_generation: number;
        readonly expected_channel_generation: number;
        readonly timeout_ms: number;
      };
      type InputRequest = CommonRequest & {
        readonly expected_display_generation: number;
        readonly expected_dispatch_generation: number;
      };
      type FixtureFacade = {
        readonly version: 1;
        snapshot(): Snapshot;
        capture(
          request: CommonRequest & {
            readonly format: "jpeg" | "png";
            readonly max_width: number;
            readonly max_height: number;
          },
        ): Promise<JsonValue>;
        mouse(
          request: InputRequest & { readonly operations: readonly JsonValue[] },
        ): Promise<JsonValue>;
        keyboard(
          request: InputRequest & {
            readonly operations: readonly {
              readonly key: number;
              readonly press: boolean;
            }[];
          },
        ): Promise<JsonValue>;
        paste(
          request: InputRequest & { readonly text: string },
        ): Promise<JsonValue>;
        release(request: InputRequest): Promise<JsonValue>;
        readVideoState(request: CommonRequest): Promise<JsonValue>;
        readEdid(request: CommonRequest): Promise<JsonValue>;
      };
      const fixedMessages = {
        INVALID_REQUEST: "The automation request is invalid.",
        NOT_READY: "The managed device route is not ready.",
        CLOSED: "The automation mutation gate is closed.",
        GENERATION_MISMATCH: "The automation generation is stale.",
      } as const;
      let snapshot: Snapshot = { ...initialSnapshot };
      let frameSequence = 0;
      const heldUsages = new Set<number>();
      const nowIso = () => "2026-07-13T00:00:00.000Z";
      const error = (
        code: keyof typeof fixedMessages,
        operationId: string | null,
      ) => ({
        version: 1,
        name: "JetKvmAutomationError",
        code,
        stage: "admission",
        outcome: "not_sent",
        operation_id: operationId,
        lifecycle_generation: snapshot.lifecycle_generation,
        channel_generation: snapshot.channel_generation,
        display_generation: snapshot.display_generation,
        dispatch_generation: snapshot.dispatch_generation,
        write_began: false,
        acknowledged: false,
        dispatched_count: 0,
        completed_count: 0,
        message: fixedMessages[code],
      });
      const validateCommon = (request: CommonRequest): void => {
        if (
          snapshot.state !== "ready" ||
          request.expected_lifecycle_generation !==
            snapshot.lifecycle_generation ||
          request.expected_channel_generation !== snapshot.channel_generation
        ) {
          const code =
            snapshot.state === "closed"
              ? "CLOSED"
              : snapshot.state === "ready"
                ? "GENERATION_MISMATCH"
                : "NOT_READY";
          throw error(code, request.operation_id);
        }
      };
      const validateInput = (request: InputRequest): void => {
        validateCommon(request);
        if (
          request.expected_display_generation !== snapshot.display_generation ||
          request.expected_dispatch_generation !== snapshot.dispatch_generation
        ) {
          throw error("GENERATION_MISMATCH", request.operation_id);
        }
      };
      const digest = async (bytes: Uint8Array): Promise<string> => {
        const owned = new Uint8Array(bytes.byteLength);
        owned.set(bytes);
        const result = new Uint8Array(
          await crypto.subtle.digest("SHA-256", owned.buffer),
        );
        let hex = "";
        for (const byte of result) hex += byte.toString(16).padStart(2, "0");
        return hex;
      };
      const base64 = (bytes: Uint8Array): string => {
        let value = "";
        for (const byte of bytes) value += String.fromCharCode(byte);
        return btoa(value);
      };
      const receipt = (request: InputRequest, count: number) => ({
        operation_id: request.operation_id,
        lifecycle_generation: request.expected_lifecycle_generation,
        channel_generation: request.expected_channel_generation,
        display_generation: request.expected_display_generation,
        dispatch_generation: request.expected_dispatch_generation,
        queued_at: nowIso(),
        acknowledged_at: nowIso(),
        dispatched_count: count,
        completed_count: count,
      });
      const facade: FixtureFacade = Object.freeze({
        version: 1,
        snapshot: () => ({ ...snapshot }),
        capture: async (request) => {
          validateCommon(request);
          if (
            snapshot.source_width === null ||
            snapshot.source_height === null
          ) {
            throw error("NOT_READY", request.operation_id);
          }
          frameSequence += 1;
          const scale = Math.min(
            1,
            request.max_width / snapshot.source_width,
            request.max_height / snapshot.source_height,
          );
          const imageWidth = Math.max(
            1,
            Math.floor(snapshot.source_width * scale),
          );
          const imageHeight = Math.max(
            1,
            Math.floor(snapshot.source_height * scale),
          );
          const bytes = new Uint8Array([1, 2, frameSequence & 0xff]);
          return {
            operation_id: request.operation_id,
            lifecycle_generation: snapshot.lifecycle_generation,
            channel_generation: snapshot.channel_generation,
            display_generation: snapshot.display_generation,
            frame_sequence: frameSequence,
            captured_at: nowIso(),
            source_width: snapshot.source_width,
            source_height: snapshot.source_height,
            image_width: imageWidth,
            image_height: imageHeight,
            rotation: 0,
            geometry: { x: 0, y: 0, width: imageWidth, height: imageHeight },
            format: request.format,
            mime_type: request.format === "jpeg" ? "image/jpeg" : "image/png",
            byte_length: bytes.byteLength,
            sha256: await digest(bytes),
            base64: base64(bytes),
          };
        },
        mouse: async (request) => {
          validateInput(request);
          return receipt(request, request.operations.length);
        },
        keyboard: async (request) => {
          validateInput(request);
          for (const operation of request.operations) {
            if (operation.press) heldUsages.add(operation.key);
            else heldUsages.delete(operation.key);
          }
          return receipt(request, request.operations.length);
        },
        paste: async (request) => {
          validateInput(request);
          const withoutBom = request.text.startsWith("\uFEFF")
            ? request.text.slice(1)
            : request.text;
          const normalized = withoutBom
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .normalize("NFC");
          const encoder = new TextEncoder();
          const originalBytes = encoder.encode(request.text);
          const normalizedBytes = encoder.encode(normalized);
          return {
            operation_id: request.operation_id,
            lifecycle_generation: request.expected_lifecycle_generation,
            channel_generation: request.expected_channel_generation,
            display_generation: request.expected_display_generation,
            dispatch_generation: request.expected_dispatch_generation,
            original_byte_count: originalBytes.byteLength,
            normalized_byte_count: normalizedBytes.byteLength,
            normalized_sha256: await digest(normalizedBytes),
            accepted_at: nowIso(),
            completed_at: nowIso(),
            terminal_state: "succeeded",
            measured_source_cps: 90.9,
          };
        },
        release: async (request) => {
          validateInput(request);
          heldUsages.clear();
          snapshot = {
            ...snapshot,
            state: "closed",
            dispatch_generation: snapshot.dispatch_generation + 1,
          };
          return {
            operation_id: request.operation_id,
            lifecycle_generation: request.expected_lifecycle_generation,
            channel_generation: request.expected_channel_generation,
            display_generation: request.expected_display_generation,
            dispatch_generation: snapshot.dispatch_generation,
            device_generation: 9,
            outcome: "released",
            draining: true,
            producers_joined: true,
            macro_inactive: true,
            paste_inactive: true,
            ordinary_leases_zero: true,
            keyboard_zero: true,
            pointer_zero: true,
            released_at: nowIso(),
          };
        },
        readVideoState: async (request) => {
          validateCommon(request);
          return {
            operation_id: request.operation_id,
            lifecycle_generation: request.expected_lifecycle_generation,
            channel_generation: request.expected_channel_generation,
            acknowledged_at: nowIso(),
            result: {
              validation_poll_completed: true,
              cached_event: null,
            },
          };
        },
        readEdid: async (request) => {
          validateCommon(request);
          return {
            operation_id: request.operation_id,
            lifecycle_generation: request.expected_lifecycle_generation,
            channel_generation: request.expected_channel_generation,
            acknowledged_at: nowIso(),
            result: null,
          };
        },
      });
      Object.defineProperty(window, "__JETKVM_AUTOMATION__", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: facade,
      });
    }, INITIAL_SNAPSHOT);
    controller = new BrowserController(page);
    const retainedState = JSON.stringify({
      lifecycleGeneration: INITIAL_SNAPSHOT.lifecycle_generation,
      channelGeneration: INITIAL_SNAPSHOT.channel_generation,
      displayGeneration: INITIAL_SNAPSHOT.display_generation,
      artifactPolicy: UI_FIXTURE_ARTIFACT_POLICY,
    });
    let closed = false;
    const fixtureController = controller;
    const fixtureContext = context;
    const fixtureBrowser = browser;
    return Object.freeze({
      controller: fixtureController,
      artifactPolicy: UI_FIXTURE_ARTIFACT_POLICY,
      retained: () => retainedState,
      close: async () => {
        if (closed) return;
        closed = true;
        await closeFixtureResources(
          fixtureController,
          fixtureContext,
          fixtureBrowser,
        );
      },
    });
  } catch (error) {
    await closeFixtureResources(controller, context, browser);
    throw error;
  }
}
