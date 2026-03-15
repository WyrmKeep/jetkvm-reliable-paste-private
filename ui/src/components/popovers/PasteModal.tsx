import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClose } from "@headlessui/react";
import { ExclamationCircleIcon } from "@heroicons/react/16/solid";
import { LuCornerDownLeft } from "react-icons/lu";

import { cx } from "@/cva.config";
import { m } from "@localizations/messages.js";
import { useHidStore, useSettingsStore, useUiStore } from "@hooks/stores";
import { JsonRpcResponse, useJsonRpc } from "@hooks/useJsonRpc";
import useKeyboard, { type KeyboardLayoutLike } from "@hooks/useKeyboard";
import useKeyboardLayout from "@hooks/useKeyboardLayout";
import notifications from "@/notifications";
import { Button } from "@components/Button";
import { GridCard } from "@components/Card";
import { InputFieldWithLabel } from "@components/InputField";
import { SettingsPageHeader } from "@components/SettingsPageheader";
import { TextAreaWithLabel } from "@components/TextArea";
import { PASTE_PROFILES, type PasteProfileName } from "@/utils/pasteBatches";

// uint32 max value / 4
const pasteMaxLength = 1073741824;
const defaultDelay = 20;

function normalizePasteText(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const PASTE_TRACE_STORAGE_KEY = "jetkvm_reliable_paste_trace";

export default function PasteModal() {
  const TextAreaRef = useRef<HTMLTextAreaElement>(null);
  const pasteAbortControllerRef = useRef<AbortController | null>(null);
  const { isPasteInProgress } = useHidStore();
  const { setDisableVideoFocusTrap } = useUiStore();

  const { send } = useJsonRpc();
  const { executePasteText, cancelExecuteMacro } = useKeyboard();

  const [invalidChars, setInvalidChars] = useState<string[]>([]);
  const [delayValue, setDelayValue] = useState(defaultDelay);
  const [pasteProfile, setPasteProfile] = useState<PasteProfileName>("reliable");
  const [pasteProgress, setPasteProgress] = useState<{ completed: number; total: number; phase: "sending" | "draining" } | null>(null);
  const [traceLines, setTraceLines] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const delay = useMemo(() => {
    if (delayValue < 0 || delayValue > 65534) {
      return defaultDelay;
    }
    return delayValue;
  }, [delayValue]);
  const close = useClose();

  const setTraceLinesPersisted = useCallback((updater: string[] | ((current: string[]) => string[])) => {
    setTraceLines(current => {
      const next = typeof updater === "function" ? updater(current) : updater;
      try {
        window.localStorage.setItem(PASTE_TRACE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }, []);

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

    const text = normalizePasteText(fileText ?? TextAreaRef.current.value);

    try {
      const profile = PASTE_PROFILES[pasteProfile];
      const effectiveDelay = debugMode ? delay : profile.keyDelayMs;
      const abortController = new AbortController();
      pasteAbortControllerRef.current = abortController;
      setTraceLinesPersisted([
        `profile=${pasteProfile} source=${selectedFile ? `file:${selectedFile.name}` : 'textarea'} chars=${text.length}`,
      ]);

      await executePasteText(text, {
        keyboard: selectedKeyboard as KeyboardLayoutLike,
        delayMs: effectiveDelay,
        maxStepsPerBatch: profile.maxStepsPerBatch,
        maxBytesPerBatch: profile.maxBytesPerBatch,
        batchPauseMs: profile.batchPauseMs,
        finalSettleMs: pasteProfile === "fast" ? 1500 : 500,
        tailBatchCount: pasteProfile === "fast" ? 16 : 8,
        tailPauseMs: pasteProfile === "fast" ? 75 : 25,
        longRunThreshold: pasteProfile === "fast" ? 360 : Number.POSITIVE_INFINITY,
        longRunPauseMs: pasteProfile === "fast" ? 50 : 0,
        breathingIntervalChars: 2000,
        breathingPauseMs: 1000,
        stressDurationMs: pasteProfile === "fast" ? 700 : 700,
        stressPauseMs: pasteProfile === "fast" ? 150 : 50,
        signal: abortController.signal,
        onProgress: progress => {
          setPasteProgress({
            completed: progress.completedBatches,
            total: progress.totalBatches,
            phase: progress.completedBatches === progress.totalBatches ? "draining" : "sending",
          });
        },
        onTrace: trace => {
          setTraceLinesPersisted(current => [
            ...current,
            `batch ${trace.batchIndex}/${trace.totalBatches}: steps=${trace.stepCount} bytes=${trace.estimatedBytes} duration=${trace.durationMs}ms pause=${trace.appliedPauseMs}ms tail=${trace.tailMode ? 1 : 0} stress=${trace.stressMode ? 1 : 0}`,
          ]);
        },
      });

      pasteAbortControllerRef.current = null;
      setPasteProgress(null);
    } catch (error) {
      pasteAbortControllerRef.current = null;
      setPasteProgress(null);
      console.error("Failed to paste text:", error);
      notifications.error(m.paste_modal_failed_paste({ error: String(error) }));
    }
  }, [selectedKeyboard, executePasteText, delay, pasteProfile, debugMode, selectedFile, fileText, setTraceLinesPersisted]);

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

  return (
    <GridCard>
      <div className="space-y-4 p-4 py-3">
        <div className="grid h-full grid-rows-(--grid-headerBody)">
          <div className="h-full space-y-4">
            <div className="space-y-4">
              <SettingsPageHeader title={m.paste_text()} description={m.paste_text_description()} />

              <div
                className="animate-fadeIn space-y-2 opacity-0"
                style={{
                  animationDuration: "0.7s",
                  animationDelay: "0.1s",
                }}
              >
                <div>
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
                      rows={4}
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
                      <input
                        type="file"
                        className="block w-full text-xs text-slate-600 dark:text-slate-400"
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
                            setTraceLinesPersisted([`loaded file=${file.name} bytes=${file.size.toLocaleString()} chars=${text.length}`]);
                          } catch (error) {
                            setFileText(null);
                            console.error("Failed to read file for paste:", error);
                            notifications.error(m.paste_modal_failed_paste({ error: `Failed to read file: ${String(error)}` }));
                          }
                        }}
                      />
                      {selectedFile && (
                        <p className="text-xs text-slate-600 dark:text-slate-400">
                          Using file source: {selectedFile.name} ({selectedFile.size.toLocaleString()} bytes)
                        </p>
                      )}
                    </div>

                    {invalidChars.length > 0 && (
                      <div className="mt-2 flex items-center gap-x-2">
                        <ExclamationCircleIcon className="h-4 w-4 text-red-500 dark:text-red-400" />
                        <span className="text-xs text-red-500 dark:text-red-400">
                          {m.paste_modal_invalid_chars_intro()} {invalidChars.join(", ")}
                        </span>
                      </div>
                    )}
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
                    <div className="mt-2 flex items-center gap-x-2">
                      <ExclamationCircleIcon className="h-4 w-4 text-red-500 dark:text-red-400" />
                      <span className="text-xs text-red-500 dark:text-red-400">
                        {m.paste_modal_delay_out_of_range({ min: 1, max: 65534 })}
                      </span>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Paste mode
                  </label>
                  <select
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                    value={pasteProfile}
                    onChange={e => setPasteProfile(e.target.value as PasteProfileName)}
                  >
                    <option value="reliable">Reliable</option>
                    <option value="fast">Fast</option>
                  </select>
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {pasteProfile === "reliable"
                      ? "Reliable mode uses smaller batches and more pacing for large pastes."
                      : "Fast mode uses larger batches and lower pacing; validate on your device before trusting large transfers."}
                  </p>
                </div>
                <div className="space-y-4">
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {m.paste_modal_sending_using_layout({
                      iso: selectedKeyboard.isoCode,
                      name: selectedKeyboard.name,
                    })}
                  </p>
                  {pasteProgress && (
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      {pasteProgress.phase === "draining"
                        ? `Draining final input… (${pasteProgress.completed} / ${pasteProgress.total} batches submitted)`
                        : `Sending paste batch ${pasteProgress.completed} / ${pasteProgress.total}`}
                    </p>
                  )}
                  {debugMode && traceLines.length > 0 && (
                    <pre className="max-h-40 overflow-auto rounded-md bg-slate-100 p-2 text-[10px] text-slate-700 dark:bg-slate-900 dark:text-slate-300">
                      {traceLines.join("\n")}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div
          className="flex animate-fadeIn items-center justify-end gap-x-2 opacity-0"
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
            disabled={isPasteInProgress || invalidChars.length > 0}
            onClick={onConfirmPaste}
            LeadingIcon={LuCornerDownLeft}
          />
        </div>
      </div>
    </GridCard>
  );
}
