import { createHash } from "node:crypto";

import type {
  Deadline,
  DeviceRpcAdapter,
  SessionRef,
} from "../../device/DeviceRpcAdapter.js";
import type {
  BrowserConnection,
  BrowserPlane,
  CaptureRequest,
  KeyboardRequest,
  MouseRequest,
  MutationReceipt,
  Observation,
  PasteReceipt,
  PasteRequest,
  ReleaseReceipt,
  ReleaseRequest,
} from "../../planes/BrowserPlane.js";
import {
  PlaneScenarioEngine,
  type PlaneEvent,
  type PlaneScenario,
} from "./PlaneScenario.js";

export class FakeBrowserPlane implements BrowserPlane {
  private readonly scenarios = new PlaneScenarioEngine();

  public constructor(public readonly deviceRpc: DeviceRpcAdapter) {}

  public loadScenario(scenario: PlaneScenario): void {
    this.scenarios.loadScenario(scenario);
  }

  public events(): readonly PlaneEvent[] {
    return this.scenarios.events();
  }

  public assertExhausted(): void {
    this.scenarios.assertExhausted();
  }

  public async connect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    const connection = this.requiredResult<BrowserConnection>(
      "connect",
      this.scenarios.consume("connect", { ref: { ...ref } }, deadline),
    );
    return { ...connection, deviceRpc: this.deviceRpc };
  }

  public async reconnect(
    ref: SessionRef,
    deadline: Deadline,
  ): Promise<BrowserConnection> {
    const connection = this.requiredResult<BrowserConnection>(
      "reconnect",
      this.scenarios.consume("reconnect", { ref: { ...ref } }, deadline),
    );
    return { ...connection, deviceRpc: this.deviceRpc };
  }

  public async capture(
    ref: SessionRef,
    request: CaptureRequest,
    deadline: Deadline,
  ): Promise<Observation> {
    return this.requiredResult<Observation>(
      "capture",
      this.scenarios.consume(
        "capture",
        {
          ref: { ...ref },
          request: {
            format: request.format,
            maxWidth: request.maxWidth,
            maxHeight: request.maxHeight,
          },
        },
        deadline,
      ),
    );
  }

  public async mouse(
    ref: SessionRef,
    request: MouseRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt> {
    return this.requiredResult<MutationReceipt>(
      "mouse",
      this.scenarios.consume(
        "mouse",
        {
          ref: { ...ref },
          request: {
            observationId: request.observationId,
            requestId: request.requestId,
            actionCount: request.actions.length,
          },
        },
        deadline,
      ),
    );
  }

  public async keyboard(
    ref: SessionRef,
    request: KeyboardRequest,
    deadline: Deadline,
  ): Promise<MutationReceipt> {
    return this.requiredResult<MutationReceipt>(
      "keyboard",
      this.scenarios.consume(
        "keyboard",
        {
          ref: { ...ref },
          request: {
            observationId: request.observationId,
            requestId: request.requestId,
            actionCount: request.actions.length,
          },
        },
        deadline,
      ),
    );
  }

  public async paste(
    ref: SessionRef,
    request: PasteRequest,
    deadline: Deadline,
  ): Promise<PasteReceipt> {
    const encoded = Buffer.from(request.text, "utf8");
    return this.requiredResult<PasteReceipt>(
      "paste",
      this.scenarios.consume(
        "paste",
        {
          ref: { ...ref },
          request: {
            observationId: request.observationId,
            requestId: request.requestId,
            textByteLength: encoded.byteLength,
            textSha256: createHash("sha256").update(encoded).digest("hex"),
          },
        },
        deadline,
      ),
    );
  }

  public async release(
    ref: SessionRef,
    request: ReleaseRequest,
    deadline: Deadline,
  ): Promise<ReleaseReceipt> {
    return this.requiredResult<ReleaseReceipt>(
      "release",
      this.scenarios.consume(
        "release",
        { ref: { ...ref }, request: { requestId: request.requestId } },
        deadline,
      ),
    );
  }

  public async close(ref: SessionRef, deadline: Deadline): Promise<void> {
    this.scenarios.consume("close", { ref: { ...ref } }, deadline);
  }

  private requiredResult<T>(operation: string, result: unknown): T {
    if (result === undefined) {
      throw new Error(
        `Fake BrowserPlane step ${operation} requires an explicit result.`,
      );
    }
    return result as T;
  }
}
