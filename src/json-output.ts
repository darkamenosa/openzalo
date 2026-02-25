export function parseJsonOutput(
  text: string,
  options?: {
    strict?: boolean;
    emptyValue?: unknown;
    errorPrefix?: string;
    previewLength?: number;
  },
): unknown {
  const strict = options?.strict === true;
  const emptyValue = options?.emptyValue ?? null;
  const errorPrefix = options?.errorPrefix ?? "failed to parse JSON output";
  const previewLength = options?.previewLength ?? 160;
  const trimmed = text.trim();

  if (!trimmed) {
    if (strict) {
      throw new Error("empty JSON output");
    }
    return emptyValue;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }
  }

  if (strict) {
    throw new Error(`${errorPrefix}: ${trimmed.slice(0, previewLength)}`);
  }
  return emptyValue;
}
