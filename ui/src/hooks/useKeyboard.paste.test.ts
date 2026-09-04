import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  ready: true,
  sendMacro: vi.fn(() => true),
  sendReset: vi.fn(),
  legacy: vi.fn(),
  hid: { isPasteInProgress: false, keysDownState: { keys: [0, 0, 0, 0, 0, 0], modifier: 0 } },
  rtc: { rpcHidChannel: null as unknown, rpcHidProtocolVersion: 1 as number | null, hidRpcDisabled: false },
}));
vi.mock("react", () => ({
  useCallback: <T>(fn: T) => fn,
  useRef: <T>(value: T) => ({ current: value }),
}));
vi.mock("@/hooks/stores", () => ({
  hidKeyBufferSize: 6,
  hidErrorRollOver: 1,
  useRTCStore: Object.assign(() => fixture.rtc, { getState: () => fixture.rtc }),
  useHidStore: Object.assign(() => ({ ...fixture.hid, setKeysDownState: vi.fn(), setKeyboardLedState: vi.fn(), setPasteModeEnabled: vi.fn() }), {
    getState: () => ({ ...fixture.hid, setPasteModeEnabled: vi.fn() }),
    subscribe: () => () => undefined,
  }),
}));
vi.mock("@/hooks/useJsonRpc", () => ({ useJsonRpc: () => ({ send: fixture.legacy }) }));
vi.mock("@/hooks/useHidRpc", () => ({ useHidRpc: () => ({
  rpcHidChannel: fixture.rtc.rpcHidChannel,
  rpcHidReady: fixture.ready,
  reportKeyboardEvent: fixture.sendReset,
  reportKeyboardMacroEvent: fixture.sendMacro,
  reportKeypressEvent: vi.fn(),
  cancelOngoingKeyboardMacro: vi.fn(),
  reportKeypressKeepAlive: vi.fn(),
}) }));

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 300 * 1024;
  bufferedAmountLowThreshold = 0;
}
const options = (signal: AbortSignal) => ({
  keyboard: { chars: { a: { key: "KeyA" } } },
  delayMs: 20,
  maxStepsPerBatch: 128,
  maxBytesPerBatch: 2318,
  finalSettleMs: 3000,
  signal,
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.ready = true;
  fixture.sendMacro.mockReturnValue(true);
  fixture.hid.isPasteInProgress = false;
  fixture.rtc.rpcHidChannel = new Channel();
  fixture.rtc.rpcHidProtocolVersion = 1;
  fixture.rtc.hidRpcDisabled = false;
});
afterEach(() => { vi.useRealTimers(); });

describe("paste input safety", () => {
  it("does not silently use legacy typing before HID readiness", async () => {
    fixture.ready = false;
    const { default: useKeyboard } = await import("./useKeyboard");
    const keyboard = useKeyboard();
    await expect(keyboard.executePasteText("a", options(new AbortController().signal))).rejects.toThrow("requires ready HID RPC");
    expect(fixture.sendMacro).not.toHaveBeenCalled();
    expect(fixture.legacy).not.toHaveBeenCalled();
  });
  it("rejects a macro refused by the transport", async () => {
    fixture.sendMacro.mockReturnValue(false);
    const { default: useKeyboard } = await import("./useKeyboard");
    await expect(useKeyboard().executePasteText("a", options(new AbortController().signal))).rejects.toThrow("was not sent");
  });
  it("suppresses browser reset while the backend owns paste, not explicit reset", async () => {
    const { default: useKeyboard } = await import("./useKeyboard");
    const keyboard = useKeyboard();
    fixture.hid.isPasteInProgress = true;
    await keyboard.resetKeyboardStateOnBlur();
    expect(fixture.sendReset).not.toHaveBeenCalled();
    await keyboard.resetKeyboardState();
    expect(fixture.sendReset).toHaveBeenCalledTimes(1);
  });
  it("protects the submitted-before-active window and restores ordinary blur reset", async () => {
    const { default: useKeyboard } = await import("./useKeyboard");
    const keyboard = useKeyboard();
    const abort = new AbortController();
    const execution = keyboard.executePasteText("a", options(abort.signal));
    const observed = execution.catch(error => error);
    await keyboard.resetKeyboardStateOnBlur();
    expect(fixture.sendReset).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 0));
    abort.abort();
    await expect(observed).resolves.toBeInstanceOf(Error);
    await keyboard.resetKeyboardStateOnBlur();
    expect(fixture.sendReset).toHaveBeenCalledTimes(1);
  });
  it("rejects channel loss during a bufferedAmount wait", async () => {
    const { default: useKeyboard } = await import("./useKeyboard");
    const keyboard = useKeyboard();
    const channel = fixture.rtc.rpcHidChannel as Channel;
    const abort = new AbortController();
    const execution = keyboard.executePasteText("a", options(abort.signal));
    const observed = execution.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 0));
    channel.readyState = "closed";
    channel.dispatchEvent(new Event("close"));
    await expect(observed).resolves.toMatchObject({ message: "Paste HID channel closed during backpressure" });
    expect(channel.bufferedAmountLowThreshold).toBe(0);
  });
});
