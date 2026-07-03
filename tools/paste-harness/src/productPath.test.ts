import { describe, expect, test } from "vitest";

import {
  buildProductPathLedgerDetails,
  estimateProductPathHidReports,
  findDoneTraceLine,
  parsePasteTraceStorage,
  resolveProductVerificationMode,
} from "./productPath.js";

describe("product path paste helpers", () => {
  test("keys completion exclusively on the app's done trace line", () => {
    const incompleteTrace = parsePasteTraceStorage(
      JSON.stringify(["profile=reliable source=textarea chars=42", "chunk 1 drained in 3100ms"]),
    );

    expect(findDoneTraceLine(incompleteTrace)).toBeUndefined();

    const completeTrace = [
      ...incompleteTrace,
      "done: chars=42 elapsed=4.2s effective=10.0cps",
    ];
    expect(findDoneTraceLine(completeTrace)).toBe("done: chars=42 elapsed=4.2s effective=10.0cps");
  });

  test("treats malformed localStorage trace data as not done", () => {
    expect(parsePasteTraceStorage(null)).toEqual([]);
    expect(parsePasteTraceStorage("not-json")).toEqual([]);
    expect(parsePasteTraceStorage(JSON.stringify({ done: true }))).toEqual([]);
    expect(parsePasteTraceStorage(JSON.stringify(["done: chars=1"]))).toEqual(["done: chars=1"]);
  });

  test("records which paste modal verification path was used", () => {
    expect(resolveProductVerificationMode(0)).toBe("auto-verify-off");
    expect(resolveProductVerificationMode(2)).toBe("manual-confirm-auto-continue");

    expect(
      buildProductPathLedgerDetails({
        doneLine: "done: chars=12 elapsed=1.0s effective=12.0cps",
        manualConfirmContinuations: 0,
        traceLineCount: 3,
      }),
    ).toEqual({
      completion_signal: "done-trace",
      verification_mode: "auto-verify-off",
      manual_confirm_continuations: 0,
      trace_line_count: 3,
      done_line: "done: chars=12 elapsed=1.0s effective=12.0cps",
    });
  });

  test("estimates HID reports from product path text plus clear and save helpers", () => {
    expect(estimateProductPathHidReports("A£\n")).toBe(14);
    expect(estimateProductPathHidReports("A£\n", { clearBefore: false, saveAfter: false })).toBe(6);
  });
});
