import type {
  BrowserOwnedRpcChannel,
  DeviceRpcChannelCloseListener,
  DeviceRpcChannelMessageListener,
  DeviceRpcChannelWriteResult,
} from "../../device/DeviceRpcAdapter.js";

export interface FakeDeviceRpcChannelOptions {
  readonly beforeWrite?: (payload: string) => void;
  readonly rejectWrite?: boolean;
  readonly onClose?: () => void;
}

export class FakeDeviceRpcChannel implements BrowserOwnedRpcChannel {
  private readonly messages = new Set<DeviceRpcChannelMessageListener>();
  private readonly closes = new Set<DeviceRpcChannelCloseListener>();
  private readonly attempted: string[] = [];
  private readonly accepted: string[] = [];
  private readonly writeWaiters: Array<{ count: number; resolve: () => void }> =
    [];
  private state: "open" | "closed" = "open";

  public constructor(
    private readonly options: FakeDeviceRpcChannelOptions = {},
  ) {}

  public get readyState(): "open" | "closed" {
    return this.state;
  }

  public listen(
    onMessage: DeviceRpcChannelMessageListener,
    onClose: DeviceRpcChannelCloseListener,
  ): () => void {
    this.messages.add(onMessage);
    this.closes.add(onClose);
    return () => {
      this.messages.delete(onMessage);
      this.closes.delete(onClose);
    };
  }

  public write(payload: string): DeviceRpcChannelWriteResult {
    this.attempted.push(payload);
    this.options.beforeWrite?.(payload);
    if (this.state !== "open" || this.options.rejectWrite === true) {
      this.notifyWriteWaiters();
      return { written: false };
    }
    this.accepted.push(payload);
    this.notifyWriteWaiters();
    return { written: true };
  }

  public close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.options.onClose?.();
    for (const listener of [...this.closes]) listener();
  }

  public isClosed(): boolean {
    return this.state === "closed";
  }

  public writes(): readonly string[] {
    return this.attempted;
  }

  public acceptedWrites(): readonly string[] {
    return this.accepted;
  }

  public decodedWrite(index: number): unknown {
    const payload = this.attempted[index];
    if (payload === undefined)
      throw new Error(`No write exists at index ${index}.`);
    return JSON.parse(payload) as unknown;
  }

  public async waitForWrites(count: number): Promise<void> {
    if (this.attempted.length >= count) return;
    await new Promise<void>((resolve) =>
      this.writeWaiters.push({ count, resolve }),
    );
  }

  public emitRaw(payload: string): void {
    for (const listener of [...this.messages]) listener(payload);
  }

  public respondToWrite(
    index: number,
    result: unknown,
    options: { duplicate?: boolean } = {},
  ): void {
    const request = this.decodedWrite(index);
    if (
      typeof request !== "object" ||
      request === null ||
      !("id" in request) ||
      typeof request.id !== "string"
    ) {
      throw new Error(`Write ${index} has no string correlation id.`);
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
    this.emitRaw(payload);
    if (options.duplicate === true) this.emitRaw(payload);
  }

  public respondWithError(index: number, code = -32_000): void {
    const request = this.decodedWrite(index);
    if (
      typeof request !== "object" ||
      request === null ||
      !("id" in request) ||
      typeof request.id !== "string"
    ) {
      throw new Error(`Write ${index} has no string correlation id.`);
    }
    this.emitRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code, message: "Downstream RPC failed." },
      }),
    );
  }

  private notifyWriteWaiters(): void {
    for (let index = this.writeWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.writeWaiters[index];
      if (waiter !== undefined && this.attempted.length >= waiter.count) {
        this.writeWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}
