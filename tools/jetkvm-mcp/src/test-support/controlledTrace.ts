const CONTROLLED_TIMESTAMP_FIELDS = new Set([
  "accepted_at",
  "captured_at",
  "completed_at",
  "observed_at",
]);

export function normalizeControlledTraceValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeControlledTraceValue(item)) as T;
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      CONTROLLED_TIMESTAMP_FIELDS.has(key)
        ? "1970-01-01T00:00:00.000Z"
        : key === "duration_ms" || key === "age_ms"
          ? 0
          : normalizeControlledTraceValue(nested),
    ]),
  ) as T;
}
