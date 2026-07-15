import { describe, expect, it } from "vitest";
import { JsonRpcRequestFailure } from "@/hooks/useJsonRpc";

import { AutomationController } from "./controller";
import type { AutomationPasteTransport, ProductRpcMethod, ProductRpcRequest } from "./controller";
import type { JsonValue } from "./protocol";

function makeRpc(
  implementation?: (
    method: ProductRpcMethod,
    params: JsonValue,
    options: Parameters<ProductRpcRequest>[2],
  ) => Promise<JsonValue>,
) {
  const calls: { method: ProductRpcMethod; params: JsonValue }[] = [];
  const request: ProductRpcRequest = async (method, params, options) => {
    calls.push({ method, params });
    options.onWrite();
    return implementation ? implementation(method, params, options) : null;
  };
  return { calls, request };
}

function makePaste(): AutomationPasteTransport & {
  values: string[];
  cancelled: number;
} {
  return {
    values: [],
    cancelled: 0,
    async execute(text, _signal, onAccepted) {
      this.values.push(text);
      onAccepted("2026-07-13T00:00:01.000Z");
      return {
        acceptedAt: "2026-07-13T00:00:01.000Z",
        completedAt: "2026-07-13T00:00:02.000Z",
        measuredSourceCps: 90.9,
      };
    },
    async cancelAndJoin() {
      this.cancelled++;
    },
    close() {
      return undefined;
    },
  };
}

function readyController(
  rpc = makeRpc(),
  paste = makePaste(),
  digestText: (text: string) => Promise<string> = async () => "a".repeat(64),
) {
  const controller = new AutomationController({
    nowIso: () => "2026-07-13T00:00:03.000Z",
    monotonicNow: () => 0,
    digestText,
  });
  const rpcIdentity = {};
  const hidIdentity = {};
  controller.replaceChannels({
    rpcIdentity,
    rpcRequest: rpc.request,
    hidIdentity,
    hidReady: true,
  });
  controller.replaceDisplay({
    videoIdentity: {},
    video: null,
    videoReady: true,
    sourceWidth: 1920,
    sourceHeight: 1080,
  });
  const generation = controller.snapshot().channel_generation;
  controller.publishInputCapabilities(generation, "en-US", paste);
  controller.setInputMode(true, true);
  return { controller, rpc, paste, rpcIdentity, hidIdentity };
}

function inputRequest(controller: AutomationController) {
  const snapshot = controller.snapshot();
  return {
    operation_id: "input-1",
    expected_lifecycle_generation: snapshot.lifecycle_generation,
    expected_channel_generation: snapshot.channel_generation,
    expected_display_generation: snapshot.display_generation,
    expected_dispatch_generation: snapshot.dispatch_generation,
    timeout_ms: 1000,
  };
}

