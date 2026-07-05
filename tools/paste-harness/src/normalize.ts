export interface NormalizeOptions {
  trimTrailingLf?: boolean;
}

export interface NormalizedComparison {
  equal: boolean;
  expected: string;
  actual: string;
  expectedCodePoints: string[];
  actualCodePoints: string[];
}

const decoder = new TextDecoder("utf-8", { fatal: false });

export function decodeUtf8Text(input: Buffer | Uint8Array | string): string {
  const text = typeof input === "string" ? input : decoder.decode(input);
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

export function normalizeText(input: Buffer | Uint8Array | string, options: NormalizeOptions = {}): string {
  const trimTrailingLf = options.trimTrailingLf ?? true;
  let text = decodeUtf8Text(input).replace(/\r\n/g, "\n");
  if (trimTrailingLf) {
    text = text.replace(/\n+$/g, "");
  }
  return text;
}

export function toCodePoints(text: string): string[] {
  return Array.from(text);
}

export function compareNormalizedText(
  expectedInput: Buffer | Uint8Array | string,
  actualInput: Buffer | Uint8Array | string,
  options: NormalizeOptions = {},
): NormalizedComparison {
  const expected = normalizeText(expectedInput, options);
  const actual = normalizeText(actualInput, options);
  const expectedCodePoints = toCodePoints(expected);
  const actualCodePoints = toCodePoints(actual);

  return {
    equal:
      expectedCodePoints.length === actualCodePoints.length &&
      expectedCodePoints.every((char, index) => char === actualCodePoints[index]),
    expected,
    actual,
    expectedCodePoints,
    actualCodePoints,
  };
}
