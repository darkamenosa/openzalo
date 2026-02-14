import { stat } from "node:fs/promises";
import { resolveOpenzcaProfileEnv, runOpenzca, parseJsonOutput } from "./openzca.js";
import { OPENZALO_TEXT_LIMIT } from "./constants.js";
import type { ZcaResult } from "./types.js";

export type OpenzaloSendOptions = {
  profile?: string;
  mediaUrl?: string;
  caption?: string;
  isGroup?: boolean;
  maxChars?: number;
  maxBytes?: number;
};

export type OpenzaloSendResult = {
  ok: boolean;
  messageId?: string;
  // Alias of messageId for compatibility with CLI/Openzalo naming.
  msgId?: string;
  cliMsgId?: string;
  error?: string;
};

export type OpenzaloActionResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

const MEDIA_SEND_TIMEOUT_MS = 120000;
const VIDEO_EXTENSIONS = /\.(mp4|mov|avi|webm|mkv)$/i;
const AUDIO_EXTENSIONS = /\.(aac|mp3|wav|ogg|m4a|flac)$/i;
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|avif)$/i;

function normalizeOpenzcaError(stderr: string, fallback: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return fallback;
  }
  const lines = trimmed
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cleaned = lines[index].replace(/^error:\s*/i, "").trim();
    if (cleaned) {
      return cleaned;
    }
  }
  return fallback;
}

function isRecoverableSuccessfulSendResult(result: ZcaResult): boolean {
  if (result.ok) {
    return true;
  }

  const refs = extractMessageRefs(result.stdout);
  if (refs.msgId || refs.cliMsgId) {
    return true;
  }

  const parsed = parseJsonOutput<unknown>(result.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const row = parsed as Record<string, unknown>;
  if (row.success === true) {
    return true;
  }
  const status = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  return status === "ok" || status === "success";
}

function resolveSendCommandResult(result: ZcaResult, fallbackError: string): OpenzaloSendResult {
  if (result.ok || isRecoverableSuccessfulSendResult(result)) {
    return buildSendSuccess(result.stdout);
  }
  return {
    ok: false,
    error: normalizeOpenzcaError(result.stderr, fallbackError),
  };
}

function resolveMaxChars(options: OpenzaloSendOptions): number {
  const candidate = options.maxChars;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return Math.min(Math.floor(candidate), OPENZALO_TEXT_LIMIT);
  }
  return OPENZALO_TEXT_LIMIT;
}

function clampText(text: string, options: OpenzaloSendOptions): string {
  const maxChars = resolveMaxChars(options);
  return text.slice(0, maxChars);
}

function isHttpUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw);
}

async function checkLocalFileSizeWithinLimit(pathLike: string, maxBytes?: number): Promise<string | null> {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return null;
  }
  const trimmed = pathLike.trim();
  if (!trimmed || isHttpUrl(trimmed)) {
    return null;
  }

  try {
    const meta = await stat(trimmed);
    if (!meta.isFile()) {
      return null;
    }
    if (meta.size > maxBytes) {
      const maxMb = (maxBytes / (1024 * 1024)).toFixed(1);
      const gotMb = (meta.size / (1024 * 1024)).toFixed(1);
      return `Media file is too large (${gotMb} MB). Limit is ${maxMb} MB.`;
    }
    return null;
  } catch {
    // Ignore stat failures (e.g. remote aliases or paths not present at precheck time).
    return null;
  }
}

