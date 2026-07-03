import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  CORPUS_CLASSES,
  UK_REACHABLE_TEXT_CHARS,
  extractLineKeys,
  generateCorpus,
  validateCorpusText,
} from "./corpus.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("corpus generator", () => {
  test("covers every required class at every required size with LF-only keyed lines", () => {
    for (const corpusClass of CORPUS_CLASSES) {
      for (const size of [200, 6_000, 30_000, 100_000]) {
        const corpus = generateCorpus({
          corpusClass,
          size,
          seed: 17,
        });

        expect(corpus.length, `${corpusClass} size ${size}`).toBe(size);
        expect(corpus).not.toContain("\r");
        expect(corpus.endsWith("\n")).toBe(false);

        const keys = extractLineKeys(corpus);
        expect(keys.length).toBeGreaterThan(0);
        expect(new Set(keys).size).toBe(keys.length);
        for (const line of corpus.split("\n")) {
          expect(line.match(/(L\d{4})/)?.[1]).toMatch(/^L\d{4}$/);
        }

        expect(validateCorpusText(corpus).ok).toBe(true);
      }
    }
  });

  test("is byte-identical for the same args and changes when the seed changes", () => {
    for (const corpusClass of CORPUS_CLASSES) {
      const first = generateCorpus({ corpusClass, size: 30_000, seed: 1234 });
      const second = generateCorpus({ corpusClass, size: 30_000, seed: 1234 });
      const differentSeed = generateCorpus({ corpusClass, size: 30_000, seed: 1235 });

      expect(sha256(first)).toBe(sha256(second));
      expect(sha256(first)).not.toBe(sha256(differentSeed));
    }
  });

  test("keeps generated content inside the UK-reachable printable inventory plus LF", () => {
    const allowed = new Set([...UK_REACHABLE_TEXT_CHARS, "\n"]);

    for (const corpusClass of CORPUS_CLASSES) {
      const corpus = generateCorpus({ corpusClass, size: 6_000, seed: 99 });
      for (const char of [...corpus]) {
        expect(allowed.has(char), `${corpusClass} emitted ${JSON.stringify(char)}`).toBe(true);
      }
    }
  });

  test("rejects unsupported sizes before emitting partial corpora", () => {
    expect(() => generateCorpus({ corpusClass: "code", size: 199, seed: 1 })).toThrow(
      /size/i,
    );
    expect(() => generateCorpus({ corpusClass: "code", size: 100_001, seed: 1 })).toThrow(
      /size/i,
    );
  });
});
