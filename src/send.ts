import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOutboundMediaFromUrlCompat, type LoadedOutboundMediaKind } from "./outbound-media-compat.js";
import { parseOpenzaloTarget } from "./normalize.js";
import { runOpenzcaAccountCommand } from "./openzca-account.js";
import { resolvePreferredOpenClawTmpDirCompat } from "./preferred-tmp-dir.js";
import { getOpenzaloRuntime } from "./runtime.js";
import type { CoreConfig, ResolvedOpenzaloAccount } from "./types.js";
import { parseOpenzcaMessageRefs } from "./message-refs.js";

type SendTextOptions = {
  cfg: CoreConfig;
  account: ResolvedOpenzaloAccount;
  to: string;
  text: string;
};

type SendMediaOptions = {
  cfg: CoreConfig;
  account: ResolvedOpenzaloAccount;
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaPath?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

type SendTypingOptions = {
  account: ResolvedOpenzaloAccount;
  to: string;
};

export type OpenzaloSendReceipt = {
  messageId: string;
  msgId?: string;
  cliMsgId?: string;
  kind: "text" | "media";
  textPreview?: string;
};

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function stripMediaPrefix(value: string): string {
  return value.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}

function expandHomePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path.resolve(expandHomePath(override));
  }
  return path.join(os.homedir(), ".openclaw");
}

async function defaultMediaRoots(): Promise<string[]> {
  const stateDir = resolveStateDir();
  return [
    await resolvePreferredOpenClawTmpDirCompat(),
    path.join(stateDir, "workspace"),
    path.join(stateDir, "media"),
    path.join(stateDir, "agents"),
    path.join(stateDir, "sandboxes"),
  ];
}

function resolveConfiguredRootPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty mediaLocalRoots entry is not allowed");
  }

  if (trimmed.startsWith("file://")) {
    let parsed: string;
    try {
      parsed = fileURLToPath(trimmed);
    } catch {
      throw new Error(`Invalid file:// URL in mediaLocalRoots: ${input}`);
    }
    if (!path.isAbsolute(parsed)) {
      throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);
    }
    return path.resolve(parsed);
  }

  const expanded = expandHomePath(trimmed);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);
  }
  return path.resolve(expanded);
}

async function resolveMediaRoots(localRoots?: readonly string[]): Promise<string[]> {
  const roots = [...(localRoots ?? []), ...(await defaultMediaRoots())];

  const deduped = new Set<string>();
  const resolved: string[] = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) {
      continue;
    }
    const resolvedPath = resolveConfiguredRootPath(trimmed);
    if (deduped.has(resolvedPath)) {
      continue;
    }
    deduped.add(resolvedPath);
    resolved.push(resolvedPath);
  }
  return resolved;
}

function resolveOpenzaloMediaMaxBytes(account: ResolvedOpenzaloAccount): number | undefined {
  const configuredMb = account.config.mediaMaxMb;
  if (typeof configuredMb !== "number" || !Number.isFinite(configuredMb) || configuredMb <= 0) {
    return undefined;
  }
  return Math.round(configuredMb * 1024 * 1024);
}

