import {
  CLASSIFIER_VERSION,
  FAULT_LABELS,
  classifyDifference,
  emptyErrorVector,
  type ErrorVector,
  type FaultLabel,
} from "./classifier.js";

export interface SelfValidationOptions {
  seedStart?: number;
  seedCount?: number;
}

export interface SingleFaultSelfValidationCase {
  seed: number;
  fault: FaultLabel;
  truth: ErrorVector;
  observed: ErrorVector;
  labels: FaultLabel[];
  ok: boolean;
}

export interface MixedFaultSelfValidationCase {
  seeds: number[];
  truth: ErrorVector;
  observed: ErrorVector;
  labels: FaultLabel[];
  ok: boolean;
}

export interface SelfValidationArtifact {
  artifact: "classifier-self-validation";
  artifact_version: 1;
  classifier_version: string;
  seedStart: number;
  seedCount: number;
  ok: boolean;
  singleFaultCases: SingleFaultSelfValidationCase[];
  mixed: MixedFaultSelfValidationCase;
}

export function createSelfValidationArtifact(
  options: SelfValidationOptions = {},
): SelfValidationArtifact {
  const seedStart = options.seedStart ?? 1;
  const seedCount = options.seedCount ?? 20;
  const singleFaultCases: SingleFaultSelfValidationCase[] = [];

  for (let offset = 0; offset < seedCount; offset += 1) {
    const seed = seedStart + offset;
    for (const fault of FAULT_LABELS) {
      const testCase = createSingleFaultCase(seed, fault);
      const result = classifyDifference(testCase.expected, testCase.actual);
      const observed = result.errorVector;
      singleFaultCases.push({
        seed,
        fault,
        truth: testCase.truth,
        observed,
        labels: result.labels,
        ok: vectorsEqual(testCase.truth, observed),
      });
    }
  }

  const mixedCase = createMixedFaultCase(
    Array.from({ length: seedCount }, (_, index) => seedStart + index),
  );
  const mixedResult = classifyDifference(mixedCase.expected, mixedCase.actual);
  const mixed: MixedFaultSelfValidationCase = {
    seeds: mixedCase.seeds,
    truth: mixedCase.truth,
    observed: mixedResult.errorVector,
    labels: mixedResult.labels,
    ok: vectorsEqual(mixedCase.truth, mixedResult.errorVector),
  };

  return {
    artifact: "classifier-self-validation",
    artifact_version: 1,
    classifier_version: CLASSIFIER_VERSION,
    seedStart,
    seedCount,
    ok: singleFaultCases.every((entry) => entry.ok) && mixed.ok,
    singleFaultCases,
    mixed,
  };
}

interface SyntheticCase {
  expected: string;
  actual: string;
  truth: ErrorVector;
}

interface MixedSyntheticCase extends SyntheticCase {
  seeds: number[];
}

function createSingleFaultCase(seed: number, fault: FaultLabel): SyntheticCase {
  const expected = baseText(seed);
  const truth = emptyErrorVector();
  let actual: string;

  switch (fault) {
    case "drop":
      actual = expected.replace("dropX", "drop");
      truth.drop = 1;
      break;
    case "insertion":
      actual = expected.replace("insert", "in\rsert");
      truth.insertion = 1;
      break;
    case "same-length-substitution":
      actual = expected.replace("sameq", "samez");
      truth["same-length-substitution"] = 1;
      break;
    case "case-error":
      actual = expected.replace("solo", "Solo");
      truth["case-error"] = 1;
      break;
    case "stuck-modifier-run":
      actual = expected.replace("stuck ab", "stuck AB");
      truth["stuck-modifier-run"] = 2;
      break;
    case "layout-swap-signature":
      actual = expected.replace('@ " # £', '" @ £ #');
      truth["layout-swap-signature"] = 4;
      break;
  }

  return { expected, actual, truth };
}

function createMixedFaultCase(seeds: number[]): MixedSyntheticCase {
  const seed = seeds[0] ?? 1;
  const expected = baseText(seed + 10_000);
  let actual = expected;
  const truth = emptyErrorVector();

  actual = actual.replace('@ " # £', '" @ £ #');
  truth["layout-swap-signature"] = 4;

  actual = actual.replace("stuck ab", "stuck AB");
  truth["stuck-modifier-run"] = 2;

  actual = actual.replace("solo", "Solo");
  truth["case-error"] = 1;

  actual = actual.replace("sameq", "samez");
  truth["same-length-substitution"] = 1;

  actual = actual.replace("dropX", "drop");
  truth.drop = 1;

  actual = actual.replace("insert", "in\rsert");
  truth.insertion = 1;

  return { expected, actual, truth, seeds };
}

function baseText(seed: number): string {
  return [
    `L0000 seed${seed} dropX insert sameq solo marker`,
    `L0001 stuck ab remains lower and spaced apart`,
    `L0002 layout @ " # £ sentinel <> mixedCaseTail`,
  ].join("\n");
}

function vectorsEqual(left: ErrorVector, right: ErrorVector): boolean {
  return FAULT_LABELS.every((label) => left[label] === right[label]);
}
