import { useCallback, useRef } from "react";

import {
  KeyboardLedStateMessage,
  KeyboardMacroStateMessage,
  KeyboardMacroStep,
  KeysDownStateMessage,
} from "@/hooks/hidRpc";
import {
  hidErrorRollOver,
  hidKeyBufferSize,
  KeysDownState,
  useHidStore,
  useRTCStore,
} from "@/hooks/stores";
import { useHidRpc } from "@/hooks/useHidRpc";
import { JsonRpcResponse, useJsonRpc } from "@/hooks/useJsonRpc";
import { hidKeyToModifierMask, keys, modifiers } from "@/keyboardMappings";
import { sleep } from "@/utils";
import {
  buildPasteMacroBatches,
  DEFAULT_LARGE_PASTE_POLICY,
  estimateBatchBytes,
  partitionBatchesByChunkChars,
  type KeyboardLayoutLike,
  type PasteChunkPlan,
} from "@/utils/pasteMacro";

const MACRO_RESET_KEYBOARD_STATE = {
  keys: new Array(hidKeyBufferSize).fill(0),
  modifier: 0,
  delay: 0,
};

// Module-level guards for the Phase 2 chunk-aware paste path.
//
// `executePasteTextInFlight` is the correctness guard against concurrent
// executePasteText invocations on the same WebRTC channel. It lives at
// module scope (not inside useKeyboard or PasteModal) so that even if
// PasteModal unmounts and remounts between chunks — e.g., when
// ActionBar's PopoverPanel unmounts on outside click — the flag
// survives and the second paste is rejected before it can start
// interleaving batches with the first. PasteModal's own `pasteActive`
// state is still used for UI disabled-button rendering, but the
// correctness-level guard is this flag.
//
// `pasteStateSupportObserved` tracks whether the device this session is
// connected to has EVER emitted an active KeyboardMacroStateMessage with
// IsPaste true (set in the useHidRpc onMessage handler below).
//
// `pasteStateSupportNegativeLatched` tracks the opposite result: this JS
// session tried the first-chunk paste-state probe and no start event arrived
// before the short probe deadline. Older v1 firmware without Phase 1 still
// advertises the same HID RPC protocol version (0x01), so `rpcHidReady`
// alone is not a reliable indicator of paste-state support. The negative
// latch keeps those devices on the safe non-chunk path after they pay the
// probe cost once per browser session.
let executePasteTextInFlight = false;
let pasteStateSupportObserved = false;
let pasteStateSupportChannel: RTCDataChannel | null = null;
let pasteStateSupportNegativeLatched = false;
let pasteFailureSequence = 0;

function syncPasteStateSupportChannel(channel: RTCDataChannel | null): boolean {
  if (pasteStateSupportChannel === channel) {
    return pasteStateSupportObserved;
  }
  pasteStateSupportChannel = channel;
  pasteStateSupportObserved = false;
  pasteStateSupportNegativeLatched = false;
  useHidStore.getState().setPasteModeEnabled(false);
  return false;
}

export interface MacroStep {
  keys: string[] | null;
  modifiers: string[] | null;
  delay: number;
}

export type MacroSteps = MacroStep[];

export interface PasteExecutionProgress {
  completedBatches: number;
  totalBatches: number;
  phase: "sending" | "draining" | "pausing";
  chunkIndex: number; // 1-based. 0 when chunk mode is off.
  chunkTotal: number; // 0 when chunk mode is off.
}

export type PasteExecutionTrace =
  | {
      kind: "batch";
      batchIndex: number;
      totalBatches: number;
      stepCount: number;
      estimatedBytes: number;
      bufferedAmount: number;
    }
  | {
      kind: "chunk-sent";
      chunkIndex: number;
      chunkTotal: number;
      sourceChars: number;
      batches: number;
    }
  | {
      kind: "chunk-drained";
      chunkIndex: number;
      drainMs: number;
    }
  | {
      kind: "chunk-pause";
      chunkIndex: number;
      pauseMs: number;
    };

export interface ExecutePasteTextOptions {
  keyboard: KeyboardLayoutLike;
  delayMs: number;
  maxStepsPerBatch: number;
  maxBytesPerBatch: number;
  finalSettleMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: PasteExecutionProgress) => void;
  onTrace?: (trace: PasteExecutionTrace) => void;
}

type PasteDrainMode = "required" | "bestEffort";

const PASTE_DRAIN_DEFAULT_ARM_WINDOW_MS = 200;
const PASTE_DRAIN_DEFAULT_SETTLE_MS = 500;
const PASTE_STATE_SUPPORT_PROBE_TIMEOUT_MS = 2000;