function normalizeLocalMediaSource(source: string): string {
  if (/^file:\/\//i.test(source)) {
    try {
      return fileURLToPath(source);
    } catch {
      return source;
    }
  }
  return expandHomePath(source);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveMediaLoadSource(params: {
  source: string;
  mediaLocalRoots: readonly string[];
}): Promise<string> {
  if (!params.source || isHttpUrl(params.source)) {
    return params.source;
  }
  const normalized = normalizeLocalMediaSource(params.source);
  if (path.isAbsolute(normalized)) {
    return normalized;
  }

  const candidates = [path.resolve(normalized)];
  for (const root of params.mediaLocalRoots) {
    candidates.push(path.resolve(root, normalized));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolvedCandidate = path.resolve(candidate);
    if (seen.has(resolvedCandidate)) {
      continue;
    }
    seen.add(resolvedCandidate);
    if (await fileExists(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }
  return normalized;
}

async function stageMediaSource(params: {
  account: ResolvedOpenzaloAccount;
  source: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<{
  source: string;
  sourceType: "path";
  rawSourceType: "url" | "path";
  mediaKind?: LoadedOutboundMediaKind;
}> {
  const normalized = stripMediaPrefix(params.source);
  if (!normalized) {
    return { source: "", sourceType: "path", rawSourceType: "path" };
  }
  const mediaLocalRoots = await resolveMediaRoots(params.mediaLocalRoots);
  const maxBytes = resolveOpenzaloMediaMaxBytes(params.account);
  const loadSource = await resolveMediaLoadSource({
    source: normalized,
    mediaLocalRoots,
  });
  const loaded = await loadOutboundMediaFromUrlCompat(loadSource, {
    maxBytes,
    mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  });
  const saved = await getOpenzaloRuntime().channel.media.saveMediaBuffer(
    loaded.buffer,
    loaded.contentType,
    "outbound",
    Math.max(maxBytes ?? 0, loaded.buffer.byteLength, 1),
    loaded.fileName,
  );
  return {
    source: saved.path,
    sourceType: "path",
    rawSourceType: isHttpUrl(normalized) ? "url" : "path",
    mediaKind: loaded.kind,
  };
}

type MediaCommand = "upload" | "image" | "video" | "voice";

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "webp",
  "heic",
  "heif",
  "avif",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "webm", "mkv"]);
const AUDIO_EXTENSIONS = new Set(["aac", "mp3", "m4a", "wav", "ogg", "opus", "flac"]);

function extractFileExtension(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  const fileName = withoutQuery.split("/").pop() ?? withoutQuery;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return "";
  }
  return fileName.slice(dot + 1).toLowerCase();
}

function resolveMediaCommand(source: string, mediaKind?: LoadedOutboundMediaKind): MediaCommand {
  if (mediaKind === "audio") {
    return "voice";
  }
  if (mediaKind === "video") {
    return "video";
  }
  if (mediaKind === "image") {
    return "image";
  }
  const ext = extractFileExtension(source);
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "voice";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  return "upload";
}

function buildOpenzcaMediaArgs(params: {
  target: { threadId: string; isGroup: boolean };
  source: string;
  mediaCommand: MediaCommand;
  message?: string;
}): string[] {
  const { target, source, mediaCommand } = params;
  const args = ["msg", mediaCommand];
  if (mediaCommand === "upload") {
    if (isHttpUrl(source)) {
      args.push(target.threadId, "--url", source);
    } else {
      args.push(source, target.threadId);
    }
  } else {
    args.push(target.threadId);
    if (isHttpUrl(source)) {
      args.push("--url", source);
    } else {
      args.push(source);
    }
    const caption = params.message?.trim();
    if (mediaCommand === "video" && caption) {
      args.push("--message", caption);
    }
  }
  if (target.isGroup) {
    args.push("--group");
  }
  return args;
}

function logOutbound(
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
): void {
  try {
    const logger = getOpenzaloRuntime().logging.getChildLogger({ subsystem: "openzalo/outbound" });
    logger[level]?.(message, meta);
  } catch {
    // Runtime may be unavailable during early boot/tests; ignore.
  }
}

export async function sendTextOpenzalo(options: SendTextOptions): Promise<OpenzaloSendReceipt> {
  const { account, to, text } = options;
  const target = parseOpenzaloTarget(to);
  const body = text.trim();
  if (!body) {
    return { messageId: "empty", kind: "text" };
  }

  const args = ["msg", "send", target.threadId, body];
  if (target.isGroup) {
    args.push("--group");
  }

  logOutbound("info", "sendText request", {
    accountId: account.accountId,
    to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    textLength: body.length,
  });

  try {
    const result = await runOpenzcaAccountCommand({
      account,
      binary: account.zcaBinary,
      profile: account.profile,
      args,
      timeoutMs: 20_000,
    });
    const refs = parseOpenzcaMessageRefs(result.stdout);
    logOutbound("info", "sendText success", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      msgId: refs.msgId,
      cliMsgId: refs.cliMsgId,
    });
    return {
      messageId: refs.msgId || "ok",
      msgId: refs.msgId,
      cliMsgId: refs.cliMsgId,
      kind: "text",
      textPreview: body,
    };
  } catch (error) {
    logOutbound("error", "sendText failed", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      error: String(error),
    });
    throw error;
  }
}

