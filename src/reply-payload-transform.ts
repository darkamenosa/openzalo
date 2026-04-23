import type { ReplyPayload } from "../api.js";

const MEDIA_DIRECTIVE_RE = /^\s*MEDIA:\s*(.+)$/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT_RE = /\.\w{1,10}$/;
const TRAVERSAL_SEGMENT_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

function cleanMediaCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/^[`"'[{(]+/, "")
    .replace(/[`"'\\})\],]+$/, "");
}

function unwrapQuoted(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return undefined;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return first === last && (first === `"` || first === "'" || first === "`")
    ? trimmed.slice(1, -1).trim()
    : undefined;
}

function hasTraversalOrHomePrefix(value: string): boolean {
  return (
    value === ".." ||
    value.startsWith("../") ||
    value.startsWith("~") ||
    TRAVERSAL_SEGMENT_RE.test(value)
  );
}

function looksLikeLocalPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(value) ||
    value.startsWith("\\\\") ||
    (!SCHEME_RE.test(value) && (value.includes("/") || value.includes("\\")))
  );
}

function isValidMediaSource(value: string, opts?: { allowBareFilename?: boolean }): boolean {
  if (!value || value.length > 4096 || hasTraversalOrHomePrefix(value)) {
    return false;
  }
  if (/^https?:\/\//i.test(value)) {
    return true;
  }
  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    WINDOWS_DRIVE_RE.test(value) ||
    value.startsWith("\\\\") ||
    (!SCHEME_RE.test(value) && (value.includes("/") || value.includes("\\")))
  ) {
    return true;
  }
  return Boolean(opts?.allowBareFilename && !SCHEME_RE.test(value) && HAS_FILE_EXT_RE.test(value));
}

function parseMediaSources(raw: string): string[] {
  const unwrapped = unwrapQuoted(raw);
  const direct = cleanMediaCandidate(unwrapped ?? raw);
  if (isValidMediaSource(direct, { allowBareFilename: true })) {
    return [direct];
  }
  if (unwrapped) {
    return [];
  }
  return raw
    .split(/\s+/)
    .map(cleanMediaCandidate)
    .filter((candidate) => isValidMediaSource(candidate, { allowBareFilename: true }));
}

function dedupeMediaSources(sources: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of sources) {
    const trimmed = source.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function hasOpenzaloMediaDirectives(text: string): boolean {
  return /^\s*MEDIA:/im.test(text);
}

export function parseOpenzaloMediaDirectives(payload: ReplyPayload): ReplyPayload {
  const rawText = payload.text;
  if (!rawText || !hasOpenzaloMediaDirectives(rawText)) {
    return payload;
  }

  const keptLines: string[] = [];
  const mediaSources: string[] = [];
  let inFence = false;
  let changed = false;

  for (const line of rawText.trimEnd().split("\n")) {
    const trimmedStart = line.trimStart();
    if (/^(?:```|~~~)/.test(trimmedStart)) {
      inFence = !inFence;
      keptLines.push(line);
      continue;
    }

    if (inFence) {
      keptLines.push(line);
      continue;
    }

    const directive = line.match(MEDIA_DIRECTIVE_RE);
    if (!directive) {
      keptLines.push(line);
      continue;
    }

    const sources = parseMediaSources(directive[1]);
    if (sources.length > 0) {
      mediaSources.push(...sources);
      changed = true;
      continue;
    }

    const cleanedPayload = cleanMediaCandidate(directive[1]);
    if (!looksLikeLocalPath(cleanedPayload)) {
      keptLines.push(line);
    } else {
      changed = true;
    }
  }

  const text = keptLines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (mediaSources.length === 0) {
    return changed
      ? {
          ...payload,
          text: text || undefined,
        }
      : payload;
  }

  const existingMediaSources = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  const mediaUrls = dedupeMediaSources([...existingMediaSources, ...mediaSources]);
  return {
    ...payload,
    text: text || undefined,
    mediaUrl: payload.mediaUrl ?? mediaUrls[0],
    mediaUrls,
  };
}
