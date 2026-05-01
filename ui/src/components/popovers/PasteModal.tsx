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
import useKeyboard, { type KeyboardLayoutLike } from "@hooks/useKeyboard";
import useKeyboardLayout from "@hooks/useKeyboardLayout";
import notifications from "@/notifications";
import { Button } from "@components/Button";
import { GridCard } from "@components/Card";
import { InputFieldWithLabel } from "@components/InputField";
import { TextAreaWithLabel } from "@components/TextArea";
import { PASTE_PROFILES, type PasteProfileName } from "@/utils/pasteBatches";

// uint32 max value / 4
const pasteMaxLength = 1073741824;
const defaultDelay = 20;

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
  const { executePasteText, cancelExecuteMacro } = useKeyboard();

  const [invalidChars, setInvalidChars] = useState<string[]>([]);
  const [delayValue, setDelayValue] = useState(defaultDelay);
  const [pasteProfile, setPasteProfile] = useState<PasteProfileName>("reliable");
  const [pasteProgress, setPasteProgress] = useState<PasteProgressState | null>(null);
  const [traceLines, setTraceLines] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
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

  const onConfirmPaste = useCallback(async () => {
    if (!TextAreaRef.current || !selectedKeyboard) return;
    // Synchronous guard: ref is checked BEFORE React has a chance to
    // re-render the disabled button, so a rapid double-click on Paste
    // is blocked even within the same event loop turn. The state below
    // drives the button's disabled prop for subsequent renders.
    if (pasteActiveRef.current) return;
    pasteActiveRef.current = true;
    setPasteActive(true);

    const text = normalizePasteText(fileText ?? TextAreaRef.current.value);

    try {
      const profile = PASTE_PROFILES[pasteProfile];
      const effectiveDelay = debugMode ? delay : profile.keyDelayMs;
      const abortController = new AbortController();
      pasteAbortControllerRef.current = abortController;
      setTraceLinesPersisted([
        `profile=${pasteProfile} source=${selectedFile ? `file:${selectedFile.name}` : "textarea"} chars=${text.length}`,
      ]);

      await executePasteText(text, {
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
      });

      pasteAbortControllerRef.current = null;
      setPasteProgress(null);
    } catch (error) {
      pasteAbortControllerRef.current = null;
      setPasteProgress(null);
      console.error("Failed to paste text:", error);
      notifications.error(m.paste_modal_failed_paste({ error: String(error) }));
    } finally {
      // Always clear the in-flight guard so the submit button re-enables
      // after the operation completes (success, error, or abort). Phase 2
      // relies on this to prevent a stuck-disabled button on errors.
      pasteActiveRef.current = false;
      setPasteActive(false);
    }
  }, [
    selectedKeyboard,
    executePasteText,
    delay,
    pasteProfile,
    debugMode,
    selectedFile,
    fileText,
    setTraceLinesPersisted,
  ]);

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
                  <span>{pasteProgressPercent}%</span>
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