/**
 * Wait for a paste session to drain from the backend macro queue.
 *
 * Modes:
 * - "bestEffort" — resolves on timeout or on the arm window only while no
 *   paste has been observed. Once a paste start is observed, timeout rejects
 *   so a supported backend cannot report success before a late failed
 *   completion event arrives. Callers can disable the no-start arm window
 *   when a supported first paste may emit state after the default arm window.
 * - "required" — rejects on timeout, never takes the arm-window fast path.
 *   Reserved for #38's chunk boundaries in Phase 2. No Phase 1 call sites.
 *
 * Correctness: the helper subscribes to useHidStore BEFORE sampling the
 * current isPasteInProgress value, and latches a local `seenTrue` flag.
 * The clean-drain exit fires only when the subscription observes
 * isPasteInProgress transition to false AFTER we've already seen it be
 * true. Without the latch, any unrelated store mutation arriving while
 * isPasteInProgress is still in its late-start false window would resolve
 * the wait early — reintroducing a softer version of the race we are
 * trying to remove.
 *
 * In bestEffort mode, if the arm window elapses without isPasteInProgress
 * ever going true, we assume the paste never materialized (zero batches,
 * immediate error, send loop that did nothing) and resolve without
 * waiting for the full timeout.
 */
async function waitForPasteDrain(
  mode: PasteDrainMode,
  timeoutMs: number,
  signal?: AbortSignal,
  settleMs: number = PASTE_DRAIN_DEFAULT_SETTLE_MS,
  armWindowMs: number = PASTE_DRAIN_DEFAULT_ARM_WINDOW_MS,
  failureSequenceBaseline: number = pasteFailureSequence,
  allowNoStartFastPath = true,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let seenTrue = false;
    let armHandle: ReturnType<typeof setTimeout> | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => undefined;

    const cleanup = () => {
      if (armHandle !== undefined) {
        clearTimeout(armHandle);
        armHandle = undefined;
      }
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    };

    const resolveClean = () => {
      if (done) return;
      done = true;
      cleanup();
      // Observed drain → host USB settle delay before the caller resumes.
      // Keep the settle tail abort-aware even after the drain subscription
      // has been cleaned up.
      abortableSleep(settleMs, signal).then(resolve, reject);
    };

    const resolveImmediate = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    const rejectErr = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => rejectErr(new Error("Paste execution aborted"));

    const rejectIfPasteFailed = () => {
      if (pasteFailureSequence === failureSequenceBaseline) return false;
      rejectErr(new Error("Paste macro failed"));
      return true;
    };

    // Subscribe FIRST. Every store update runs this callback; we update
    // the `seenTrue` latch on truthy updates and only take the clean-drain
    // exit on a falsy update AFTER seenTrue has been latched.
    unsubscribe = useHidStore.subscribe(state => {
      if (rejectIfPasteFailed()) return;
      if (state.isPasteInProgress) {
        seenTrue = true;
        return;
      }
      if (seenTrue) {
        resolveClean();
      }
    });

    // Now sample the current value. If a state change happened between
    // subscribe() and getState(), the subscription callback above already
    // set seenTrue — this assignment is harmlessly redundant in that case.
    // If no change happened, we pick up whatever the store says right now.
    seenTrue = useHidStore.getState().isPasteInProgress;

    if (rejectIfPasteFailed()) {
      return;
    }

    // Fast-reject if the caller already aborted before we even started.
    if (signal?.aborted) {
      rejectErr(new Error("Paste execution aborted"));
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    timeoutHandle = setTimeout(() => {
      if (rejectIfPasteFailed()) return;
      if (mode === "required" || seenTrue) {
        rejectErr(new Error(`waitForPasteDrain: paste drain timed out after ${timeoutMs}ms`));
      } else {
        // bestEffort with no observed paste: treat timeout as success, skip settle.
        resolveImmediate();
      }
    }, timeoutMs);

    // Arm window — bestEffort only, and only if we haven't yet seen a
    // paste become active. If after armWindowMs the store still says
    // isPasteInProgress === false AND seenTrue is still false, assume
    // the paste never materialized and resolve. If the store has gone
    // true during the window, flip seenTrue and defer to the subscription.
    if (mode === "bestEffort" && !seenTrue && allowNoStartFastPath) {
      armHandle = setTimeout(() => {
        armHandle = undefined;
        if (rejectIfPasteFailed()) return;
        if (useHidStore.getState().isPasteInProgress) {
          seenTrue = true;
          return;
        }
        if (!seenTrue) {
          resolveImmediate();
        }
      }, armWindowMs);
    }
  });
}

/**
 * Probe whether the current device emits paste-state start messages.
 *
 * This is intentionally start-only, not a full drain. It lets the first large
 * paste of a fresh modern session enter chunk mode immediately, while legacy
 * firmware can fall back before any required drain waits on events that will
 * never arrive.
 */
