import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClose } from "@headlessui/react";
import { ExclamationCircleIcon } from "@heroicons/react/16/solid";
import { LuCornerDownLeft } from "react-icons/lu";

import { cx } from "@/cva.config";
import { m } from "@localizations/messages.js";
import { useHidStore, useSettingsStore, useUiStore } from "@hooks/stores";
import { JsonRpcResponse, useJsonRpc } from "@hooks/useJsonRpc";
import useKeyboard, { type MacroStep } from "@hooks/useKeyboard";
import useKeyboardLayout from "@hooks/useKeyboardLayout";
import notifications from "@/notifications";
import { Button } from "@components/Button";
import { GridCard } from "@components/Card";
import { InputFieldWithLabel } from "@components/InputField";
import { SettingsPageHeader } from "@components/SettingsPageheader";
import { TextAreaWithLabel } from "@components/TextArea";
import { buildPasteMacroSteps } from "@/utils/pasteMacro";
import { chunkPasteText, PASTE_PROFILES, type PasteProfileName, runPasteBatches } from "@/utils/pasteBatches";

// uint32 max value / 4
const pasteMaxLength = 1073741824;
const defaultDelay = 20;

export default function PasteModal() {
  const TextAreaRef = useRef<HTMLTextAreaElement>(null);
  const { isPasteInProgress } = useHidStore();
  const { setDisableVideoFocusTrap } = useUiStore();

  const { send } = useJsonRpc();
  const { executeMacro, cancelExecuteMacro } = useKeyboard();

  const [invalidChars, setInvalidChars] = useState<string[]>([]);
  const [delayValue, setDelayValue] = useState(defaultDelay);
  const [pasteProfile, setPasteProfile] = useState<PasteProfileName>("reliable");
  const [pasteProgress, setPasteProgress] = useState<{ completed: number; total: number } | null>(null);
  const delay = useMemo(() => {
    if (delayValue < 0 || delayValue > 65534) {
      return defaultDelay;
    }
    return delayValue;
  }, [delayValue]);
  const close = useClose();

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
    cancelExecuteMacro();
    setDisableVideoFocusTrap(false);
    setInvalidChars([]);
  }, [setDisableVideoFocusTrap, cancelExecuteMacro]);

  const onConfirmPaste = useCallback(async () => {
    if (!TextAreaRef.current || !selectedKeyboard) return;

    const text = TextAreaRef.current.value;

    try {
      const profile = PASTE_PROFILES[pasteProfile];
      const textBatches = chunkPasteText(text, profile.maxCharsPerBatch);
      const macroBatches = textBatches.map(batch =>
        buildPasteMacroSteps(batch, selectedKeyboard, delay || profile.keyDelayMs),
      );

      const aggregatedInvalidChars = [
        ...new Set(macroBatches.flatMap(batch => batch.invalidChars)),
      ];

      if (aggregatedInvalidChars.length > 0) {
        setInvalidChars(aggregatedInvalidChars);
        notifications.error(
          m.paste_modal_failed_paste({
            error: `Unsupported characters: ${aggregatedInvalidChars.join(", ")}`,
          }),
        );
        return;
      }

      const stepsBatches: MacroStep[][] = macroBatches
        .map(batch => batch.steps)
        .filter(batch => batch.length > 0);

      if (stepsBatches.length > 0) {
        setPasteProgress({ completed: 0, total: stepsBatches.length });
        await runPasteBatches(stepsBatches, executeMacro, {
          batchPauseMs: profile.batchPauseMs,
          onProgress: progress => {
            setPasteProgress({
              completed: progress.completedBatches,
              total: progress.totalBatches,
            });
          },
        });
        setPasteProgress(null);
      }
    } catch (error) {
      setPasteProgress(null);
      console.error("Failed to paste text:", error);
      notifications.error(m.paste_modal_failed_paste({ error: String(error) }));
    }
  }, [selectedKeyboard, executeMacro, delay, pasteProfile]);

  useEffect(() => {
    if (TextAreaRef.current) {
      TextAreaRef.current.focus();
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
                        const value = e.target.value;
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
                    min={50}
                    max={65534}
                    value={delayValue}
                    onChange={e => {
                      setDelayValue(parseInt(e.target.value, 10));
                    }}
                  />
                  {delayValue < 50 ||
                    (delayValue > 65534 && (
                      <div className="mt-2 flex items-center gap-x-2">
                        <ExclamationCircleIcon className="h-4 w-4 text-red-500 dark:text-red-400" />
                        <span className="text-xs text-red-500 dark:text-red-400">
                          {m.paste_modal_delay_out_of_range({ min: 50, max: 65534 })}
                        </span>
                      </div>
                    ))}
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
                      Sending paste batch {pasteProgress.completed} / {pasteProgress.total}
                    </p>
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
            disabled={isPasteInProgress}
            onClick={onConfirmPaste}
            LeadingIcon={LuCornerDownLeft}
          />
        </div>
      </div>
    </GridCard>
  );
}
