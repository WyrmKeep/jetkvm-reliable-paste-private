export function normalizeControlledTraceValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeControlledTraceValue(item)) as T;
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key === "duration_ms" ? 0 : normalizeControlledTraceValue(nested),
    ]),
  ) as T;
}
