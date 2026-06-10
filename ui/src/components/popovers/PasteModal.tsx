import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClose } from "@headlessui/react";
import { ExclamationCircleIcon } from "@heroicons/react/16/solid";
import type { IconType } from "react-icons";
import {
  LuCheck,
  LuClipboardPaste,
  LuCornerDownLeft,
  LuFileText,
  LuGauge,
  LuShieldCheck,
} from "react-icons/lu";

import { m } from "@localizations/messages.js";
import { cx } from "@/cva.config";
import { useHidStore, useSettingsStore, useUiStore } from "@hooks/stores";
import { JsonRpcResponse, useJsonRpc } from "@hooks/useJsonRpc";
import useKeyboard, { markPasteStateCapability, type KeyboardLayoutLike } from "@hooks/useKeyboard";
import useKeyboardLayout from "@hooks/useKeyboardLayout";
import notifications from "@/notifications";
import { Button } from "@components/Button";
import { GridCard } from "@components/Card";
import { InputFieldWithLabel } from "@components/InputField";
import { TextAreaWithLabel } from "@components/TextArea";
import { PASTE_PROFILES, type PasteProfileName } from "@/utils/pasteBatches";
import { DEFAULT_LARGE_PASTE_POLICY } from "@/utils/pasteMacro";
import { findCounter, readCounter, type CounterCalibration } from "@/utils/counterOcr";

// uint32 max value / 4
const pasteMaxLength = 1073741824;
const defaultDelay = 20;

// ----- Resumable paste checkpoint -----
// Module scope so the checkpoint survives popover unmount (click-outside
// dismissal mid-failure), mirroring the executePasteTextInFlight pattern.
// The checkpoint holds the FULL normalized source text independently of
// the textarea/file inputs, so resume works even after those reset.
interface PendingResumeState {
  key: string; // hashPasteContent of the normalized text
  text: string; // full normalized (CRLF→LF, NFC) source text
  committedChars: number; // code points confirmed flushed (chunk drain boundaries)
  totalChars: number; // code points in text
}
let pendingResumeGlobal: PendingResumeState | null = null;

// Pending verify-pause, module scope: if the popover is dismissed during a
// chunk-confirm pause, the promise must stay reachable so a remounted modal
// can still Continue/Stop — otherwise the paste hangs unrecoverably.
interface PendingChunkConfirm {
  chunkIndex: number;
  chunkTotal: number;
  committedSourceChars: number;
  ocrNote?: string;
  resolve: () => void;
  reject: (e: Error) => void;
}
let pendingChunkConfirmGlobal: PendingChunkConfirm | null = null;