export async function sendMediaOpenzalo(
  options: SendMediaOptions,
): Promise<OpenzaloSendReceipt & { receipts: OpenzaloSendReceipt[] }> {
  const { account, to, text, mediaUrl, mediaPath, mediaLocalRoots, mediaReadFile } = options;
  const target = parseOpenzaloTarget(to);
  const rawSource = (mediaPath ?? mediaUrl ?? "").trim();
  if (!rawSource) {
    if (text?.trim()) {
      const receipt = await sendTextOpenzalo({
        cfg: options.cfg,
        account,
        to,
        text,
      });
      return {
        ...receipt,
        receipts: [receipt],
      };
    }
    return {
      messageId: "empty",
      kind: "media",
      receipts: [],
    };
  }

  const resolvedSource = await stageMediaSource({
    account,
    source: rawSource,
    mediaLocalRoots,
    mediaReadFile,
  });
  const source = resolvedSource.source;
  const resolvedMediaCommand = resolveMediaCommand(source, resolvedSource.mediaKind);
  let mediaCommand = resolvedMediaCommand;
  let args = buildOpenzcaMediaArgs({
    target,
    source,
    mediaCommand,
    message: text,
  });
  const sourceType = resolvedSource.sourceType;
  const rawSourceType = resolvedSource.rawSourceType;

  logOutbound("info", "sendMedia request", {
    accountId: account.accountId,
    to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    sourceType,
    rawSourceType,
    rawSource,
    source,
    mediaCommand: resolvedMediaCommand,
    hasCaption: Boolean(text?.trim()),
  });

  try {
    let result: Awaited<ReturnType<typeof runOpenzcaAccountCommand>>;
    try {
      result = await runOpenzcaAccountCommand({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 60_000,
      });
    } catch (error) {
      if (mediaCommand !== "upload") {
        logOutbound("warn", "sendMedia primary command failed; retrying with upload", {
          accountId: account.accountId,
          threadId: target.threadId,
          isGroup: target.isGroup,
          sourceType,
          rawSourceType,
          mediaCommand,
          source,
          error: String(error),
        });
        mediaCommand = "upload";
        args = buildOpenzcaMediaArgs({
          target,
          source,
          mediaCommand,
          message: text,
        });
        result = await runOpenzcaAccountCommand({
          account,
          binary: account.zcaBinary,
          profile: account.profile,
          args,
          timeoutMs: 60_000,
        });
      } else {
        throw error;
      }
    }
    const refs = parseOpenzcaMessageRefs(result.stdout);
    const mediaReceipt: OpenzaloSendReceipt = {
      messageId: refs.msgId || "ok",
      msgId: refs.msgId,
      cliMsgId: refs.cliMsgId,
      kind: "media",
    };

    const receipts: OpenzaloSendReceipt[] = [mediaReceipt];
    const captionSentInline = mediaCommand === "video" && Boolean(text?.trim());
    if (text?.trim() && !captionSentInline) {
      const captionReceipt = await sendTextOpenzalo({
        cfg: options.cfg,
        account,
        to,
        text,
      });
      receipts.push(captionReceipt);
    }

    const primary =
      [...receipts].reverse().find((entry) => Boolean(entry.msgId || entry.cliMsgId)) ||
      receipts[receipts.length - 1] ||
      mediaReceipt;

    logOutbound("info", "sendMedia success", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      sourceType,
      rawSourceType,
      mediaCommand,
      msgId: primary.msgId,
      cliMsgId: primary.cliMsgId,
      receiptCount: receipts.length,
    });

    return {
      ...primary,
      receipts,
    };
  } catch (error) {
    logOutbound("error", "sendMedia failed", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      sourceType,
      rawSourceType,
      mediaCommand,
      source,
      error: String(error),
    });
    throw error;
  }
}

export async function sendTypingOpenzalo(options: SendTypingOptions): Promise<void> {
  const { account, to } = options;
  const target = parseOpenzaloTarget(to);
  const args = ["msg", "typing", target.threadId];
  if (target.isGroup) {
    args.push("--group");
  }

  try {
    await runOpenzcaAccountCommand({
      account,
      binary: account.zcaBinary,
      profile: account.profile,
      args,
      timeoutMs: 10_000,
    });
  } catch (error) {
    logOutbound("warn", "sendTyping failed", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      error: String(error),
    });
    throw error;
  }
}