export async function sendMessageOpenzalo(
  threadId: string,
  text: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloSendResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";

  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }

  // Handle media sending
  if (options.mediaUrl) {
    return sendMediaOpenzalo(threadId, options.mediaUrl, {
      ...options,
      caption: text || options.caption,
    });
  }

  // Send text message
  const args = ["msg", "send", threadId.trim(), clampText(text, options)];
  if (options.isGroup) {
    args.push("-g");
  }

  try {
    const result = await runOpenzca(args, { profile });
    return resolveSendCommandResult(result, "Failed to send message");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendTypingOpenzalo(
  threadId: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloSendResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";

  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }

  const args = ["msg", "typing", threadId.trim()];
  if (options.isGroup) {
    args.push("-g");
  }

  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      const refs = extractMessageRefs(result.stdout);
      return { ok: true, messageId: refs.msgId, msgId: refs.msgId };
    }

    return { ok: false, error: result.stderr || "Failed to send typing event" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendMediaOpenzalo(
  threadId: string,
  mediaUrl: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloSendResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";

  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }

  if (!mediaUrl?.trim()) {
    return { ok: false, error: "No media URL provided" };
  }

  const trimmedMedia = mediaUrl.trim();
  const lowerUrl = trimmedMedia.toLowerCase();
  let command: "video" | "voice" | "image" | "upload";
  if (VIDEO_EXTENSIONS.test(lowerUrl)) {
    command = "video";
  } else if (AUDIO_EXTENSIONS.test(lowerUrl)) {
    command = "voice";
  } else if (IMAGE_EXTENSIONS.test(lowerUrl)) {
    command = "image";
  } else {
    // Generic files (.xlsx/.pdf/.zip/...) must use msg upload instead of msg image.
    command = "upload";
  }

  const mediaSizeError = await checkLocalFileSizeWithinLimit(mediaUrl, options.maxBytes);
  if (mediaSizeError) {
    return { ok: false, error: mediaSizeError };
  }

  const args =
    command === "upload"
      ? ["msg", "upload", trimmedMedia, threadId.trim()]
      : ["msg", command, threadId.trim(), "-u", trimmedMedia];
  if (command !== "upload" && options.caption) {
    args.push("-m", clampText(options.caption, options));
  }
  if (options.isGroup) {
    args.push("-g");
  }

  try {
    const result = await runOpenzca(args, { profile, timeout: MEDIA_SEND_TIMEOUT_MS });
    // msg upload has no caption flag; keep file uploads attachment-only to avoid noisy follow-up text.
    return resolveSendCommandResult(
      result,
      command === "upload" ? "Failed to upload file" : `Failed to send ${command}`,
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendImageOpenzalo(
  threadId: string,
  imageUrl: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloSendResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const mediaSizeError = await checkLocalFileSizeWithinLimit(imageUrl, options.maxBytes);
  if (mediaSizeError) {
    return { ok: false, error: mediaSizeError };
  }
  const args = ["msg", "image", threadId.trim(), "-u", imageUrl.trim()];
  if (options.caption) {
    args.push("-m", clampText(options.caption, options));
  }
  if (options.isGroup) {
    args.push("-g");
  }

  try {
    const result = await runOpenzca(args, { profile, timeout: MEDIA_SEND_TIMEOUT_MS });
    return resolveSendCommandResult(result, "Failed to send image");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendLinkOpenzalo(
  threadId: string,
  url: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloSendResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = ["msg", "link", threadId.trim(), url.trim()];
  if (options.isGroup) {
    args.push("-g");
  }

  try {
    const result = await runOpenzca(args, { profile });
    return resolveSendCommandResult(result, "Failed to send link");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendReactionOpenzalo(
  params: {
    threadId: string;
    msgId: string;
    cliMsgId: string;
    reaction: string;
  },
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = [
    "msg",
    "react",
    params.msgId.trim(),
    params.cliMsgId.trim(),
    params.threadId.trim(),
    params.reaction.trim(),
  ];
  if (options.isGroup) {
    args.push("-g");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? result.stdout };
    }
    return { ok: false, error: result.stderr || "Failed to react to message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function readRecentMessagesOpenzalo(
  threadId: string,
  options: OpenzaloSendOptions & { count?: number } = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = ["msg", "recent", threadId.trim(), "-j"];
  const count = options.count;
  if (typeof count === "number" && Number.isFinite(count)) {
    const bounded = Math.min(Math.max(Math.trunc(count), 1), 200);
    args.push("-n", String(bounded));
  }
  if (options.isGroup) {
    args.push("-g");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? { raw: result.stdout } };
    }
    return { ok: false, error: result.stderr || "Failed to read recent messages" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteMessageOpenzalo(
  params: {
    threadId: string;
    msgId: string;
    cliMsgId: string;
    uidFrom: string;
    onlyMe?: boolean;
  },
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = [
    "msg",
    "delete",
    params.msgId.trim(),
    params.cliMsgId.trim(),
    params.uidFrom.trim(),
    params.threadId.trim(),
  ];
  if (options.isGroup) {
    args.push("-g");
  }
  if (params.onlyMe) {
    args.push("--only-me");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? result.stdout };
    }
    return { ok: false, error: result.stderr || "Failed to delete message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function unsendMessageOpenzalo(
  params: {
    threadId: string;
    msgId: string;
    cliMsgId: string;
  },
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = ["msg", "undo", params.msgId.trim(), params.cliMsgId.trim(), params.threadId.trim()];
  if (options.isGroup) {
    args.push("-g");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? result.stdout };
    }
    return { ok: false, error: result.stderr || "Failed to unsend message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function editMessageOpenzalo(
  params: {
    threadId: string;
    msgId: string;
    cliMsgId: string;
    message: string;
  },
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = [
    "msg",
    "edit",
    params.msgId.trim(),
    params.cliMsgId.trim(),
    params.threadId.trim(),
    clampText(params.message, options),
  ];
  if (options.isGroup) {
    args.push("-g");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? result.stdout };
    }
    return { ok: false, error: result.stderr || "Failed to edit message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function pinConversationOpenzalo(
  threadId: string,
  options: OpenzaloSendOptions & { pinned: boolean } = { pinned: true },
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = ["msg", options.pinned ? "pin" : "unpin", threadId.trim()];
  if (options.isGroup) {
    args.push("-g");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? result.stdout };
    }
    return {
      ok: false,
      error: result.stderr || `Failed to ${options.pinned ? "pin" : "unpin"} conversation`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listPinnedConversationsOpenzalo(
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  try {
    const result = await runOpenzca(["msg", "list-pins", "-j"], { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? { raw: result.stdout } };
    }
    return { ok: false, error: result.stderr || "Failed to list pinned conversations" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getMemberInfoOpenzalo(
  userId: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  try {
    const result = await runOpenzca(["msg", "member-info", userId.trim(), "-j"], { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? { raw: result.stdout } };
    }
    return { ok: false, error: result.stderr || "Failed to get member info" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type OpenzaloMessageRefs = {
  msgId?: string;
  cliMsgId?: string;
};

function buildSendSuccess(stdout: string): OpenzaloSendResult {
  const refs = extractMessageRefs(stdout);
  return {
    ok: true,
    messageId: refs.msgId,
    msgId: refs.msgId,
    cliMsgId: refs.cliMsgId,
  };
}

function extractMessageRefs(stdout: string): OpenzaloMessageRefs {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  const normalizeId = (value: unknown): string | undefined => {
    if (typeof value === "string") {
      const candidate = value.trim();
      return candidate || undefined;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }
    return undefined;
  };

  const pickRefsFromObject = (value: unknown): OpenzaloMessageRefs => {
    if (!value || typeof value !== "object") {
      return {};
    }
    const row = value as Record<string, unknown>;
    const directMsgId =
      normalizeId(row.messageId) ??
      normalizeId(row.msgId) ??
      normalizeId((row.data as Record<string, unknown> | undefined)?.messageId) ??
      normalizeId((row.data as Record<string, unknown> | undefined)?.msgId);
    const directCliMsgId =
      normalizeId(row.cliMsgId) ??
      normalizeId((row.data as Record<string, unknown> | undefined)?.cliMsgId);
    if (directMsgId || directCliMsgId) {
      return { msgId: directMsgId, cliMsgId: directCliMsgId };
    }

    const message = row.message as Record<string, unknown> | undefined;
    const messageId = normalizeId(message?.messageId) ?? normalizeId(message?.msgId);
    const messageCliMsgId = normalizeId(message?.cliMsgId);
    if (messageId || messageCliMsgId) {
      return { msgId: messageId, cliMsgId: messageCliMsgId };
    }

    const attachment = Array.isArray(row.attachment) ? row.attachment : [];
    for (const item of attachment) {
      const attachmentMsgId =
        normalizeId((item as Record<string, unknown>)?.messageId) ??
        normalizeId((item as Record<string, unknown>)?.msgId);
      const attachmentCliMsgId = normalizeId((item as Record<string, unknown>)?.cliMsgId);
      if (attachmentMsgId || attachmentCliMsgId) {
        return { msgId: attachmentMsgId, cliMsgId: attachmentCliMsgId };
      }
    }

    return {};
  };

  // First try JSON payloads.
  const parsed = parseJsonOutput<unknown>(trimmed);
  const parsedRefs = pickRefsFromObject(parsed);
  if (parsedRefs.msgId || parsedRefs.cliMsgId) {
    return parsedRefs;
  }

  // Then support util.inspect/table-style outputs from openzca CLI.
  const msgIdMatch = trimmed.match(/\bmsgId\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i);
  const cliMsgIdMatch = trimmed.match(/\bcliMsgId\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i);
  const messageIdMatch = trimmed.match(/\bmessage[_\s]?id\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i);
  const msgId = msgIdMatch?.[1] ?? messageIdMatch?.[1];
  const cliMsgId = cliMsgIdMatch?.[1];
  if (msgId || cliMsgId) {
    return { msgId, cliMsgId };
  }

  const firstWord = trimmed.split(/\s+/)[0];
  if (firstWord && /^[a-zA-Z0-9_-]+$/.test(firstWord)) {
    return { msgId: firstWord };
  }
  return {};
}