describe("AutomationController lifecycle", () => {
  it("resets layout and paste capability on every channel replacement and ignores stale probes", () => {
    const { controller } = readyController();
    const first = controller.snapshot();
    expect(first).toMatchObject({
      state: "ready",
      keyboard_layout: "en-US",
      reliable_paste: true,
    });

    controller.replaceChannels({
      rpcIdentity: {},
      rpcRequest: makeRpc().request,
      hidIdentity: {},
      hidReady: true,
    });
    const replaced = controller.snapshot();
    expect(replaced.channel_generation).toBeGreaterThan(first.channel_generation);
    expect(replaced).toMatchObject({
      state: "not_ready",
      keyboard_layout: null,
      reliable_paste: false,
    });

    controller.publishInputCapabilities(first.channel_generation, "de-DE", makePaste());
    expect(controller.snapshot().keyboard_layout).toBeNull();
    controller.publishInputCapabilities(replaced.channel_generation, "de-DE", makePaste());
    expect(controller.snapshot()).toMatchObject({ state: "ready", keyboard_layout: "de-DE" });
  });
  it("invalidates layout and paste synchronously before an async reprobe", () => {
    const { controller } = readyController();
    const before = controller.snapshot();

    controller.invalidateInputCapabilities(before.channel_generation);
    const invalidated = controller.snapshot();
    expect(invalidated).toMatchObject({
      state: "not_ready",
      keyboard_layout: null,
      reliable_paste: false,
    });
    expect(invalidated.dispatch_generation).toBeGreaterThan(before.dispatch_generation);

    controller.publishInputCapabilities(before.channel_generation, "de-DE", makePaste());
    expect(controller.snapshot()).toMatchObject({
      state: "ready",
      keyboard_layout: "de-DE",
      reliable_paste: true,
    });
  });

  it("increments display generation when decoded video identity changes", () => {
    const { controller } = readyController();
    const before = controller.snapshot().display_generation;
    controller.replaceDisplay({
      videoIdentity: {},
      video: null,
      videoReady: true,
      sourceWidth: 1280,
      sourceHeight: 720,
    });
    expect(controller.snapshot().display_generation).toBeGreaterThan(before);
  });

  it("increments display generation for a source-track revision without topology assumptions", () => {
    const { controller } = readyController();
    const videoIdentity = {};
    controller.replaceDisplay({
      videoIdentity,
      video: null,
      videoReady: true,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceRevision: 1,
    });
    const before = controller.snapshot().display_generation;
    controller.replaceDisplay({
      videoIdentity,
      video: null,
      videoReady: true,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceRevision: 2,
    });
    expect(controller.snapshot().display_generation).toBeGreaterThan(before);
  });
  it("returns only the latest route-fed video event after a validation-only poll", async () => {
    let monotonicMs = 10;
    const poll = Promise.withResolvers<JsonValue>();
    const rpc = makeRpc(async method => (method === "getVideoState" ? poll.promise : null));
    const controller = new AutomationController({
      nowIso: () => "2026-07-13T00:00:04.000Z",
      monotonicNow: () => monotonicMs,
    });
    const rpcIdentity = {};
    controller.replaceChannels({
      rpcIdentity,
      rpcRequest: rpc.request,
      hidIdentity: {},
      hidReady: true,
    });
    controller.replaceDisplay({
      videoIdentity: {},
      video: null,
      videoReady: true,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    const channelGeneration = controller.snapshot().channel_generation;
    controller.publishInputCapabilities(channelGeneration, "en-US", makePaste());
    controller.setInputMode(true, true);
    expect(
      controller.observeVideoInputState(
        {
          ready: true,
          streaming: 2,
          error: "",
          width: 1920,
          height: 1080,
          fps: 59.94,
        },
        rpcIdentity,
      ),
    ).toBe(true);

    const snapshot = controller.snapshot();
    const resultPromise = controller.readVideoState({
      operation_id: "display-read-1",
      expected_lifecycle_generation: snapshot.lifecycle_generation,
      expected_channel_generation: snapshot.channel_generation,
      timeout_ms: 1000,
    });
    monotonicMs = 25;
    controller.observeVideoInputState(
      {
        ready: false,
        streaming: 0,
        error: "no_signal",
        width: 0,
        height: 0,
        fps: 0,
      },
      rpcIdentity,
    );
    monotonicMs = 40;
    poll.resolve({ ready: true, streaming: 2, error: "", width: 1, height: 1, fps: 1 });

    await expect(resultPromise).resolves.toMatchObject({
      result: {
        validation_poll_completed: true,
        cached_event: {
          channel_generation: channelGeneration,
          event_sequence: expect.any(Number),
          observed_at: "2026-07-13T00:00:04.000Z",
          observed_monotonic_ms: 25,
          age_ms: 15,
          state: {
            ready: false,
            error: "no_signal",
            width: 0,
            height: 0,
            fps: 0,
          },
        },
      },
    });
    expect(JSON.stringify(await resultPromise)).not.toContain("streaming");
  });

  it("returns canonical no-event after channel replacement instead of poll-derived state", async () => {
    const firstRpc = makeRpc(async () => ({
      ready: true,
      streaming: 2,
      error: "",
      width: 1920,
      height: 1080,
      fps: 60,
    }));
    const { controller, rpcIdentity } = readyController(firstRpc);
    controller.observeVideoInputState(
      {
        ready: true,
        error: "",
        width: 1920,
        height: 1080,
        fps: 60,
      },
      rpcIdentity,
    );
    controller.replaceChannels({
      rpcIdentity: {},
      rpcRequest: firstRpc.request,
      hidIdentity: {},
      hidReady: true,
    });
    expect(
      controller.observeVideoInputState(
        { ready: false, error: "stale-old-channel", width: 0, height: 0, fps: 0 },
        rpcIdentity,
      ),
    ).toBe(false);
    const channelGeneration = controller.snapshot().channel_generation;
    controller.publishInputCapabilities(channelGeneration, "en-US", makePaste());
    const snapshot = controller.snapshot();

    await expect(
      controller.readVideoState({
        operation_id: "display-read-2",
        expected_lifecycle_generation: snapshot.lifecycle_generation,
        expected_channel_generation: snapshot.channel_generation,
        timeout_ms: 1000,
      }),
    ).resolves.toMatchObject({
      result: {
        validation_poll_completed: true,
        cached_event: null,
      },
    });
  });
  it("preserves only the qualified EDID failure marker", async () => {
    const rpc = makeRpc(async () => {
      throw new JsonRpcRequestFailure("EDID_READ_FAILED", true);
    });
    const { controller } = readyController(rpc);
    const snapshot = controller.snapshot();

    await expect(
      controller.readEdid({
        operation_id: "display-read-edid",
        expected_lifecycle_generation: snapshot.lifecycle_generation,
        expected_channel_generation: snapshot.channel_generation,
        timeout_ms: 1000,
      }),
    ).rejects.toMatchObject({
      code: "EDID_READ_FAILED",
      message: "The native EDID read failed.",
      write_began: true,
    });
  });
  it("marks a downstream failure before the first write as queued", async () => {
    const request: ProductRpcRequest = async () => {
      throw new Error("disconnected before write");
    };
    const { controller } = readyController({ calls: [], request });
    const snapshot = controller.snapshot();

    await expect(
      controller.readEdid({
        operation_id: "display-read-before-write",
        expected_lifecycle_generation: snapshot.lifecycle_generation,
        expected_channel_generation: snapshot.channel_generation,
        timeout_ms: 1000,
      }),
    ).rejects.toMatchObject({
      code: "DOWNSTREAM_ERROR",
      stage: "queue",
      outcome: "not_sent",
      write_began: false,
    });

    const responseWithoutWrite: ProductRpcRequest = async () => ({ edid: "present" });
    const second = readyController({ calls: [], request: responseWithoutWrite }).controller;
    const secondSnapshot = second.snapshot();
    await expect(
      second.readEdid({
        operation_id: "display-read-response-before-write",
        expected_lifecycle_generation: secondSnapshot.lifecycle_generation,
        expected_channel_generation: secondSnapshot.channel_generation,
        timeout_ms: 1000,
      }),
    ).rejects.toMatchObject({
      code: "MALFORMED_ACKNOWLEDGEMENT",
      stage: "queue",
      outcome: "not_sent",
      write_began: false,
    });
  });
  it("routes a semantic ATX request through the receipt-bearing product RPC", async () => {
    const receipt = {
      requestId: "power-1",
      action: "press_power",
      wireAction: "power-short",
      fixedPressMs: 200,
      serialSequenceCompleted: true,
      acknowledgedAt: "2026-07-13T00:00:03.000Z",
      atxLedObservation: {
        power: true,
        hdd: false,
        observedAt: "2026-07-13T00:00:02.000Z",
        freshness: "stale",
      },
      verification: "device_ack_only",
      postRead: { status: "available" },
    } as const;
    const rpc = makeRpc(async () => receipt);
    const { controller } = readyController(rpc);
    const snapshot = controller.snapshot();

    await expect(
      controller.performAtx({
        operation_id: "power-1",
        expected_lifecycle_generation: snapshot.lifecycle_generation,
        expected_channel_generation: snapshot.channel_generation,
        timeout_ms: 1000,
        request_id: "power-1",
        action: "press_power",
      }),
    ).resolves.toMatchObject({ result: receipt });
    expect(rpc.calls).toEqual([
      {
        method: "performATXAction",
        params: { requestId: "power-1", action: "press_power" },
      },
    ]);
  });

  it("reports ATX channel replacement before the first write as queued", async () => {
    const holder: { controller?: AutomationController } = {};
    const request: ProductRpcRequest = async () => {
      if (holder.controller === undefined) {
        throw new Error("controller not initialized");
      }
      holder.controller.replaceChannels({
        rpcIdentity: {},
        rpcRequest: makeRpc().request,
        hidIdentity: {},
        hidReady: true,
      });
      throw new Error("channel replaced before write");
    };
    const controller = readyController({ calls: [], request }).controller;
    holder.controller = controller;
    const snapshot = controller.snapshot();

    await expect(
      controller.performAtx({
        operation_id: "power-replaced-before-write",
        expected_lifecycle_generation: snapshot.lifecycle_generation,
        expected_channel_generation: snapshot.channel_generation,
        timeout_ms: 1000,
        request_id: "power-replaced-before-write",
        action: "press_power",
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_LOST",
      stage: "queue",
      outcome: "not_sent",
      write_began: false,
    });
  });

  it("preserves acknowledged definitive ATX admission failures", async () => {
    const rpc = makeRpc(async () => {
      throw new JsonRpcRequestFailure("ATX_EXTENSION_INACTIVE", true);
    });
    const { controller } = readyController(rpc);
    const snapshot = controller.snapshot();

    await expect(
      controller.performAtx({
        operation_id: "power-inactive",
        expected_lifecycle_generation: snapshot.lifecycle_generation,
        expected_channel_generation: snapshot.channel_generation,
        timeout_ms: 1000,
        request_id: "power-inactive",
        action: "press_power",
      }),
    ).rejects.toMatchObject({
      code: "ATX_EXTENSION_INACTIVE",
      outcome: "not_sent",
      write_began: true,
      acknowledged: true,
    });
  });
  it("cancels an in-flight operation by its exact public operation id", async () => {
    const started = Promise.withResolvers<void>();
    const rpc = makeRpc(async (_method, _params, options) => {
      started.resolve();
      await new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
      return null;
    });
    const { controller } = readyController(rpc);
    const operation = controller.keyboard({
      ...inputRequest(controller),
      operation_id: "cancel-exact-operation",
      operations: [{ key: 4, press: true }],
    });
    await started.promise;

    expect(controller.cancel("other-operation")).toBe(false);
    expect(controller.cancel("cancel-exact-operation")).toBe(true);
    await expect(operation).rejects.toMatchObject({
      code: "CANCELLED",
      outcome: "unknown",
      write_began: true,
    });
    expect(controller.cancel("cancel-exact-operation")).toBe(false);
  });

  it("reactivates a StrictMode owner only as a fresh not-ready lifetime", () => {
    const { controller } = readyController();
    const before = controller.snapshot();
    controller.invalidate("unmounted");
    expect(controller.snapshot().state).toBe("unmounted");

    controller.activate(before.lifecycle_generation + 1);
    const remounted = controller.snapshot();
    expect(remounted.lifecycle_generation).toBeGreaterThan(before.lifecycle_generation);
    expect(remounted.channel_generation).toBeGreaterThan(before.channel_generation);
    expect(remounted.display_generation).toBeGreaterThan(before.display_generation);
    expect(remounted.dispatch_generation).toBeGreaterThan(before.dispatch_generation);
    expect(remounted).toMatchObject({
      state: "not_ready",
      rpc_ready: false,
      hid_ready: false,
      video_ready: false,
      keyboard_layout: null,
      reliable_paste: false,
    });
  });
});

describe("AutomationController acknowledged input", () => {
  it("returns exact whole-batch mouse and keyboard counts", async () => {
    const { controller, rpc } = readyController();
    const mouse = await controller.mouse({
      ...inputRequest(controller),
      operations: [
        { kind: "absolute", x: 10, y: 20, buttons: 1 },
        { kind: "wheel", delta_y: -3 },
      ],
    });
    expect(mouse).toMatchObject({ dispatched_count: 2, completed_count: 2 });
    expect(rpc.calls).toEqual([
      { method: "absMouseReport", params: { x: 10, y: 20, buttons: 1 } },
      { method: "wheelReport", params: { wheelY: -3 } },
    ]);

    const keyboard = await controller.keyboard({
      ...inputRequest(controller),
      operation_id: "keyboard-1",
      operations: [
        { key: 4, press: true },
        { key: 4, press: false },
      ],
    });
    expect(keyboard).toMatchObject({ dispatched_count: 2, completed_count: 2 });
    expect(rpc.calls.slice(2)).toEqual([
      { method: "keypressReport", params: { key: 4, press: true } },
      { method: "keypressReport", params: { key: 4, press: false } },
    ]);
  });

  it("labels keyboard failures before the first write as queued", async () => {
    const cases: readonly {
      code: "DOWNSTREAM_ERROR" | "MALFORMED_ACKNOWLEDGEMENT";
      request: ProductRpcRequest;
    }[] = [
      {
        code: "DOWNSTREAM_ERROR",
        request: async () => {
          throw new Error("disconnected before write");
        },
      },
      {
        code: "MALFORMED_ACKNOWLEDGEMENT",
        request: async () => null,
      },
    ];

    for (const scenario of cases) {
      const { controller } = readyController({
        calls: [],
        request: scenario.request,
      });
      await expect(
        controller.keyboard({
          ...inputRequest(controller),
          operation_id: `keyboard-${scenario.code.toLowerCase()}`,
          operations: [{ key: 4, press: true }],
        }),
      ).rejects.toMatchObject({
        code: scenario.code,
        stage: "queue",
        outcome: "not_sent",
        write_began: false,
        dispatched_count: 0,
        completed_count: 0,
      });
    }
  });

  it("suppresses the suffix after an acknowledged-prefix failure", async () => {
    let call = 0;
    const rpc = makeRpc(async () => {
      call++;
      if (call === 2) throw new Error("private downstream detail");
      return null;
    });
    const { controller } = readyController(rpc);

    await expect(
      controller.keyboard({
        ...inputRequest(controller),
        operations: [
          { key: 4, press: true },
          { key: 5, press: true },
          { key: 6, press: true },
        ],
      }),
    ).rejects.toMatchObject({
      code: "DOWNSTREAM_ERROR",
      outcome: "unknown",
      acknowledged: false,
      dispatched_count: 2,
      completed_count: 1,
      message: "The product operation failed.",
    });
    expect(rpc.calls).toHaveLength(2);
    expect(JSON.stringify(await controller.snapshot())).not.toContain("private downstream detail");
  });

  it("fences channel replacement before and after the first write", async () => {
    const firstGate = Promise.withResolvers<JsonValue>();
    const firstStarted = Promise.withResolvers<void>();
    const firstRpc = makeRpc(async () => {
      firstStarted.resolve();
      return firstGate.promise;
    });
    const { controller } = readyController(firstRpc);
    const first = controller.mouse({
      ...inputRequest(controller),
      operation_id: "blocker",
      operations: [{ kind: "absolute", x: 1, y: 2, buttons: 0 }],
    });
    const firstExpectation = expect(first).rejects.toMatchObject({
      outcome: "unknown",
      write_began: true,
    });
    const queued = controller.keyboard({
      ...inputRequest(controller),
      operation_id: "queued",
      operations: [{ key: 4, press: true }],
    });
    const queuedExpectation = expect(queued).rejects.toMatchObject({
      outcome: "not_sent",
      write_began: false,
      dispatched_count: 0,
    });
    await firstStarted.promise;
    controller.replaceChannels({
      rpcIdentity: {},
      rpcRequest: makeRpc().request,
      hidIdentity: {},
      hidReady: true,
    });
    firstGate.resolve(null);
    await firstExpectation;
    await queuedExpectation;

    const replacement = {
      controller: undefined as AutomationController | undefined,
    };
    const afterWriteRpc = makeRpc(async (_method, _params, options) => {
      const currentController = replacement.controller;
      if (currentController === undefined) {
        throw new Error("replacement controller is not initialized");
      }
      currentController.replaceChannels({
        rpcIdentity: {},
        rpcRequest: makeRpc().request,
        hidIdentity: {},
        hidReady: true,
      });
      options.signal.throwIfAborted();
      return null;
    });
    replacement.controller = readyController(afterWriteRpc).controller;
    const replacementController = replacement.controller;
    await expect(
      replacementController.mouse({
        ...inputRequest(replacementController),
        operations: [{ kind: "absolute", x: 1, y: 2, buttons: 0 }],
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_LOST",
      outcome: "unknown",
      write_began: true,
      dispatched_count: 1,
      completed_count: 0,
    });
  });
});

describe("AutomationController paste and release", () => {
  it("normalizes paste once and retains no raw text after a correlated terminal", async () => {
    const paste = makePaste();
    const { controller } = readyController(makeRpc(), paste);
    const receipt = await controller.paste({
      ...inputRequest(controller),
      operation_id: "paste-1",
      text: "\uFEFFCafe\u0301\r\n",
    });

    expect(paste.values).toEqual(["Caf\u00e9\n"]);
    expect(receipt).toMatchObject({
      original_byte_count: 11,
      normalized_byte_count: 6,
      normalized_sha256: "a".repeat(64),
      terminal_state: "succeeded",
      measured_source_cps: 90.9,
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain("Caf");
    expect(JSON.stringify(receipt)).not.toContain("Caf");
  });

  it("labels paste failures before acceptance as queued", async () => {
    const executions: readonly AutomationPasteTransport["execute"][] = [
      async () => {
        throw new Error("disconnected before acceptance");
      },
      async () => ({
        acceptedAt: "2026-07-13T00:00:01.000Z",
        completedAt: "2026-07-13T00:00:02.000Z",
        measuredSourceCps: 90.9,
      }),
    ];

    for (const execute of executions) {
      const paste = { ...makePaste(), execute };
      const { controller } = readyController(makeRpc(), paste);
      await expect(
        controller.paste({
          ...inputRequest(controller),
          operation_id: `paste-before-write-${executions.indexOf(execute)}`,
          text: "safe text",
        }),
      ).rejects.toMatchObject({
        code: "PASTE_LIFECYCLE",
        stage: "queue",
        outcome: "not_sent",
        write_began: false,
        dispatched_count: 0,
      });
    }
  });

  it("labels paste digest failures before queue admission", async () => {
    const digests: readonly ((text: string) => Promise<string>)[] = [
      async () => "invalid",
      async () => {
        throw new Error("digest unavailable");
      },
    ];

    for (const digestText of digests) {
      const { controller } = readyController(makeRpc(), makePaste(), digestText);
      await expect(
        controller.paste({
          ...inputRequest(controller),
          operation_id: `paste-digest-${digests.indexOf(digestText)}`,
          text: "safe text",
        }),
      ).rejects.toMatchObject({
        code: "DOWNSTREAM_ERROR",
        stage: "admission",
        outcome: "not_sent",
        write_began: false,
      });
    }
  });

  it("preempts active work, cancels paste, invokes first-use zero, and closes the gate", async () => {
    const active = Promise.withResolvers<JsonValue>();
    const activeStarted = Promise.withResolvers<void>();
    const rpc = makeRpc(async (method, _params, options) => {
      if (method !== "quiesceAndZero") {
        activeStarted.resolve();
        const aborted = Promise.withResolvers<never>();
        options.signal.addEventListener("abort", () => aborted.reject(new Error("aborted")), {
          once: true,
        });
        await Promise.race([active.promise, aborted.promise]);
        return null;
      }
      return {
        operationId: "release-1",
        generation: 42,
        outcome: "released",
        draining: true,
        producersJoined: true,
        macroInactive: true,
        pasteInactive: true,
        ordinaryLeasesZero: true,
        keyboardZero: true,
        pointerZero: true,
      };
    });
    const paste = makePaste();
    const { controller } = readyController(rpc, paste);
    const activeInput = controller.keyboard({
      ...inputRequest(controller),
      operation_id: "active-key",
      operations: [{ key: 4, press: true }],
    });
    const activeExpectation = expect(activeInput).rejects.toMatchObject({ outcome: "unknown" });
    await activeStarted.promise;
    const release = await controller.release({
      ...inputRequest(controller),
      operation_id: "release-1",
    });

    await activeExpectation;
    expect(paste.cancelled).toBe(1);
    expect(rpc.calls.at(-1)).toEqual({
      method: "quiesceAndZero",
      params: { operationId: "release-1" },
    });
    expect(release).toMatchObject({
      device_generation: 42,
      outcome: "released",
      dispatch_generation: expect.any(Number),
      keyboard_zero: true,
      pointer_zero: true,
    });
    expect(controller.snapshot().state).toBe("closed");
    await expect(
      Promise.resolve().then(() =>
        controller.mouse({
          ...inputRequest(controller),
          operation_id: "after-close",
          operations: [{ kind: "absolute", x: 0, y: 0, buttons: 0 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "CLOSED", outcome: "not_sent" });
  });

  it("reports a release transport failure before the first write as queued", async () => {
    const request: ProductRpcRequest = async () => {
      throw new Error("disconnected before write");
    };
    const { controller } = readyController({ calls: [], request });

    await expect(
      controller.release({
        ...inputRequest(controller),
        operation_id: "release-before-write",
      }),
    ).rejects.toMatchObject({
      code: "RELEASE_FAILED",
      stage: "queue",
      outcome: "not_sent",
      write_began: false,
    });
    expect(controller.snapshot().state).toBe("closed");
  });

  it("rejects a release response that arrived without a first-write signal", async () => {
    const request: ProductRpcRequest = async () => ({
      operationId: "release-response-before-write",
      generation: 42,
      outcome: "released",
      draining: true,
      producersJoined: true,
      macroInactive: true,
      pasteInactive: true,
      ordinaryLeasesZero: true,
      keyboardZero: true,
      pointerZero: true,
    });
    const { controller } = readyController({ calls: [], request });

    await expect(
      controller.release({
        ...inputRequest(controller),
        operation_id: "release-response-before-write",
      }),
    ).rejects.toMatchObject({
      code: "RELEASE_FAILED",
      stage: "queue",
      outcome: "not_sent",
      write_began: false,
    });
    expect(controller.snapshot().state).toBe("closed");
  });

  it("cancels an in-flight release RPC while retaining the closed mutation gate", async () => {
    const started = Promise.withResolvers<void>();
    const rpc = makeRpc(async (_method, _params, options) => {
      started.resolve();
      await new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
      return null;
    });
    const { controller } = readyController(rpc);
    const release = controller.release({
      ...inputRequest(controller),
      operation_id: "cancel-release",
    });
    await started.promise;

    expect(controller.cancel("cancel-release")).toBe(true);
    await expect(release).rejects.toMatchObject({
      code: "CANCELLED",
      outcome: "unknown",
      write_began: true,
    });
    expect(controller.snapshot().state).toBe("closed");
    expect(controller.cancel("cancel-release")).toBe(false);
  });

  it("rejects a stale release acknowledgement and leaves the gate closed", async () => {
    const rpc = makeRpc(async method => {
      if (method !== "quiesceAndZero") return null;
      return {
        operationId: "wrong-operation",
        generation: 42,
        outcome: "released",
        draining: true,
        producersJoined: true,
        macroInactive: true,
        pasteInactive: true,
        ordinaryLeasesZero: true,
        keyboardZero: true,
        pointerZero: true,
      };
    });
    const { controller } = readyController(rpc);

    await expect(
      controller.release({ ...inputRequest(controller), operation_id: "release-1" }),
    ).rejects.toMatchObject({
      code: "RELEASE_FAILED",
      outcome: "unknown",
      write_began: true,
    });
    expect(controller.snapshot().state).toBe("closed");
  });
});
