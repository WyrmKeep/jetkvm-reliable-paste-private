type KeepaliveTimer = ReturnType<typeof setInterval>;
type SetIntervalFn = (handler: () => void, intervalMs: number) => KeepaliveTimer;
type ClearIntervalFn = (timer: KeepaliveTimer) => void;

export interface KeepaliveSchedulerOptions {
  intervalMs: number;
  onTick: () => void;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
}

export interface KeepaliveScheduler {
  handleKeyChange: (key: number, pressed: boolean) => void;
  setTickHandler: (onTick: () => void) => void;
  reset: () => void;
  heldKeyCount: () => number;
  isRunning: () => boolean;
}

class DefaultKeepaliveScheduler implements KeepaliveScheduler {
  private readonly intervalMs: number;
  private readonly setIntervalFn: SetIntervalFn;
  private readonly clearIntervalFn: ClearIntervalFn;
  private readonly heldKeys = new Set<number>();
  private onTick: () => void;
  private timer: KeepaliveTimer | null = null;

  constructor({
    intervalMs,
    onTick,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }: KeepaliveSchedulerOptions) {
    this.intervalMs = intervalMs;
    this.onTick = onTick;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
  }

  handleKeyChange(key: number, pressed: boolean) {
    if (pressed) {
      const wasIdle = this.heldKeys.size === 0;
      this.heldKeys.add(key);
      if (wasIdle) {
        this.startTimer();
      }
      return;
    }

    this.heldKeys.delete(key);
    if (this.heldKeys.size === 0) {
      this.stopTimer();
    }
  }

  setTickHandler(onTick: () => void) {
    this.onTick = onTick;
  }

  reset() {
    this.heldKeys.clear();
    this.stopTimer();
  }

  heldKeyCount() {
    return this.heldKeys.size;
  }

  isRunning() {
    return this.timer !== null;
  }

  private startTimer() {
    if (this.timer !== null || this.heldKeys.size === 0) return;

    this.timer = this.setIntervalFn(() => {
      this.onTick();
    }, this.intervalMs);
  }

  private stopTimer() {
    if (this.timer === null) return;

    this.clearIntervalFn(this.timer);
    this.timer = null;
  }
}

export function createKeepaliveScheduler(options: KeepaliveSchedulerOptions): KeepaliveScheduler {
  return new DefaultKeepaliveScheduler(options);
}
