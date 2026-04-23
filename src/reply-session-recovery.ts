import fs from "node:fs/promises";
import path from "node:path";
import type { ReplyPayload } from "../api.js";
import {
  hasOpenzaloMediaDirectives,
  parseOpenzaloMediaDirectives,
} from "./reply-payload-transform.js";

export type OpenzaloReplyRecoveryTrace = (
  event: string,
  meta: Record<string, unknown>,
) => void;

type ExtractedAssistantText = {
  text: string;
  lineNumber: number;
  finalAnswer: boolean;
};

type RecoveryStoreCandidate = {
  storePath: string;
  source: "direct" | "sessionsIndex";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function listOpenzaloPayloadMedia(payload: ReplyPayload): string[] {
  return payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
}

export function normalizeOpenzaloRecoveryText(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function parseTextSignaturePhase(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && typeof parsed.phase === "string"
      ? parsed.phase
      : undefined;
  } catch {
    return undefined;
  }
}

function extractAssistantTextFromSessionLine(
  line: string,
  lineNumber: number,
): ExtractedAssistantText | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !isRecord(parsed.message)) {
    return null;
  }
  const message = parsed.message;
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }

  const textParts: string[] = [];
  let finalAnswer = false;
  for (const item of message.content) {
    if (!isRecord(item)) {
      continue;
    }
    if (parseTextSignaturePhase(item.textSignature) === "final_answer") {
      finalAnswer = true;
    }
    if (item.type === "text" && typeof item.text === "string") {
      textParts.push(item.text);
    }
  }

  return textParts.length > 0
    ? {
        text: textParts.join("\n"),
        lineNumber,
        finalAnswer,
      }
    : null;
}

function isSessionIndexPath(storePath: string): boolean {
  return path.basename(storePath) === "sessions.json";
}

function extractSessionFileFromIndex(
  index: unknown,
  sessionKey: string | undefined,
): string | null {
  if (!sessionKey || !isRecord(index)) {
    return null;
  }
  const entry = index[sessionKey];
  if (!isRecord(entry) || typeof entry.sessionFile !== "string") {
    return null;
  }
  return entry.sessionFile.trim() || null;
}

async function resolveOpenzaloRecoveryStoreCandidate(params: {
  storePath: string;
  sessionKey?: string;
  trace?: OpenzaloReplyRecoveryTrace;
}): Promise<RecoveryStoreCandidate | null> {
  if (!isSessionIndexPath(params.storePath)) {
    return {
      storePath: params.storePath,
      source: "direct",
    };
  }

  let rawIndex: string;
  try {
    rawIndex = await fs.readFile(params.storePath, "utf8");
  } catch (error) {
    params.trace?.("recovery.indexReadFailed", {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  try {
    const sessionFile = extractSessionFileFromIndex(JSON.parse(rawIndex), params.sessionKey);
    if (!sessionFile) {
      params.trace?.("recovery.indexMiss", {
        storePath: params.storePath,
        sessionKey: params.sessionKey,
      });
      return null;
    }
    params.trace?.("recovery.indexHit", {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      sessionFile,
    });
    return {
      storePath: sessionFile,
      source: "sessionsIndex",
    };
  } catch (error) {
    params.trace?.("recovery.indexParseFailed", {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function recoverOpenzaloMediaPayloadFromCandidate(params: {
  candidate: RecoveryStoreCandidate;
  originalStorePath: string;
  payload: ReplyPayload;
  deliveryText: string;
  maxLines: number;
  trace?: OpenzaloReplyRecoveryTrace;
}): Promise<ReplyPayload | null> {
  let raw: string;
  try {
    raw = await fs.readFile(params.candidate.storePath, "utf8");
  } catch (error) {
    params.trace?.("recovery.readFailed", {
      storePath: params.originalStorePath,
      candidateStorePath: params.candidate.storePath,
      candidateSource: params.candidate.source,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const lines = raw.split(/\r?\n/);
  const start = Math.max(0, lines.length - params.maxLines);
  let assistantTextLinesChecked = 0;

  for (let index = lines.length - 1; index >= start; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    const extracted = extractAssistantTextFromSessionLine(line, index + 1);
    if (!extracted) {
      continue;
    }
    assistantTextLinesChecked += 1;

    if (!hasOpenzaloMediaDirectives(extracted.text)) {
      continue;
    }

    const recovered = parseOpenzaloMediaDirectives({
      ...params.payload,
      text: extracted.text,
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
    const recoveredMedia = listOpenzaloPayloadMedia(recovered);
    const recoveredText = normalizeOpenzaloRecoveryText(recovered.text);

    if (recoveredMedia.length === 0) {
      params.trace?.("recovery.directiveWithoutMedia", {
        storePath: params.originalStorePath,
        candidateStorePath: params.candidate.storePath,
        candidateSource: params.candidate.source,
        sourceLine: extracted.lineNumber,
        finalAnswer: extracted.finalAnswer || undefined,
      });
      return null;
    }

    if (recoveredText !== params.deliveryText) {
      params.trace?.("recovery.skipTextMismatch", {
        storePath: params.originalStorePath,
        candidateStorePath: params.candidate.storePath,
        candidateSource: params.candidate.source,
        sourceLine: extracted.lineNumber,
        finalAnswer: extracted.finalAnswer || undefined,
        deliveryTextPreview: params.deliveryText.slice(0, 240),
        recoveredTextPreview: recoveredText.slice(0, 240),
      });
      return null;
    }

    params.trace?.("recovery.hit", {
      storePath: params.originalStorePath,
      candidateStorePath: params.candidate.storePath,
      candidateSource: params.candidate.source,
      sourceLine: extracted.lineNumber,
      finalAnswer: extracted.finalAnswer || undefined,
      mediaCount: recoveredMedia.length,
      mediaRefs: recoveredMedia.slice(0, 5),
    });
    return recovered;
  }

  params.trace?.("recovery.miss", {
    storePath: params.originalStorePath,
    candidateStorePath: params.candidate.storePath,
    candidateSource: params.candidate.source,
    checkedLines: lines.length - start,
    assistantTextLinesChecked,
  });
  return null;
}

export async function recoverOpenzaloMediaPayloadFromSession(params: {
  storePath?: string;
  sessionKey?: string;
  payload: ReplyPayload;
  maxLines?: number;
  trace?: OpenzaloReplyRecoveryTrace;
}): Promise<ReplyPayload | null> {
  const currentMedia = listOpenzaloPayloadMedia(params.payload);
  const deliveryText = normalizeOpenzaloRecoveryText(params.payload.text);
  if (!params.storePath || currentMedia.length > 0 || !deliveryText) {
    return null;
  }

  const maxLines = Math.max(1, Math.floor(params.maxLines ?? 120));
  const candidate = await resolveOpenzaloRecoveryStoreCandidate({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    trace: params.trace,
  });
  if (!candidate) {
    params.trace?.("recovery.noCandidates", {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    });
    return null;
  }

  return recoverOpenzaloMediaPayloadFromCandidate({
    candidate,
    originalStorePath: params.storePath,
    payload: params.payload,
    deliveryText,
    maxLines,
    trace: params.trace,
  });
}