async function waitForPasteStartProbe(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let done = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    };

    const resolveValue = (value: boolean) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };

    const rejectErr = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => rejectErr(new Error("Paste execution aborted"));

    const unsubscribe = useHidStore.subscribe(state => {
      if (state.isPasteInProgress) {
        resolveValue(true);
      }
    });

    if (useHidStore.getState().isPasteInProgress) {
      resolveValue(true);
      return;
    }

    if (signal?.aborted) {
      rejectErr(new Error("Paste execution aborted"));
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutHandle = setTimeout(() => resolveValue(false), timeoutMs);
  });
}

/**
 * Sleep for `ms` milliseconds, rejecting early if `signal` aborts.
 *
 * Used by Phase 2's chunk-aware paste loop to pause between chunks
 * without blocking cancel. The rejection error message matches
 * waitForPasteDrain's abort path so executePasteText's catch block
 * treats them uniformly.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Paste execution aborted"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      reject(new Error("Paste execution aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      timer = undefined;
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export default function useKeyboard() {
  const { send } = useJsonRpc();
  const { rpcDataChannel } = useRTCStore();
  const { keysDownState, setKeysDownState, setKeyboardLedState, setPasteModeEnabled } =
    useHidStore();

  const abortController = useRef<AbortController | null>(null);
  const setAbortController = useCallback((ac: AbortController | null) => {
    abortController.current = ac;
  }, []);

  // Keepalive timer management
  const keepAliveTimerRef = useRef<number | null>(null);

  // INTRODUCTION: The earlier version of the JetKVM device shipped with all keyboard state
  // being tracked on the browser/client-side. When adding the keyPressReport API to the
  // device-side code, we have to still support the situation where the browser/client-side code
  // is running on the cloud against a device that has not been updated yet and thus does not
  // support the keyPressReport API. In that case, we need to handle the key presses locally
  // and send the full state to the device, so it can behave like a real USB HID keyboard.
  // This flag indicates whether the keyPressReport API is available on the device which is
  // dynamically set when the device responds to the first key press event or reports its
  // keysDownState when queried since the keyPressReport was introduced together with the
  // getKeysDownState API.

  // HidRPC is a binary format for exchanging keyboard and mouse events
  const {
    reportKeyboardEvent: sendKeyboardEventHidRpc,
    reportKeypressEvent: sendKeypressEventHidRpc,
    reportKeyboardMacroEvent: sendKeyboardMacroEventHidRpc,
    cancelOngoingKeyboardMacro: cancelOngoingKeyboardMacroHidRpc,
    reportKeypressKeepAlive: sendKeypressKeepAliveHidRpc,
    rpcHidChannel,
    rpcHidReady,
  } = useHidRpc((message, sourceChannel) => {
    switch (message.constructor) {
      case KeysDownStateMessage:
        setKeysDownState((message as KeysDownStateMessage).keysDownState);
        break;
      case KeyboardLedStateMessage:
        setKeyboardLedState((message as KeyboardLedStateMessage).keyboardLedState);
        break;
      case KeyboardMacroStateMessage: {
        if (sourceChannel !== useRTCStore.getState().rpcHidChannel) break;
        const macroState = message as KeyboardMacroStateMessage;
        if (!macroState.isPaste) break;
        syncPasteStateSupportChannel(sourceChannel);
        // Latch paste-state support the first time we observe a real
        // paste-state start event. Positive evidence clears any earlier
        // probe-timeout result from this JS session.
        if (macroState.state) {
          pasteStateSupportObserved = true;
          pasteStateSupportNegativeLatched = false;
        } else if (macroState.failed) {
          pasteFailureSequence++;
        }
        setPasteModeEnabled(macroState.state);
        break;
      }
      default:
        break;
    }
  });

  const handleLegacyKeyboardReport = useCallback(
    async (keys: number[], modifier: number) => {
      send("keyboardReport", { keys, modifier }, (resp: JsonRpcResponse) => {
        if ("error" in resp) {
          console.error(`Failed to send keyboard report ${keys} ${modifier}`, resp.error);
        }

        // On older backends, we need to set the keysDownState manually since without the hidRpc API, the state doesn't trickle down from the backend
        setKeysDownState({ modifier, keys });
      });
    },
    [send, setKeysDownState],
  );

  const sendKeystrokeLegacy = useCallback(
    async (keys: number[], modifier: number, ac?: AbortController) => {
      return await new Promise<void>((resolve, reject) => {
        const abortListener = () => {
          reject(new Error("Keyboard report aborted"));
        };

        ac?.signal?.addEventListener("abort", abortListener);

        send("keyboardReport", { keys, modifier }, params => {
          if ("error" in params) return reject(params.error);
          resolve();
        });
      });
    },
    [send],
  );

  const KEEPALIVE_INTERVAL = 50;

  const cancelKeepAlive = useCallback(() => {
    if (keepAliveTimerRef.current) {
      clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
  }, []);

  const scheduleKeepAlive = useCallback(() => {
    // Clears existing keepalive timer
    cancelKeepAlive();

    keepAliveTimerRef.current = setInterval(() => {
      sendKeypressKeepAliveHidRpc();
    }, KEEPALIVE_INTERVAL);
  }, [cancelKeepAlive, sendKeypressKeepAliveHidRpc]);

  // resetKeyboardState is used to reset the keyboard state to no keys pressed and no modifiers.
  // This is useful for macros, in case of client-side rollover, and when the browser loses focus
  const resetKeyboardState = useCallback(async () => {
    // Cancel keepalive since we're resetting the keyboard state
    cancelKeepAlive();
    // Reset the keys buffer to zeros and the modifier state to zero
    const { keys, modifier } = MACRO_RESET_KEYBOARD_STATE;
    if (rpcHidReady) {
      sendKeyboardEventHidRpc(keys, modifier);
    } else {
      // Older backends don't support the hidRpc API, so we send the full reset state
      handleLegacyKeyboardReport(keys, modifier);
    }
  }, [rpcHidReady, sendKeyboardEventHidRpc, handleLegacyKeyboardReport, cancelKeepAlive]);

  // IMPORTANT: See the keyPressReportApiAvailable comment above for the reason this exists
  function simulateDeviceSideKeyHandlingForLegacyDevices(
    state: KeysDownState,
    key: number,
    press: boolean,
  ): KeysDownState {
    // IMPORTANT: This code parallels the logic in the kernel's hid-gadget driver
    // for handling key presses and releases. It ensures that the USB gadget
    // behaves similarly to a real USB HID keyboard. This logic is paralleled
    // in the device-side code in hid_keyboard.go so make sure to keep them in sync.
    let modifiers = state.modifier;
    const keys = state.keys;
    const modifierMask = hidKeyToModifierMask[key] || 0;

    if (modifierMask !== 0) {
      // If the key is a modifier key, we update the keyboardModifier state
      // by setting or clearing the corresponding bit in the modifier byte.
      // This allows us to track the state of dynamic modifier keys like
      // Shift, Control, Alt, and Super.
      if (press) {
        modifiers |= modifierMask;
      } else {
        modifiers &= ~modifierMask;
      }
    } else {
      // handle other keys that are not modifier keys by placing or removing them
      // from the key buffer since the buffer tracks currently pressed keys
      let overrun = true;
      for (let i = 0; i < hidKeyBufferSize; i++) {
        // If we find the key in the buffer the buffer, we either remove it (if press is false)
        // or do nothing (if down is true) because the buffer tracks currently pressed keys
        // and if we find a zero byte, we can place the key there (if press is true)
        if (keys[i] === key || keys[i] === 0) {
          if (press) {
            keys[i] = key; // overwrites the zero byte or the same key if already pressed
          } else {
            // we are releasing the key, remove it from the buffer
            if (keys[i] !== 0) {
              keys.splice(i, 1);
              keys.push(0); // add a zero at the end
            }
          }
          overrun = false; // We found a slot for the key
          break;
        }
      }

      // If we reach here it means we didn't find an empty slot or the key in the buffer
      if (overrun) {
        if (press) {
          console.warn(`keyboard buffer overflow current keys ${keys}, key: ${key} not added`);
          // Fill all key slots with ErrorRollOver (0x01) to indicate overflow
          keys.length = hidKeyBufferSize;
          keys.fill(hidErrorRollOver);
        } else {
          // If we are releasing a key, and we didn't find it in a slot, who cares?
          console.debug(`key ${key} not found in buffer, nothing to release`);
        }
      }
    }
    return { modifier: modifiers, keys };
  }

  const sendKeypress = useCallback(
    (key: number, press: boolean) => {
      cancelKeepAlive();

      sendKeypressEventHidRpc(key, press);

      if (press) {
        scheduleKeepAlive();
      }
    },
    [sendKeypressEventHidRpc, scheduleKeepAlive, cancelKeepAlive],
  );

  // handleKeyPress is used to handle a key press or release event.
  // This function handle both key press and key release events.
  // It checks if the keyPressReport API is available and sends the key press event.
  // If the keyPressReport API is not available, it simulates the device-side key
  // handling for legacy devices and updates the keysDownState accordingly.
  // It then sends the full keyboard state to the device.
  const handleKeyPress = useCallback(
    async (key: number, press: boolean) => {
      if (rpcDataChannel?.readyState !== "open" && !rpcHidReady) return;
      if ((key || 0) === 0) return; // ignore zero key presses (they are bad mappings)

      if (rpcHidReady) {
        // if the keyPress api is available, we can just send the key press event
        // sendKeypressEvent is used to send a single key press/release event to the device.
        // It sends the key and whether it is pressed or released.
        // Older device version doesn't support this API, so we will switch to local key handling
        // In that case we will switch to local key handling and update the keysDownState
        // in client/browser-side code using simulateDeviceSideKeyHandlingForLegacyDevices.
        sendKeypress(key, press);
      } else {
        // Older backends don't support the hidRpc API, so we need:
        // 1. Calculate the state
        // 2. Send the newly calculated state to the device
        const downState = simulateDeviceSideKeyHandlingForLegacyDevices(keysDownState, key, press);

        handleLegacyKeyboardReport(downState.keys, downState.modifier);

        // if we just sent ErrorRollOver, reset to empty state
        if (downState.keys[0] === hidErrorRollOver) {
          resetKeyboardState();
        }
      }
    },
    [
      rpcDataChannel?.readyState,
      rpcHidReady,
      keysDownState,
      handleLegacyKeyboardReport,
      resetKeyboardState,
      sendKeypress,
    ],
  );

  // Cleanup function to cancel keepalive timer
  const cleanup = useCallback(() => {
    cancelKeepAlive();
  }, [cancelKeepAlive]);

  // executeMacro is used to execute a macro consisting of multiple steps.
  // Each step can have multiple keys, multiple modifiers and a delay.
  // The keys and modifiers are pressed together and held for the delay duration.
  // After the delay, the keys and modifiers are released and the next step is executed.
  // If a step has no keys or modifiers, it is treated as a delay-only step.
  // A small pause is added between steps to ensure that the device can process the events.
  const executeMacroRemote = useCallback(
    async (steps: MacroSteps, isPaste = false) => {
      const macro: KeyboardMacroStep[] = [];

      for (const [_, step] of steps.entries()) {
        const keyValues = (step.keys || []).map(key => keys[key]).filter(Boolean);
        const modifierMask: number = (step.modifiers || [])
          .map(mod => modifiers[mod])
          .reduce((acc, val) => acc + val, 0);

        if (keyValues.length > 0 || modifierMask > 0) {
          macro.push({ keys: keyValues, modifier: modifierMask, delay: 5 });
          macro.push({ ...MACRO_RESET_KEYBOARD_STATE, delay: step.delay || 25 });
        }
      }

      sendKeyboardMacroEventHidRpc(macro, isPaste);
    },
    [sendKeyboardMacroEventHidRpc],
  );

  const executeMacroClientSide = useCallback(
    async (steps: MacroSteps) => {
      const promises: (() => Promise<void>)[] = [];

      const ac = new AbortController();
      setAbortController(ac);

      for (const [_, step] of steps.entries()) {
        const keyValues = (step.keys || []).map(key => keys[key]).filter(Boolean);
        const modifierMask: number = (step.modifiers || [])
          .map(mod => modifiers[mod])
          .reduce((acc, val) => acc + val, 0);

        // If the step has keys and/or modifiers, press them and hold for the delay
        if (keyValues.length > 0 || modifierMask > 0) {
          promises.push(() => sendKeystrokeLegacy(keyValues, modifierMask, ac));
          promises.push(() => resetKeyboardState());
          promises.push(() => sleep(step.delay || 100));
        }
      }

      const runAll = async () => {
        for (const promise of promises) {
          // Check if we've been aborted before executing each promise
          if (ac.signal.aborted) {
            throw new Error("Macro execution aborted");
          }
          await promise();
        }
      };

      return await new Promise<void>((resolve, reject) => {
        // Set up abort listener
        const abortListener = () => {
          reject(new Error("Macro execution aborted"));
        };

        ac.signal.addEventListener("abort", abortListener);

        runAll()
          .then(() => {
            ac.signal.removeEventListener("abort", abortListener);
            resolve();
          })
          .catch(error => {
            ac.signal.removeEventListener("abort", abortListener);
            reject(error);
          });
      });
    },
    [sendKeystrokeLegacy, resetKeyboardState, setAbortController],
  );

  const executeMacro = useCallback(
    async (steps: MacroSteps) => {
      if (rpcHidReady) {
        return executeMacroRemote(steps);
      }
      return executeMacroClientSide(steps);
    },
    [rpcHidReady, executeMacroRemote, executeMacroClientSide],
  );

  const executePasteMacro = useCallback(
    async (steps: MacroSteps) => {
      if (rpcHidReady) {
        return executeMacroRemote(steps, true);
      }
      return executeMacroClientSide(steps);
    },
    [rpcHidReady, executeMacroRemote, executeMacroClientSide],
  );

  const executePasteText = useCallback(
    async (text: string, options: ExecutePasteTextOptions) => {
      // Module-level concurrency guard. PasteModal also has a local
      // in-flight guard for UI responsiveness, but that guard dies
      // when the popover unmounts (e.g., click-outside dismissal during
      // a chunk boundary). This flag survives component remounts and
      // is the correctness-level guard against interleaved pastes on
      // the same data channel.
      if (executePasteTextInFlight) {
        throw new Error("A paste is already in progress");
      }
      executePasteTextInFlight = true;
      try {
        const {
          keyboard,
          delayMs,
          maxStepsPerBatch,
          maxBytesPerBatch,
          finalSettleMs,
          signal,
          onProgress,
          onTrace,
        } = options;

        const { batches, invalidChars, batchStats } = buildPasteMacroBatches(
          text,
          keyboard,
          delayMs,
          maxStepsPerBatch,
          maxBytesPerBatch,
        );

        if (invalidChars.length > 0) {
          throw new Error(`Unsupported characters: ${invalidChars.join(", ")}`);
        }

        const pasteFailureBaseline = pasteFailureSequence;

        // Pipeline flow control constants. Values untouched in Phase 2.
        const PASTE_LOW_WATERMARK = 64 * 1024;
        const PASTE_HIGH_WATERMARK = 256 * 1024;

        const channel = rpcHidChannel;
        if (!channel || channel.readyState !== "open") {
          throw new Error("HID data channel not available");
        }
        const pasteStateSupportedForChannel = syncPasteStateSupportChannel(channel);

        // Save and set bufferedAmount threshold for paste flow control
        const prevThreshold = channel.bufferedAmountLowThreshold;
        channel.bufferedAmountLowThreshold = PASTE_LOW_WATERMARK;

        // Abort-aware high-watermark drain wait. Phase 2 upgrade over the
        // pre-existing drainResolve-only pattern: if signal.abort() fires
        // while the loop is parked on a full channel buffer, the pending
        // waitForChannelDrain() rejects immediately rather than waiting
        // for the next bufferedamountlow event. drainReject is the paired
        // slot; onBufferedDrainAbort is installed alongside the existing
        // onLow listener. The low-watermark resume path is unchanged —
        // onLow still fires on bufferedamountlow and resolves the pending
        // promise exactly as before.
        let drainResolve: (() => void) | null = null;
        let drainReject: ((err: Error) => void) | null = null;
        const waitForChannelDrain = () =>
          new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("Paste execution aborted"));
              return;
            }
            drainResolve = resolve;
            drainReject = reject;
          });
        const onLow = () => {
          const resolver = drainResolve;
          drainResolve = null;
          drainReject = null;
          resolver?.();
        };
        const onBufferedDrainAbort = () => {
          const rejecter = drainReject;
          drainResolve = null;
          drainReject = null;
          rejecter?.(new Error("Paste execution aborted"));
        };
        channel.addEventListener("bufferedamountlow", onLow);
        signal?.addEventListener("abort", onBufferedDrainAbort);

        try {
          // Phase 3c chunk policy. Chunk mode is automatic above the threshold
          // on RPC HID unless this JS session has already probed and found no
          // paste-state support. A fresh modern session no longer needs a prior
          // non-chunk paste to arm the positive latch.
          // Legacy/client-side execution is still excluded by rpcHidReady. Older
          // RPC HID firmware gets one short first-chunk probe; if no paste-state
          // start arrives, the negative latch sends this paste remainder and
          // later large pastes through the existing non-chunk path.
          const policy = DEFAULT_LARGE_PASTE_POLICY;
          let chunkMode =
            rpcHidReady &&
            !pasteStateSupportNegativeLatched &&
            text.length >= policy.autoThresholdChars;
          let chunks: PasteChunkPlan[] = chunkMode
            ? partitionBatchesByChunkChars(batchStats, policy.chunkChars)
            : [
                {
                  chunkIndex: 0,
                  batchStartIndex: 0,
                  batchEndIndex: batches.length,
                  sourceChars: text.length,
                },
              ];
          let chunkTotalForProgress = chunkMode ? chunks.length : 0;
          let pasteStateSupportProvenForPaste = pasteStateSupportedForChannel;
          let pasteStartProbeOutcome: Promise<{ supported: boolean } | { error: Error }> | null =
            null;

          for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci];
            for (let b = chunk.batchStartIndex; b < chunk.batchEndIndex; b++) {
              if (
                chunkMode &&
                !pasteStateSupportProvenForPaste &&
                pasteStartProbeOutcome === null
              ) {
                pasteStartProbeOutcome = waitForPasteStartProbe(
                  PASTE_STATE_SUPPORT_PROBE_TIMEOUT_MS,
                  signal,
                ).then(
                  supported => ({ supported }),
                  error => ({
                    error: error instanceof Error ? error : new Error(String(error)),
                  }),
                );
              }

              const batch = batches[b];
              await executePasteMacro(batch);

              onTrace?.({
                kind: "batch",
                batchIndex: b + 1,
                totalBatches: batches.length,
                stepCount: batch.length,
                estimatedBytes: estimateBatchBytes(batch.length),
                bufferedAmount: channel.bufferedAmount,
              });

              onProgress?.({
                completedBatches: b + 1,
                totalBatches: batches.length,
                phase: "sending",
                chunkIndex: chunkMode ? chunk.chunkIndex + 1 : 0,
                chunkTotal: chunkTotalForProgress,
              });

              if (pasteStartProbeOutcome !== null && !pasteStateSupportProvenForPaste) {
                const probeResult = await pasteStartProbeOutcome;
                pasteStartProbeOutcome = null;
                if ("error" in probeResult) {
                  throw probeResult.error;
                }
                if (probeResult.supported) {
                  pasteStateSupportProvenForPaste = true;
                } else {
                  if (!pasteStateSupportObserved) {
                    pasteStateSupportNegativeLatched = true;
                  }
                  chunkMode = false;
                  chunkTotalForProgress = 0;

                  const remainingBatchStartIndex = b + 1;
                  if (remainingBatchStartIndex < batches.length) {
                    let remainingSourceChars = 0;
                    for (let rb = remainingBatchStartIndex; rb < batches.length; rb++) {
                      remainingSourceChars += batchStats[rb].sourceChars;
                    }
                    chunks = [
                      {
                        chunkIndex: 0,
                        batchStartIndex: remainingBatchStartIndex,
                        batchEndIndex: batches.length,
                        sourceChars: remainingSourceChars,
                      },
                    ];
                  } else {
                    chunks = [];
                  }
                  ci = -1;
                  break;
                }
              }

              // Pause if channel buffer exceeds high watermark. The wait is
              // abort-aware: signal.abort() during the pause rejects the
              // pending promise immediately via onBufferedDrainAbort.
              if (channel.bufferedAmount >= PASTE_HIGH_WATERMARK) {
                await waitForChannelDrain();
              }
            }

            // Chunk-boundary work: only in chunk mode. Announce the chunk,
            // wait for the backend to fully drain (required mode — rejects on
            // timeout so a chunk-level failure surfaces as an error), then
            // pause if there are more chunks to come.
            if (chunkMode && pasteStateSupportProvenForPaste) {
              onTrace?.({
                kind: "chunk-sent",
                chunkIndex: chunk.chunkIndex + 1,
                chunkTotal: chunks.length,
                sourceChars: chunk.sourceChars,
                batches: chunk.batchEndIndex - chunk.batchStartIndex,
              });

              // "draining" progress fires while we wait for the backend to
              // finish the chunk, NOT "pausing" — that was the original
              // framing but it misrepresents the state to the user on slow
              // targets where the drain wait can take tens of seconds. The
              // "pausing" phase is emitted separately below, right before
              // the explicit inter-chunk abortableSleep.
              onProgress?.({
                completedBatches: chunk.batchEndIndex,
                totalBatches: batches.length,
                phase: "draining",
                chunkIndex: chunk.chunkIndex + 1,
                chunkTotal: chunks.length,
              });

              // Per-chunk derived drain timeout. A flat constant does not
              // work here: at reliable-profile pacing on current main
              // (keyDelayMs=3, 5ms press + 3ms reset per MacroStep, ~66
              // steps/batch byte-limited, 200ms inter-macro), a 5000-char
              // chunk takes ~55s end-to-end. The derivation below gives
              // each chunk ~2x its measured worst case, with a policy
              // floor for small chunks.
              //
              // The derivation reads delayMs from ExecutePasteTextOptions
              // and applies the SAME `|| 25` fallback that executeMacroRemote
              // uses for MacroStep.delay. This matters for debug-mode pastes
              // where the PasteModal delay input can be 0 (slider at 0) or
              // NaN (empty input). Without the fallback, delayMs=0 would
              // halve the derived budget and delayMs=NaN would collapse the
              // whole expression to NaN, making Math.max short-circuit and
              // the required drain fire almost immediately. The `|| 25`
              // matches executeMacroRemote's step.delay || 25 at line 456
              // of this file — same expression, same default, same source
              // of truth.
              const effectiveResetDelayMs = delayMs || 25;
              const perMacroStepBackendMs = (5 + effectiveResetDelayMs) * 2;
              const perBatchInterMacroMs = 400;
              let chunkStepCount = 0;
              for (let b = chunk.batchStartIndex; b < chunk.batchEndIndex; b++) {
                chunkStepCount += batchStats[b].stepCount;
              }
              const chunkNumBatches = chunk.batchEndIndex - chunk.batchStartIndex;
              const derivedDrainTimeoutMs =
                chunkStepCount * perMacroStepBackendMs +
                chunkNumBatches * perBatchInterMacroMs +
                5000;
              const chunkDrainTimeoutMs = Math.max(
                policy.chunkDrainTimeoutFloorMs,
                derivedDrainTimeoutMs,
              );

              // Intermediate chunks (ci < chunks.length - 1) skip the
              // 500ms settle delay because chunkPauseMs (default 2000ms)
              // is the explicit inter-chunk catch-up pause, so adding a
              // 500ms settle on top doubles cancel latency without
              // buying correctness — on a 100k paste with ~20 chunks
              // that's ~10s of hidden latency.
              //
              // The LAST chunk keeps the default settle (undefined →
              // PASTE_DRAIN_DEFAULT_SETTLE_MS = 500ms) because without
              // it, the tail of the final chunk loses the existing
              // host-settle grace period. The subsequent final
              // bestEffort drain sees isPasteInProgress already false
              // and takes the 200ms arm-window fast path, so without a
              // settle on the last required drain the total post-drain
              // grace collapses from ~500ms (pre-Phase-2) to ~200ms,
              // which can cause end-of-paste tail corruption on slower
              // targets. Preserving the settle on the last chunk
              // restores the pre-Phase-2 settle behavior for that tail.
              const drainStart = performance.now();
              const isLastChunk = ci === chunks.length - 1;
              if (isLastChunk) {
                await waitForPasteDrain(
                  "required",
                  chunkDrainTimeoutMs,
                  signal,
                  undefined,
                  undefined,
                  pasteFailureBaseline,
                );
              } else {
                await waitForPasteDrain(
                  "required",
                  chunkDrainTimeoutMs,
                  signal,
                  0,
                  undefined,
                  pasteFailureBaseline,
                );
              }
              onTrace?.({
                kind: "chunk-drained",
                chunkIndex: chunk.chunkIndex + 1,
                drainMs: Math.round(performance.now() - drainStart),
              });

              if (ci < chunks.length - 1) {
                // "pausing" progress fires here, right before the explicit
                // inter-chunk sleep — this is the real catch-up window
                // (Codex iter 3 flagged that previously this phase was
                // emitted earlier and incorrectly spanned the drain wait).
                onProgress?.({
                  completedBatches: chunk.batchEndIndex,
                  totalBatches: batches.length,
                  phase: "pausing",
                  chunkIndex: chunk.chunkIndex + 1,
                  chunkTotal: chunks.length,
                });
                onTrace?.({
                  kind: "chunk-pause",
                  chunkIndex: chunk.chunkIndex + 1,
                  pauseMs: policy.chunkPauseMs,
                });
                await abortableSleep(policy.chunkPauseMs, signal);
              }
            }
          }

          // Final bestEffort drain — preserves existing settle UX. In chunk
          // mode the last chunk's required drain already confirmed HID-layer
          // drain; this is a short grace window for any residual settle. In
          // non-chunk mode this is the final backend completion signal when
          // paste-state support has been observed.
          onProgress?.({
            completedBatches: batches.length,
            totalBatches: batches.length,
            phase: "draining",
            chunkIndex: chunkMode ? chunks.length : 0,
            chunkTotal: chunkTotalForProgress,
          });

          const drainTimeoutMs = Math.max(finalSettleMs, batches.length * 1000);
          await waitForPasteDrain(
            "bestEffort",
            drainTimeoutMs,
            signal,
            undefined,
            undefined,
            pasteFailureBaseline,
            !(rpcHidReady && !chunkMode && batches.length > 0) || pasteStateSupportNegativeLatched,
          );
        } finally {
          channel.removeEventListener("bufferedamountlow", onLow);
          signal?.removeEventListener("abort", onBufferedDrainAbort);
          channel.bufferedAmountLowThreshold = prevThreshold;
        }
      } finally {
        executePasteTextInFlight = false;
      }
    },
    [executePasteMacro, rpcHidChannel, rpcHidReady],
  );

  const cancelExecuteMacro = useCallback(async () => {
    if (abortController.current) {
      abortController.current.abort();
    }
    if (!rpcHidReady) return;
    // older versions don't support this API,
    // and all paste actions are pure-frontend,
    // we don't need to cancel it actually
    cancelOngoingKeyboardMacroHidRpc();
  }, [rpcHidReady, cancelOngoingKeyboardMacroHidRpc, abortController]);

  return {
    handleKeyPress,
    resetKeyboardState,
    executeMacro,
    executePasteMacro,
    executePasteText,
    cleanup,
    cancelExecuteMacro,
  };
}
