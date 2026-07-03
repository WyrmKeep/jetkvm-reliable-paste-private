import { describe, expect, test } from "vitest";

import {
  CLASSIFIER_VERSION,
  FAULT_LABELS,
  classifyDifference,
  emptyErrorVector,
} from "./classifier.js";
import { createSelfValidationArtifact } from "./selfValidation.js";

describe("classifier", () => {
  test("classifies all seeded single-fault corpora exactly with zero cross-class confusion", () => {
    const artifact = createSelfValidationArtifact({ seedStart: 100, seedCount: 20 });

    expect(artifact.classifier_version).toBe(CLASSIFIER_VERSION);
    expect(artifact.ok).toBe(true);
    expect(artifact.singleFaultCases).toHaveLength(20 * FAULT_LABELS.length);

    for (const entry of artifact.singleFaultCases) {
      expect(entry.observed).toEqual(entry.truth);
      const nonZeroLabels = FAULT_LABELS.filter((label) => entry.observed[label] > 0);
      expect(nonZeroLabels).toEqual([entry.fault]);
    }
  });

  test("emits compound labels for mixed faults with the documented minimal-edit tie-break", () => {
    const artifact = createSelfValidationArtifact({ seedStart: 7, seedCount: 3 });

    expect(artifact.mixed.ok).toBe(true);
    expect(artifact.mixed.observed).toEqual(artifact.mixed.truth);
    expect(artifact.mixed.labels).toEqual(
      expect.arrayContaining([
        "drop",
        "insertion",
        "same-length-substitution",
        "case-error",
        "stuck-modifier-run",
        "layout-swap-signature",
      ]),
    );
  });

  test("treats a lone carriage return after normalization as an insertion", () => {
    const result = classifyDifference("L0001 abc", "L0001 a\rbc");

    expect(result.labels).toEqual(["insertion"]);
    expect(result.errorVector).toEqual({ ...emptyErrorVector(), insertion: 1 });
  });

  test("distinguishes isolated case errors from stuck-modifier runs", () => {
    const isolated = classifyDifference("L0001 alpha", "L0001 Alpha");
    const stuck = classifyDifference("L0001 alpha", "L0001 ALpha");

    expect(isolated.labels).toEqual(["case-error"]);
    expect(stuck.labels).toEqual(["stuck-modifier-run"]);
    expect(stuck.errorVector["case-error"]).toBe(0);
  });

  test("keeps stuck-modifier runs when adjacent to non-shift substitutions", () => {
    const cases = [
      {
        name: "leading adjacent substitution",
        expected: "xab",
        actual: "zAB",
        sameLengthSubstitutions: 1,
        stuckModifierChars: 2,
      },
      {
        name: "trailing adjacent substitution",
        expected: "abx",
        actual: "ABz",
        sameLengthSubstitutions: 1,
        stuckModifierChars: 2,
      },
      {
        name: "substitutions on both sides",
        expected: "xabx",
        actual: "zABz",
        sameLengthSubstitutions: 2,
        stuckModifierChars: 2,
      },
    ];

    for (const testCase of cases) {
      const result = classifyDifference(testCase.expected, testCase.actual);

      expect(result.labels, testCase.name).toEqual([
        "same-length-substitution",
        "stuck-modifier-run",
      ]);
      expect(result.errorVector["same-length-substitution"], testCase.name).toBe(
        testCase.sameLengthSubstitutions,
      );
      expect(result.errorVector["stuck-modifier-run"], testCase.name).toBe(
        testCase.stuckModifierChars,
      );
      expect(result.errorVector["case-error"], testCase.name).toBe(0);
    }
  });

  test("requires a systematic layout count crossover before labeling layout swaps", () => {
    const oneOff = classifyDifference('L0001 @ sentinel', 'L0001 " sentinel');
    const systematic = classifyDifference('L0001 @ " # £', 'L0001 " @ £ #');

    expect(oneOff.labels).toEqual(["same-length-substitution"]);
    expect(systematic.labels).toEqual(["layout-swap-signature"]);
    expect(systematic.layoutSwapDetails.length).toBeGreaterThanOrEqual(2);
  });
});
