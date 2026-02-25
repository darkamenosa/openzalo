import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenzaloTarget } from "./normalize.js";
import { runOpenzcaCommand } from "./openzca.js";
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

type ResolvedMediaRoot = {
  resolvedPath: string;
  realPath: string;
};

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

function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  if (process.platform === "win32") {
    const candidateLower = normalizedCandidate.toLowerCase();
    const rootLower = normalizedRoot.toLowerCase();
    const rootWithSepLower = rootWithSep.toLowerCase();
    return candidateLower === rootLower || candidateLower.startsWith(rootWithSepLower);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSep);
}

async function resolveMediaRoots(localRoots?: readonly string[]): Promise<ResolvedMediaRoot[]> {
  const stateDir = resolveStateDir();
  const roots = [
    ...(localRoots ?? []),
    path.join(stateDir, "workspace"),
    path.join(stateDir, "media"),
    path.join(stateDir, "agents"),
    path.join(stateDir, "sandboxes"),
  ];

  const deduped = new Set<string>();
  const resolved: ResolvedMediaRoot[] = [];
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
    let realPath = resolvedPath;
    try {
      realPath = await fs.realpath(resolvedPath);
    } catch {
      // Keep unresolved root for future directories that may not exist yet.
    }
    resolved.push({
      resolvedPath,
      realPath: path.resolve(realPath),
    });
  }
  return resolved;
}

function normalizeLocalSourcePath(source: string): string {
  const stripped = stripMediaPrefix(source);
  if (/^file:\/\//i.test(stripped)) {
    try {
      return fileURLToPath(stripped);
    } catch {
      return stripped;
    }
  }
  return expandHomePath(stripped);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveAllowedLocalFile(params: {
  candidate: string;
  roots: ResolvedMediaRoot[];
}): Promise<string | null> {
  const resolvedCandidate = path.resolve(params.candidate);

  for (const root of params.roots) {
    const relativeToRoot = path.relative(root.resolvedPath, resolvedCandidate);
    if (
      !relativeToRoot ||
      relativeToRoot.startsWith("..") ||
      path.isAbsolute(relativeToRoot)
    ) {
      continue;
    }

    const candidateFromRealRoot = path.resolve(root.realPath, relativeToRoot);
    if (!isPathInsideRoot(candidateFromRealRoot, root.realPath)) {
      continue;
    }

    try {
      const realPath = await fs.realpath(candidateFromRealRoot);
      if (!isPathInsideRoot(realPath, root.realPath)) {
        continue;
      }
      const stat = await fs.stat(realPath);
      if (!stat.isFile()) {
        continue;
      }
      return realPath;
    } catch {
      continue;
    }
  }

  return null;
}

async function resolveMediaSource(params: {
  source: string;
  mediaLocalRoots?: readonly string[];
}): Promise<{ source: string; sourceType: "url" | "path" }> {
  const normalized = stripMediaPrefix(params.source);
  if (!normalized) {
    return { source: "", sourceType: "path" };
  }
  if (isHttpUrl(normalized)) {
    return { source: normalized, sourceType: "url" };
  }

  const local = normalizeLocalSourcePath(normalized);
  const roots = await resolveMediaRoots(params.mediaLocalRoots);
  const candidates: string[] = [];
  if (path.isAbsolute(local)) {
    candidates.push(path.resolve(local));
  } else {
    const relative = local.replace(/^\.[/\\]+/, "");
    candidates.push(path.resolve(local));
    for (const root of roots) {
      candidates.push(path.resolve(root.resolvedPath, local));
      if (relative && relative !== local) {
        candidates.push(path.resolve(root.resolvedPath, relative));
      }
    }
  }

  const seen = new Set<string>();
  const attempted: string[] = [];
  const blocked: string[] = [];
  for (const candidate of candidates) {
    const normalizedCandidate = path.resolve(candidate);
    if (seen.has(normalizedCandidate)) {
      continue;
    }
    seen.add(normalizedCandidate);
    attempted.push(normalizedCandidate);
    if (!(await fileExists(normalizedCandidate))) {
      continue;
    }

    const allowedPath = await resolveAllowedLocalFile({
      candidate: normalizedCandidate,
      roots,
    });
    if (allowedPath) {
      return { source: allowedPath, sourceType: "path" };
    }
    blocked.push(normalizedCandidate);
  }

  if (blocked.length > 0) {
    throw new Error(
      "OpenZalo local media path is outside allowed roots. " +
        `Source="${params.source}" Existing candidates: ${blocked.slice(0, 4).join(" | ")}. ` +
        'Set "channels.openzalo.mediaLocalRoots" (or per-account mediaLocalRoots) to allow more paths.',
    );
  }

  throw new Error(
    `OpenZalo media file not found for source "${params.source}". Tried: ${attempted.slice(0, 8).join(" | ")}`,
  );
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

function resolveMediaCommand(source: string): MediaCommand {
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
    const result = await runOpenzcaCommand({
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
  const { account, to, text, mediaUrl, mediaPath, mediaLocalRoots } = options;
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

  const resolvedSource = await resolveMediaSource({
    source: rawSource,
    mediaLocalRoots,
  });
  const source = resolvedSource.source;
  const resolvedMediaCommand = resolveMediaCommand(source);
  let mediaCommand = resolvedMediaCommand;
  let args = buildOpenzcaMediaArgs({
    target,
    source,
    mediaCommand,
  });
  const sourceType = resolvedSource.sourceType;

  logOutbound("info", "sendMedia request", {
    accountId: account.accountId,
    to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    sourceType,
    rawSource,
    source,
    mediaCommand: resolvedMediaCommand,
    hasCaption: Boolean(text?.trim()),
  });

  try {
    let result: Awaited<ReturnType<typeof runOpenzcaCommand>>;
    try {
      result = await runOpenzcaCommand({
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
          mediaCommand,
          source,
          error: String(error),
        });
        mediaCommand = "upload";
        args = buildOpenzcaMediaArgs({
          target,
          source,
          mediaCommand,
        });
        result = await runOpenzcaCommand({
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
    if (text?.trim()) {
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
    await runOpenzcaCommand({
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
