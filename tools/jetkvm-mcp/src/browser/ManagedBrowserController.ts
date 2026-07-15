import type { Deadline } from "../device/DeviceRpcAdapter.js";
import type {
  AtxBridgeRequest,
  AutomationSnapshot,
  CaptureBridgeRequest,
  CaptureBridgeResult,
  KeyboardBridgeReceipt,
  KeyboardBridgeRequest,
  MouseBridgeRequest,
  MutationBridgeReceipt,
  PasteBridgeReceipt,
  PasteBridgeRequest,
  ReadBridgeRequest,
  ReadBridgeResult,
  ReleaseBridgeReceipt,
  ReleaseBridgeRequest,
} from "./bridgeProtocol.js";
import {
  createBrowserDeadlineBudget,
  type BrowserControllerPort,
  type BrowserDeadlineClock,
} from "./BrowserController.js";

export interface BrowserControllerFactory {
  open(deadline: Deadline): Promise<BrowserControllerPort>;
  dispose?(): Promise<void>;
}

/**
 * Recreates the page-owned bridge after close/reconnect while presenting one
 * stable controller identity to the session plane.
 */
export class ManagedBrowserController implements BrowserControllerPort {
  readonly #factory: BrowserControllerFactory;
  readonly #unavailableIdentity = Object.freeze({});
  readonly #clock: BrowserDeadlineClock;
  #current: BrowserControllerPort | null = null;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #disposed = false;

  public constructor(
    factory: BrowserControllerFactory,
    clock: BrowserDeadlineClock = () => performance.now(),
  ) {
    this.#factory = factory;
    this.#clock = clock;
  }

  public connectionIdentity(): object {
    return this.#current?.connectionIdentity() ?? this.#unavailableIdentity;
  }

  public async snapshot(deadline: Deadline): Promise<AutomationSnapshot> {
    return (await this.#ensure(deadline)).snapshot(deadline);
  }
  public async stableReadySnapshot(
    deadline: Deadline,
  ): Promise<AutomationSnapshot> {
    return (await this.#ensure(deadline)).stableReadySnapshot(deadline);
  }

  public async capture(
    request: CaptureBridgeRequest,
    deadline: Deadline,
  ): Promise<CaptureBridgeResult> {
    return (await this.#ensure(deadline)).capture(request, deadline);
  }

  public async mouse(
    request: MouseBridgeRequest,
    deadline: Deadline,
  ): Promise<MutationBridgeReceipt> {
    return (await this.#ensure(deadline)).mouse(request, deadline);
  }

  public async keyboard(
    request: KeyboardBridgeRequest,
    deadline: Deadline,
  ): Promise<KeyboardBridgeReceipt> {
    return (await this.#ensure(deadline)).keyboard(request, deadline);
  }

  public async paste(
    request: PasteBridgeRequest,
    deadline: Deadline,
  ): Promise<PasteBridgeReceipt> {
    return (await this.#ensure(deadline)).paste(request, deadline);
  }

  public async release(
    request: ReleaseBridgeRequest,
    deadline: Deadline,
  ): Promise<ReleaseBridgeReceipt> {
    return (await this.#ensure(deadline)).release(request, deadline);
  }

  public async readVideoState(
    request: ReadBridgeRequest,
    deadline: Deadline,
  ): Promise<ReadBridgeResult> {
    return (await this.#ensure(deadline)).readVideoState(request, deadline);
  }

  public async readEdid(
    request: ReadBridgeRequest,
    deadline: Deadline,
  ): Promise<ReadBridgeResult> {
    return (await this.#ensure(deadline)).readEdid(request, deadline);
  }

  public async performAtx(
    request: AtxBridgeRequest,
    deadline: Deadline,
  ): Promise<ReadBridgeResult> {
    return (await this.#ensure(deadline)).performAtx(request, deadline);
  }

  public async reconnect(deadline: Deadline): Promise<void> {
    const budget = createBrowserDeadlineBudget(deadline, this.#clock);
    await this.#serialize(async () => {
      this.#assertActive();
      const previous = this.#current;
      if (previous !== null) {
        await previous.close(budget.remaining());
        this.#current = null;
      }
      this.#current = await this.#factory.open(budget.remaining());
    });
  }

  public async close(deadline: Deadline): Promise<void> {
    await this.#serialize(async () => {
      const current = this.#current;
      if (current !== null) {
        await current.close(deadline);
        this.#current = null;
      }
    });
  }

  public async dispose(deadline: Deadline): Promise<void> {
    if (this.#disposed) return;
    await this.close(deadline);
    await this.#factory.dispose?.();
    this.#disposed = true;
  }

  async #ensure(deadline: Deadline): Promise<BrowserControllerPort> {
    await this.#serialize(async () => {
      this.#assertActive();
      this.#current ??= await this.#factory.open(deadline);
    });
    const current = this.#current;
    if (current === null)
      throw new Error("Managed browser controller is unavailable.");
    return current;
  }

  async #serialize(operation: () => Promise<void>): Promise<void> {
    const previous = this.#lifecycleTail;
    const slot = Promise.withResolvers<void>();
    this.#lifecycleTail = previous.then(
      () => slot.promise,
      () => slot.promise,
    );
    await previous.catch(() => undefined);
    try {
      await operation();
    } finally {
      slot.resolve();
    }
  }

  #assertActive(): void {
    if (this.#disposed)
      throw new Error("Managed browser controller is disposed.");
  }
}