function hashPasteContent(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}:${text.length}`;
}

function countCodePoints(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; n++) {
    const code = text.codePointAt(i) ?? 0;
    i += code > 0xffff ? 2 : 1;
  }
  return n;
}

// onChunkCommitted counts source chars as code points of the normalized
// text; String.prototype.slice indexes UTF-16 units, so convert before
// slicing. Identical for ASCII, diverges on astral-plane characters.
function sliceFromCodePoint(text: string, count: number): string {
  if (count <= 0) return text;
  let idx = 0;
  let seen = 0;
  for (const ch of text) {
    if (seen >= count) break;
    idx += ch.length;
    seen += 1;
  }
  return text.slice(idx);
}

// ----- Duration estimate -----
// Uniform deadline pacing makes paste time deterministic: (5ms press +
// keyDelayMs reset) per char, plus inter-chunk pauses and ~2s of wake-tap/
// settle overhead. See the 2026-06-09 throughput spec.
function estimatePasteSeconds(chars: number, keyDelayMs: number): number {
  if (chars <= 0) return 0;
  const chunkCount =
    chars >= DEFAULT_LARGE_PASTE_POLICY.autoThresholdChars
      ? Math.ceil(chars / DEFAULT_LARGE_PASTE_POLICY.chunkChars)
      : 1;
  const pausesMs = Math.max(0, chunkCount - 1) * DEFAULT_LARGE_PASTE_POLICY.chunkPauseMs;
  return (chars * (5 + keyDelayMs) + pausesMs) / 1000 + 2;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

interface PasteProgressState {
  completed: number;
  total: number;
  phase: "sending" | "draining" | "pausing";
  chunkIndex: number;
  chunkTotal: number;
}

const pasteProfileOptions: {
  value: PasteProfileName;
  label: string;
  description: string;
  Icon: IconType;
  selectedClassName: string;
  iconClassName: string;
}[] = [
  {
    value: "reliable",
    label: "Reliable",
    description: "Smaller batches with target catch-up pacing.",
    Icon: LuShieldCheck,
    selectedClassName:
      "border-emerald-500/70 bg-emerald-50 text-emerald-950 shadow-xs dark:border-emerald-400/60 dark:bg-emerald-950/30 dark:text-emerald-100",
    iconClassName: "text-emerald-600 dark:text-emerald-300",
  },
  {
    value: "fast",
    label: "Fast",
    description: "Larger batches for devices already validated.",
    Icon: LuGauge,
    selectedClassName:
      "border-amber-500/70 bg-amber-50 text-amber-950 shadow-xs dark:border-amber-400/60 dark:bg-amber-950/30 dark:text-amber-100",
    iconClassName: "text-amber-600 dark:text-amber-300",
  },
];

function normalizePasteText(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function formatPasteFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} bytes`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
  return `${(kib / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
}

function getPasteProgressLabel(progress: PasteProgressState): string {
  if (progress.phase === "draining") {
    return `Draining input on target (${progress.completed} / ${progress.total} batches submitted)`;
  }
  if (progress.phase === "pausing") {
    return `Pausing to let target catch up (${progress.completed} / ${progress.total} batches submitted)`;
  }
  return `Sending paste batch ${progress.completed} / ${progress.total}`;
}

const PASTE_TRACE_STORAGE_KEY = "jetkvm_reliable_paste_trace";

// PASTE-004: LED-echo preflight threshold. NumLock's lock-LED echo is the
// only host→device feedback USB HID provides; a missing echo means the host
// isn't processing keyboard input at all (dead/suspended USB stack, BIOS
// that doesn't report LEDs) — worth knowing before a 19-minute paste. Soft
// check only: some hosts legitimately never send LED reports, so we warn
// and continue rather than block.
const LED_PREFLIGHT_THRESHOLD_CHARS = 10000;

export default function PasteModal() {
  const TextAreaRef = useRef<HTMLTextAreaElement>(null);
  const pasteAbortControllerRef = useRef<AbortController | null>(null);
  // Local in-flight guard. Phase 2 chunk mode lets isPasteInProgress go
  // false between chunks (because the required drain waits for
  // pasteDepth 1→0), which would otherwise re-enable the submit button
  // mid-paste and allow duplicate submission. The ref is checked
  // synchronously at the top of onConfirmPaste to block double-clicks
  // before the first re-render, and the state mirrors it for the
  // button's disabled prop.
  const pasteActiveRef = useRef(false);
  const [pasteActive, setPasteActive] = useState(false);
  const { isPasteInProgress } = useHidStore();
  const { setDisableVideoFocusTrap } = useUiStore();

  const { send } = useJsonRpc();
  const { executePasteText, cancelExecuteMacro, executeMacro } = useKeyboard();

  const [invalidChars, setInvalidChars] = useState<string[]>([]);
  const [delayValue, setDelayValue] = useState(defaultDelay);
  const [pasteProfile, setPasteProfile] = useState<PasteProfileName>("reliable");
  const [pasteProgress, setPasteProgress] = useState<PasteProgressState | null>(null);
  const [traceLines, setTraceLines] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [textareaCharCount, setTextareaCharCount] = useState(0);
  const [resumeState, setResumeState] = useState<PendingResumeState | null>(pendingResumeGlobal);
  const [pasteEtaSeconds, setPasteEtaSeconds] = useState<number | null>(null);
  const [verifyChunks, setVerifyChunks] = useState(false);
  const [autoVerify, setAutoVerify] = useState(false);
  // Hydrate from module scope so a remounted popover mid-pause still shows
  // the Continue/Stop controls for the in-flight paste.
  const [chunkConfirm, setChunkConfirm] = useState<PendingChunkConfirm | null>(
    pendingChunkConfirmGlobal,
  );
  const [completionSummary, setCompletionSummary] = useState<{
    chars: number;
    lines: number;
    elapsedSec: number;
    cps: number;
    ocrVerified?: { read: number | null; expected: number } | null;
  } | null>(null);
  const [preflightNoEcho, setPreflightNoEcho] = useState(false);
  const activeProfileOption = useMemo(
    () =>
      pasteProfileOptions.find(option => option.value === pasteProfile) ?? pasteProfileOptions[0],
    [pasteProfile],
  );
  const pasteProgressPercent = useMemo(() => {
    if (!pasteProgress || pasteProgress.total <= 0) return 0;
    return Math.min(100, Math.round((pasteProgress.completed / pasteProgress.total) * 100));
  }, [pasteProgress]);
  const pasteProgressTone =
    pasteProgress?.phase === "pausing"
      ? "amber"
      : pasteProgress?.phase === "draining"
        ? "emerald"
        : "blue";
  const delay = useMemo(() => {
    if (delayValue < 0 || delayValue > 65534) {
      return defaultDelay;
    }
    return delayValue;
  }, [delayValue]);
  const close = useClose();

  const setTraceLinesPersisted = useCallback(
    (updater: string[] | ((current: string[]) => string[])) => {
      setTraceLines(current => {
        const next = typeof updater === "function" ? updater(current) : updater;
        try {
          window.localStorage.setItem(PASTE_TRACE_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // ignore storage failures
        }
        return next;
      });
    },
    [],
  );

  const debugMode = useSettingsStore(state => state.debugMode);
  const delayClassName = useMemo(() => (debugMode ? "" : "hidden"), [debugMode]);

  const { setKeyboardLayout } = useSettingsStore();
  const { selectedKeyboard } = useKeyboardLayout();

  useEffect(() => {
    send("getKeyboardLayout", {}, (resp: JsonRpcResponse) => {
      if ("error" in resp) return;
      setKeyboardLayout(resp.result as string);
    });
    // Deterministic chunk-mode capability: backends with this RPC emit
    // paste-state events, so the first paste of the session can use chunk
    // mode (and resume checkpoints). Older firmware errors → observation
    // latch fallback in useKeyboard handles it.
    send("getPasteCapabilities", {}, (resp: JsonRpcResponse) => {
      if ("error" in resp) return;
      if ((resp.result as { pasteState?: boolean })?.pasteState) {
        markPasteStateCapability();
      }
    });
  }, [send, setKeyboardLayout]);

  const onCancelPasteMode = useCallback(() => {
    pasteAbortControllerRef.current?.abort();
    pasteAbortControllerRef.current = null;
    cancelExecuteMacro();
    setDisableVideoFocusTrap(false);
    setInvalidChars([]);
    setPasteProgress(null);
    setSelectedFile(null);
    setFileText(null);
  }, [setDisableVideoFocusTrap, cancelExecuteMacro]);

  // Shared paste runner for fresh pastes (startOffset 0) and resumes
  // (startOffset = a committed chunk boundary). fullText must already be
  // CRLF→LF and NFC normalized so code-point offsets are stable.
  const runPaste = useCallback(
    async (fullText: string, startOffset: number) => {
      if (!selectedKeyboard) return;
      // Synchronous guard: ref is checked BEFORE React has a chance to
      // re-render the disabled button, so a rapid double-click on Paste
      // is blocked even within the same event loop turn. The state below
      // drives the button's disabled prop for subsequent renders.
      if (pasteActiveRef.current) return;
      pasteActiveRef.current = true;
      setPasteActive(true);

      const key = hashPasteContent(fullText);
      const totalChars = countCodePoints(fullText);
      const textToType = sliceFromCodePoint(fullText, startOffset);
      const runStart = performance.now();
      setPasteEtaSeconds(null);
      setCompletionSummary(null);
      setPreflightNoEcho(false);

      try {
        const profile = PASTE_PROFILES[pasteProfile];
        const effectiveDelay = debugMode ? delay : profile.keyDelayMs;
        const abortController = new AbortController();
        pasteAbortControllerRef.current = abortController;
        setTraceLinesPersisted([
          `profile=${pasteProfile} source=${selectedFile ? `file:${selectedFile.name}` : "textarea"} chars=${totalChars}${startOffset > 0 ? ` resume_from=${startOffset}` : ""}`,
        ]);

        // PASTE-006: locate the target's character counter in the video frame
        // so chunk boundaries can self-verify by OCR. Calibration failure is
        // non-fatal — boundaries fall back to manual confirmation.
        let ocrCal: CounterCalibration | null = null;
        const videoEl = document.querySelector("video");
        if (
          autoVerify &&
          totalChars - startOffset >= DEFAULT_LARGE_PASTE_POLICY.autoThresholdChars &&
          videoEl instanceof HTMLVideoElement
        ) {
          try {
            ocrCal = await findCounter(videoEl);
          } catch {
            ocrCal = null;
          }
          setTraceLinesPersisted(current => [
            ...current,
            ocrCal
              ? `ocr-calibrate: counter=${ocrCal.value}`
              : "ocr-calibrate: counter not found — chunk boundaries will ask for manual confirmation",
          ]);
        }

        // LED-echo preflight for long pastes (see LED_PREFLIGHT_THRESHOLD_CHARS).
        // Runs after the trace reset above so its result stays in this run's
        // trace.
        if (totalChars - startOffset >= LED_PREFLIGHT_THRESHOLD_CHARS) {
          let echoes = 0;
          const unsubscribe = useHidStore.subscribe((state, prev) => {
            if (state.keyboardLedState !== prev.keyboardLedState) echoes++;
          });
          try {
            await executeMacro([{ keys: ["NumLock"], modifiers: null, delay: 30 }]);
            const t0 = performance.now();
            while (performance.now() - t0 < 1000 && echoes === 0) {
              await new Promise(r => setTimeout(r, 50));
            }
            const ok = echoes > 0;
            // Toggle back to restore the host's lock state.
            await executeMacro([{ keys: ["NumLock"], modifiers: null, delay: 30 }]);
            await new Promise(r => setTimeout(r, 250));
            setPreflightNoEcho(!ok);
            setTraceLinesPersisted(current => [
              ...current,
              `led-preflight: ${ok ? "ok" : "no-echo"}`,
            ]);
          } catch {
            // Preflight is best-effort; never block the paste on it.
          } finally {
            unsubscribe();
          }
        }

        await executePasteText(textToType, {
          keyboard: selectedKeyboard as KeyboardLayoutLike,
          delayMs: effectiveDelay,
          maxStepsPerBatch: profile.maxStepsPerBatch,
          maxBytesPerBatch: profile.maxBytesPerBatch,
          finalSettleMs: 3000,
          signal: abortController.signal,
          onProgress: progress => {
            setPasteProgress({
              completed: progress.completedBatches,
              total: progress.totalBatches,
              phase: progress.phase,
              chunkIndex: progress.chunkIndex,
              chunkTotal: progress.chunkTotal,
            });
            // Live ETA, extrapolated from observed batch throughput — it
            // self-corrects for real channel/drain overhead rather than
            // assuming the theoretical rate.
            if (progress.phase === "sending" && progress.completedBatches > 0) {
              const f = progress.completedBatches / progress.totalBatches;
              const elapsed = (performance.now() - runStart) / 1000;
              setPasteEtaSeconds(f >= 1 ? 0 : (elapsed * (1 - f)) / f);
            }
          },
          onTrace: trace => {
            let line: string;
            switch (trace.kind) {
              case "batch":
                line = `batch ${trace.batchIndex}/${trace.totalBatches}: steps=${trace.stepCount} bytes=${trace.estimatedBytes} buffered=${trace.bufferedAmount}`;
                break;
              case "chunk-sent":
                line = `chunk ${trace.chunkIndex}/${trace.chunkTotal} sent: chars=${trace.sourceChars} batches=${trace.batches}`;
                break;
              case "chunk-drained":
                line = `chunk ${trace.chunkIndex} drained in ${trace.drainMs}ms`;
                break;
              case "chunk-pause":
                line = `chunk ${trace.chunkIndex} pause ${trace.pauseMs}ms`;
                break;
            }
            setTraceLinesPersisted(current => [...current, line]);
          },
          onChunkCommitted: committed => {
            pendingResumeGlobal = {
              key,
              text: fullText,
              committedChars: startOffset + committed,
              totalChars,
            };
          },
          waitForChunkConfirm:
            verifyChunks || autoVerify
              ? info =>
                  new Promise<void>((resolve, reject) => {
                    const onAbort = () => {
                      cleanup();
                      reject(new Error("Paste execution aborted"));
                    };
                    const cleanup = () => {
                      abortController.signal.removeEventListener("abort", onAbort);
                      pendingChunkConfirmGlobal = null;
                      setChunkConfirm(null);
                    };
                    abortController.signal.addEventListener("abort", onAbort);
                    const showManual = (ocrNote?: string) => {
                      const pending: PendingChunkConfirm = {
                        chunkIndex: info.chunkIndex,
                        chunkTotal: info.chunkTotal,
                        committedSourceChars: startOffset + info.committedSourceChars,
                        ocrNote,
                        resolve: () => {
                          cleanup();
                          resolve();
                        },
                        reject: (e: Error) => {
                          cleanup();
                          reject(e);
                        },
                      };
                      pendingChunkConfirmGlobal = pending;
                      setChunkConfirm(pending);
                    };
                    if (ocrCal && videoEl instanceof HTMLVideoElement) {
                      // Auto path: read the counter; matching count continues
                      // without any human pause. info.committedSourceChars is
                      // run-relative, and the calibration baseline was read at
                      // run start, so this also holds for resumed runs and
                      // targets whose document wasn't empty.
                      const cal = ocrCal;
                      void (async () => {
                        const expected = cal.value + info.committedSourceChars;
                        await new Promise(r => setTimeout(r, 900));
                        let read = await readCounter(videoEl, cal.region).catch(() => null);
                        if (read !== expected) {
                          await new Promise(r => setTimeout(r, 800));
                          read = await readCounter(videoEl, cal.region).catch(() => null);
                        }
                        if (abortController.signal.aborted) return;
                        if (read === expected) {
                          setTraceLinesPersisted(current => [
                            ...current,
                            `ocr-verify chunk ${info.chunkIndex}/${info.chunkTotal}: ${read} ok`,
                          ]);
                          cleanup();
                          resolve();
                          return;
                        }
                        setTraceLinesPersisted(current => [
                          ...current,
                          `ocr-verify chunk ${info.chunkIndex}: read=${read ?? "unreadable"} expected=${expected} — manual confirm`,
                        ]);
                        showManual(
                          `Automatic check: counter reads ${read !== null ? read.toLocaleString() : "unreadable"}, expected ${expected.toLocaleString()}.`,
                        );
                      })();
                    } else {
                      showManual();
                    }
                  })
              : undefined,
        });

        // Success: the checkpoint for this content is no longer needed.
        if (pendingResumeGlobal?.key === key) pendingResumeGlobal = null;
        setResumeState(null);
        const elapsedSec = (performance.now() - runStart) / 1000;
        const typedChars = totalChars - startOffset;

        // Final OCR check: chunk boundaries verified everything except the
        // last chunk's tail, so read the counter once more after the final
        // drain. Failure here is informational, never an error.
        let ocrFinal: { read: number | null; expected: number } | null = null;
        if (ocrCal && videoEl instanceof HTMLVideoElement) {
          const expected = ocrCal.value + typedChars;
          await new Promise(r => setTimeout(r, 1200));
          let read = await readCounter(videoEl, ocrCal.region).catch(() => null);
          if (read !== expected) {
            await new Promise(r => setTimeout(r, 800));
            read = await readCounter(videoEl, ocrCal.region).catch(() => null);
          }
          ocrFinal = { read, expected };
          setTraceLinesPersisted(current => [
            ...current,
            `ocr-final: read=${read ?? "unreadable"} expected=${expected}${read === expected ? " ok" : ""}`,
          ]);
        }

        setCompletionSummary({
          chars: totalChars,
          lines: (fullText.match(/\n/g)?.length ?? 0) + 1,
          elapsedSec,
          cps: typedChars / Math.max(elapsedSec, 0.001),
          ocrVerified: ocrFinal,
        });
        setTraceLinesPersisted(current => [
          ...current,
          `done: chars=${typedChars} elapsed=${elapsedSec.toFixed(1)}s effective=${(
            typedChars / Math.max(elapsedSec, 0.001)
          ).toFixed(1)}cps`,
        ]);

        pasteAbortControllerRef.current = null;
        setPasteProgress(null);
        setPasteEtaSeconds(null);
      } catch (error) {
        pasteAbortControllerRef.current = null;
        setPasteProgress(null);
        setPasteEtaSeconds(null);
        // Surface the checkpoint (if any chunk committed) so the user can
        // resume from the last verified boundary instead of starting over.
        if (
          pendingResumeGlobal?.key === key &&
          pendingResumeGlobal.committedChars > 0 &&
          pendingResumeGlobal.committedChars < totalChars
        ) {
          setResumeState({ ...pendingResumeGlobal });
        }
        console.error("Failed to paste text:", error);
        notifications.error(m.paste_modal_failed_paste({ error: String(error) }));
      } finally {
        // Always clear the in-flight guard so the submit button re-enables
        // after the operation completes (success, error, or abort). Phase 2
        // relies on this to prevent a stuck-disabled button on errors.
        pasteActiveRef.current = false;
        setPasteActive(false);
      }
    },
    [
      selectedKeyboard,
      executePasteText,
      executeMacro,
      delay,
      pasteProfile,
      debugMode,
      selectedFile,
      verifyChunks,
      autoVerify,
      setTraceLinesPersisted,
    ],
  );

  const onConfirmPaste = useCallback(async () => {
    if (!TextAreaRef.current || !selectedKeyboard) return;
    const fullText = normalizePasteText(fileText ?? TextAreaRef.current.value).normalize("NFC");
    // A fresh confirm always starts from zero and invalidates any prior
    // checkpoint — resuming different content would corrupt the target.
    pendingResumeGlobal = null;
    setResumeState(null);
    await runPaste(fullText, 0);
  }, [selectedKeyboard, fileText, runPaste]);

  const onResumePaste = useCallback(async () => {
    const resume = resumeState;
    if (!resume) return;
    await runPaste(resume.text, resume.committedChars);
  }, [resumeState, runPaste]);

  const onDismissResume = useCallback(() => {
    pendingResumeGlobal = null;
    setResumeState(null);
  }, []);

  useEffect(() => {
    if (TextAreaRef.current) {
      TextAreaRef.current.focus();
    }

    try {
      const saved = window.localStorage.getItem(PASTE_TRACE_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setTraceLines(parsed.filter(item => typeof item === "string"));
        }
      }
    } catch {
      // ignore trace restore failures
    }
  }, []);

  const ActiveProfileIcon = activeProfileOption.Icon;

  return (
    <GridCard cardClassName="shadow-lg shadow-slate-900/10 dark:shadow-black/30">
      <div className="space-y-4 p-4">
        <div className="flex items-start gap-3 border-b border-slate-200/80 pb-3 dark:border-slate-700/80">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-400/30 dark:bg-blue-950/40 dark:text-blue-200">
            <LuClipboardPaste className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">
                {m.paste_text()}
              </h2>
              <span className="inline-flex items-center gap-1 rounded-sm border border-slate-200 bg-white/80 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200">
                <ActiveProfileIcon
                  className={cx("h-3.5 w-3.5", activeProfileOption.iconClassName)}
                />
                {activeProfileOption.label}
              </span>
            </div>
            <p className="mt-1 text-sm leading-5 text-slate-600 dark:text-slate-300">
              {m.paste_text_description()}
            </p>
          </div>
        </div>

        <div
          className="animate-fadeIn space-y-4 opacity-0"
          style={{
            animationDuration: "0.7s",
            animationDelay: "0.1s",
          }}
        >
          <div
            className="w-full"
            onKeyUp={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
            onKeyDownCapture={e => e.stopPropagation()}
            onKeyUpCapture={e => e.stopPropagation()}
          >
            <TextAreaWithLabel
              ref={TextAreaRef}
              label={m.paste_modal_paste_from_host()}
              rows={5}
              className="min-h-32 resize-y"
              onKeyUp={e => e.stopPropagation()}
              maxLength={pasteMaxLength}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onConfirmPaste();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelPasteMode();
                }
              }}
              onChange={e => {
                const value = normalizePasteText(e.target.value);
                setTextareaCharCount(value.length);
                const invalidChars = [
                  ...new Set(
                    // @ts-expect-error TS doesn't recognize Intl.Segmenter in some environments
                    [...new Intl.Segmenter().segment(value)]
                      .map(x => x.segment.normalize("NFC"))
                      .filter(char => !selectedKeyboard.chars[char]),
                  ),
                ];

                setInvalidChars(invalidChars);
              }}
            />

            <div className="mt-3 space-y-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Large paste file (optional)
              </label>
              <label
                className={cx(
                  "flex cursor-pointer items-center gap-3 rounded-sm border px-3 py-2.5 text-left transition-colors",
                  selectedFile
                    ? "border-blue-400/70 bg-blue-50/70 dark:border-blue-400/40 dark:bg-blue-950/30"
                    : "border-slate-200 bg-white/70 hover:border-slate-300 hover:bg-white dark:border-slate-700 dark:bg-slate-900/50 dark:hover:border-slate-600",
                )}
              >
                <input
                  type="file"
                  className="sr-only"
                  onChange={async e => {
                    const file = e.target.files?.[0] ?? null;
                    setSelectedFile(file);
                    if (!file) {
                      setFileText(null);
                      return;
                    }

                    try {
                      const text = normalizePasteText(await file.text());
                      setFileText(text);
                      const invalidChars = [
                        ...new Set(
                          // @ts-expect-error TS doesn't recognize Intl.Segmenter in some environments
                          [...new Intl.Segmenter().segment(text)]
                            .map(x => x.segment.normalize("NFC"))
                            .filter(char => !selectedKeyboard.chars[char]),
                        ),
                      ];
                      setInvalidChars(invalidChars);
                      setTraceLinesPersisted([
                        `loaded file=${file.name} bytes=${file.size.toLocaleString()} chars=${text.length}`,
                      ]);
                    } catch (error) {
                      setFileText(null);
                      console.error("Failed to read file for paste:", error);
                      notifications.error(
                        m.paste_modal_failed_paste({
                          error: `Failed to read file: ${String(error)}`,
                        }),
                      );
                    }
                  }}
                />
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                  <LuFileText className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900 dark:text-white">
                    {selectedFile ? selectedFile.name : "Choose a file instead"}
                  </span>
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                    {selectedFile
                      ? formatPasteFileSize(selectedFile.size)
                      : "Use a file for very large text."}
                  </span>
                </span>
                <span className="rounded-sm border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  Browse
                </span>
              </label>
            </div>

            {invalidChars.length > 0 && (
              <div className="mt-3 flex items-start gap-x-2 rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-950/30 dark:text-red-300">
                <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {m.paste_modal_invalid_chars_intro()} {invalidChars.join(", ")}
                </span>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Paste mode
            </label>
            <div
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
              role="radiogroup"
              aria-label="Paste mode"
            >
              {pasteProfileOptions.map(option => {
                const selected = pasteProfile === option.value;
                const ProfileIcon = option.Icon;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={cx(
                      "flex min-h-20 items-start gap-2 rounded-sm border p-3 text-left transition-colors",
                      selected
                        ? option.selectedClassName
                        : "border-slate-200 bg-white/70 text-slate-700 hover:border-slate-300 hover:bg-white dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300 dark:hover:border-slate-600",
                    )}
                    onClick={() => setPasteProfile(option.value)}
                  >
                    <ProfileIcon
                      className={cx(
                        "mt-0.5 h-4 w-4 shrink-0",
                        selected ? option.iconClassName : "text-slate-500 dark:text-slate-400",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 text-sm font-semibold">
                        {option.label}
                        {selected && <LuCheck className="h-3.5 w-3.5" />}
                      </span>
                      <span className="mt-1 block text-xs leading-4 opacity-80">
                        {option.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {(fileText !== null ? fileText.length : textareaCharCount) > 0 && (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {(() => {
                  const chars = fileText !== null ? fileText.length : textareaCharCount;
                  const reliableEta = formatDuration(
                    estimatePasteSeconds(chars, PASTE_PROFILES.reliable.keyDelayMs),
                  );
                  const fastEta = formatDuration(
                    estimatePasteSeconds(chars, PASTE_PROFILES.fast.keyDelayMs),
                  );
                  return `${chars.toLocaleString()} characters — ≈${reliableEta} on Reliable, ≈${fastEta} on Fast`;
                })()}
              </p>
            )}
            {(fileText !== null ? fileText.length : textareaCharCount) >=
              DEFAULT_LARGE_PASTE_POLICY.autoThresholdChars && (
              <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={verifyChunks}
                  onChange={e => setVerifyChunks(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Verify each chunk</span>
                  <span className="block text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                    Pause after every chunk and show the expected character count, so you can glance
                    at the target&apos;s own counter before continuing. Best for very large pastes.
                  </span>
                </span>
              </label>
            )}
            {(fileText !== null ? fileText.length : textareaCharCount) >=
              DEFAULT_LARGE_PASTE_POLICY.autoThresholdChars && (
              <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={autoVerify}
                  onChange={e => setAutoVerify(e.target.checked)}
                />
                <span>
                  <span className="font-medium">
                    Auto-verify via the target&apos;s counter (OCR, experimental)
                  </span>
                  <span className="block text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                    Reads the character counter in the video after each chunk and continues
                    automatically when it matches; asks you only on a mismatch. Needs a visible
                    counter on the target (e.g. Notepad&apos;s status bar).
                  </span>
                </span>
              </label>
            )}
          </div>

          <div className={cx("text-xs text-slate-600 dark:text-slate-400", delayClassName)}>
            <InputFieldWithLabel
              type="number"
              label={m.paste_modal_delay_between_keys()}
              placeholder={m.paste_modal_delay_between_keys()}
              min={1}
              max={65534}
              value={delayValue}
              onChange={e => {
                setDelayValue(parseInt(e.target.value, 10));
              }}
            />
            {(delayValue < 1 || delayValue > 65534) && (
              <div className="mt-2 flex items-start gap-x-2 rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-950/30 dark:text-red-300">
                <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{m.paste_modal_delay_out_of_range({ min: 1, max: 65534 })}</span>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-sm border border-slate-200/80 bg-white/60 p-3 dark:border-slate-700/80 dark:bg-slate-900/40">
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {m.paste_modal_sending_using_layout({
                iso: selectedKeyboard.isoCode,
                name: selectedKeyboard.name,
              })}
            </p>
            {pasteProgress && (
              <div
                className={cx(
                  "rounded-sm border px-3 py-2.5",
                  pasteProgressTone === "amber"
                    ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-200"
                    : "",
                  pasteProgressTone === "emerald"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-950/30 dark:text-emerald-200"
                    : "",
                  pasteProgressTone === "blue"
                    ? "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-400/40 dark:bg-blue-950/30 dark:text-blue-200"
                    : "",
                )}
              >
                <div className="flex items-center justify-between gap-3 text-xs font-medium">
                  <span>{getPasteProgressLabel(pasteProgress)}</span>
                  <span>
                    {pasteEtaSeconds !== null && pasteEtaSeconds > 1
                      ? `~${formatDuration(pasteEtaSeconds)} left · `
                      : ""}
                    {pasteProgressPercent}%
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/70 dark:bg-slate-950/40">
                  <div
                    className={cx(
                      "h-full rounded-full transition-[width] duration-300",
                      pasteProgressTone === "amber" ? "bg-amber-500" : "",
                      pasteProgressTone === "emerald" ? "bg-emerald-500" : "",
                      pasteProgressTone === "blue" ? "bg-blue-600" : "",
                    )}
                    style={{ width: `${pasteProgressPercent}%` }}
                  />
                </div>
                {pasteProgress.chunkTotal > 0 && (
                  <p className="mt-2 text-[11px] opacity-80">
                    Chunk {pasteProgress.chunkIndex} / {pasteProgress.chunkTotal}
                  </p>
                )}
              </div>
            )}
            {preflightNoEcho && (
              <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-200">
                No keyboard LED echo from the target — it may be locked, asleep, in BIOS/UEFI, or
                not processing input. The paste is continuing, but check that the first lines
                actually arrive before walking away.
              </div>
            )}
            {chunkConfirm && (
              <div className="space-y-2 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-200">
                <p className="text-xs font-medium">
                  Chunk {chunkConfirm.chunkIndex} / {chunkConfirm.chunkTotal} delivered — the target
                  should now show{" "}
                  <span className="font-bold">
                    {chunkConfirm.committedSourceChars.toLocaleString()}
                  </span>{" "}
                  characters.
                </p>
                {chunkConfirm.ocrNote && (
                  <p className="text-[11px] leading-4 font-medium">{chunkConfirm.ocrNote}</p>
                )}
                <p className="text-[11px] leading-4 opacity-80">
                  Glance at the target&apos;s character counter (e.g. Notepad&apos;s status bar). If
                  it matches, continue. If it doesn&apos;t, stop here — you can trim the tail on the
                  target and resume from this verified point.
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    size="XS"
                    theme="primary"
                    text="Continue"
                    onClick={() => {
                      chunkConfirm.resolve();
                      setChunkConfirm(null);
                    }}
                  />
                  <Button
                    size="XS"
                    theme="light"
                    text="Stop here"
                    onClick={() => {
                      chunkConfirm.reject(new Error("Stopped at verified chunk boundary"));
                      setChunkConfirm(null);
                    }}
                  />
                </div>
              </div>
            )}
            {completionSummary && !pasteActive && (
              <div className="space-y-1 rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-950/30 dark:text-emerald-200">
                <p className="text-xs font-medium">
                  Paste complete in {formatDuration(completionSummary.elapsedSec)} (
                  {completionSummary.cps.toFixed(0)} chars/sec).
                </p>
                {completionSummary.ocrVerified &&
                  (completionSummary.ocrVerified.read === completionSummary.ocrVerified.expected ? (
                    <p className="text-[11px] leading-4 font-semibold">
                      ✓ Verified on target: counter reads{" "}
                      {completionSummary.ocrVerified.expected.toLocaleString()}.
                    </p>
                  ) : (
                    <p className="text-[11px] leading-4 font-semibold text-amber-700 dark:text-amber-300">
                      ⚠ Counter reads{" "}
                      {completionSummary.ocrVerified.read !== null
                        ? completionSummary.ocrVerified.read.toLocaleString()
                        : "unreadable"}
                      , expected {completionSummary.ocrVerified.expected.toLocaleString()} — check
                      the target.
                    </p>
                  ))}
                <p className="text-[11px] leading-4 opacity-90">
                  The target should show{" "}
                  <span className="font-bold">{completionSummary.chars.toLocaleString()}</span>{" "}
                  characters / cursor on line{" "}
                  <span className="font-bold">{completionSummary.lines.toLocaleString()}</span>.
                  Compare with the target&apos;s own counter (e.g. Notepad&apos;s status bar) to
                  confirm integrity at a glance.
                </p>
              </div>
            )}
            {resumeState && !pasteActive && (
              <div className="space-y-2 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-200">
                <p className="text-xs font-medium">
                  Previous paste stopped at {resumeState.committedChars.toLocaleString()} /{" "}
                  {resumeState.totalChars.toLocaleString()} characters (
                  {Math.round((resumeState.committedChars / resumeState.totalChars) * 100)}%).
                </p>
                <p className="text-[11px] leading-4 opacity-80">
                  Everything before that point was delivered to the target. Text after it may have
                  partially arrived — check the tail on the target and remove any partial text
                  before resuming.
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    size="XS"
                    theme="primary"
                    text={`Resume from ${Math.round(
                      (resumeState.committedChars / resumeState.totalChars) * 100,
                    )}%`}
                    onClick={onResumePaste}
                  />
                  <Button size="XS" theme="light" text="Dismiss" onClick={onDismissResume} />
                </div>
              </div>
            )}
            {debugMode && traceLines.length > 0 && (
              <pre className="max-h-40 overflow-auto rounded-sm border border-slate-200 bg-slate-50 p-2 text-[10px] text-slate-700 dark:border-slate-700 dark:bg-slate-950/70 dark:text-slate-300">
                {traceLines.join("\n")}
              </pre>
            )}
          </div>
        </div>

        <div
          className="flex animate-fadeIn items-center justify-end gap-x-2 border-t border-slate-200/80 pt-3 opacity-0 dark:border-slate-700/80"
          style={{
            animationDuration: "0.7s",
            animationDelay: "0.2s",
          }}
        >
          <Button
            size="SM"
            theme="blank"
            text={m.cancel()}
            onClick={() => {
              onCancelPasteMode();
              close();
            }}
          />
          <Button
            size="SM"
            theme="primary"
            text={m.paste_modal_confirm_paste()}
            disabled={isPasteInProgress || pasteActive || invalidChars.length > 0}
            onClick={onConfirmPaste}
            LeadingIcon={LuCornerDownLeft}
          />
        </div>
      </div>
    </GridCard>
  );
}
