import type { ChildProcess } from "node:child_process";
import type {
  OpenClawConfig,
  MarkdownTableMode,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
  mergeAllowlist,
  resolveChannelMediaMaxBytes,
  summarizeMapping,
} from "openclaw/plugin-sdk";
import type {
  OpenzaloGroupMentionDetectionFailureMode,
  ResolvedOpenzaloAccount,
  ZcaFriend,
  ZcaGroup,
  ZcaMessage,
} from "./types.js";
import { getOpenzaloRuntime } from "./runtime.js";
import { readRecentMessagesOpenzalo, sendMessageOpenzalo, sendTypingOpenzalo } from "./send.js";
import { parseJsonOutput, runOpenzca, runOpenzcaStreaming } from "./openzca.js";
import {
  OPENZALO_DEFAULT_GROUP_HISTORY_LIMIT,
  OPENZALO_DEFAULT_FAILURE_NOTICE_MESSAGE,
  OPENZALO_TEXT_LIMIT,
} from "./constants.js";

type OpenzaloStatusPatch = {
  lastInboundAt?: number;
  lastOutboundAt?: number;
  dispatchFailures?: number;
  typingFailures?: number;
  textChunkFailures?: number;
  mediaFailures?: number;
  failureNoticesSent?: number;
  failureNoticeFailures?: number;
  humanPassSkips?: number;
};

type OpenzaloMetricName =
  | "dispatchFailures"
  | "typingFailures"
  | "textChunkFailures"
  | "mediaFailures"
  | "failureNoticesSent"
  | "failureNoticeFailures"
  | "humanPassSkips";

type OpenzaloMetricCounters = Record<OpenzaloMetricName, number>;

export type OpenzaloMonitorOptions = {
  account: ResolvedOpenzaloAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: OpenzaloStatusPatch) => void;
};

export type OpenzaloMonitorResult = {
  stop: () => void;
};

type OpenzaloDispatchOutcome = {
  sent: boolean;
  failed: boolean;
  textChunkFailures: number;
  mediaFailures: number;
};

type HumanPassCommand = "on" | "off";
const CONTEXT_REFERENCE_PATTERNS = [
  /\b(it|this|that|these|those|same|again|continue|above|before|earlier|there|then)\b/i,
  /\b(cai do|nhu tren|o tren|ben tren|vua nay|hoi nay|tiep|tiep theo|y truoc|y kia)\b/i,
];

function normalizeOpenzaloEntry(entry: string): string {
  return entry.replace(/^(openzalo|zlu):/i, "").trim();
}

function buildNameIndex<T>(items: T[], nameFn: (item: T) => string | undefined): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const name = nameFn(item)?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const list = index.get(name) ?? [];
    list.push(item);
    index.set(name, list);
  }
  return index;
}

type OpenzaloCoreRuntime = ReturnType<typeof getOpenzaloRuntime>;

function logVerbose(core: OpenzaloCoreRuntime, runtime: RuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log(`[openzalo] ${message}`);
  }
}

function warnMentionDetectionFailure({
  runtime,
  accountId,
  chatId,
  mode,
}: {
  runtime: RuntimeEnv;
  accountId: string;
  chatId: string;
  mode: OpenzaloGroupMentionDetectionFailureMode;
}): void {
  runtime.error(
    `[openzalo] group mention gating is enabled for ${chatId} but no valid mention pattern was built. ` +
      `Current behavior: ${mode}. Set channels.openzalo.groupMentionDetectionFailure to ` +
      `"allow" or "allow-with-warning" to continue processing when detection fails.`,
  );
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(openzalo|zlu):/i, "");
    return normalized === normalizedSenderId;
  });
}

function normalizeGroupSlug(raw?: string | null): string {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isGroupAllowed(params: {
  groupId: string;
  groupName?: string | null;
  groups: Record<string, { allow?: boolean; enabled?: boolean }>;
}): boolean {
  const groups = params.groups ?? {};
  const keys = Object.keys(groups);
  if (keys.length === 0) {
    return false;
  }
  const candidates = [
    params.groupId,
    `group:${params.groupId}`,
    params.groupName ?? "",
    normalizeGroupSlug(params.groupName ?? ""),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const entry = groups[candidate];
    if (!entry) {
      continue;
    }
    return entry.allow !== false && entry.enabled !== false;
  }
  const wildcard = groups["*"];
  if (wildcard) {
    return wildcard.allow !== false && wildcard.enabled !== false;
  }
  return false;
}

function classifyOpenzcaStderr(text: string): "info" | "warn" | "error" {
  const trimmed = text.trim();
  if (!trimmed) {
    return "info";
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { level?: unknown; severity?: unknown };
      const level = String(parsed.level ?? parsed.severity ?? "").toLowerCase();
      if (level.includes("error") || level.includes("fatal")) {
        return "error";
      }
      if (level.includes("warn")) {
        return "warn";
      }
      if (level) {
        return "info";
      }
    } catch {
      // Ignore JSON parsing errors; fall back to pattern heuristics below.
    }
  }

  const lower = trimmed.toLowerCase();
  const infoHints = [
    "debug",
    "info",
    "listening",
    "connected",
    "reconnected",
    "heartbeat",
    "ping",
    "pong",
    "keepalive",
    "qr",
    "scan",
  ];
  if (infoHints.some((hint) => lower.includes(hint))) {
    return "info";
  }

  const errorHints = [
    "error",
    "exception",
    "unhandled",
    "fatal",
    "panic",
    "denied",
    "failed",
    "timeout",
    "refused",
    "reject",
    "enoent",
    "econnreset",
    "eacces",
  ];
  if (errorHints.some((hint) => lower.includes(hint))) {
    return "error";
  }

  const warnHints = ["warn", "warning", "retry", "reconnect", "backoff", "throttle"];
  if (warnHints.some((hint) => lower.includes(hint))) {
    return "warn";
  }

  return "info";
}

function shouldRestartOnOpenzcaListenerStderr(text: string): boolean {
  return /(?:^|\s)listen\.(?:closed|error|disconnected|stop)\b/i.test(text);
}

function parseHumanPassCommand(raw: string): HumanPassCommand | null {
  const normalized = raw.trim().toLowerCase();
  if (/^(?:\/)?(?:human\s*pass|humanpass|bot)\s+on$/.test(normalized)) {
    return "on";
  }
  if (/^(?:\/)?(?:human\s*pass|humanpass|bot)\s+off$/.test(normalized)) {
    return "off";
  }
  return null;
}

type OpenzaloMentionSegment = {
  pos?: number;
  len?: number;
  text?: string;
};

function collectBotMentionSegments(message: ZcaMessage, botUserId?: string): OpenzaloMentionSegment[] {
  const normalizedBotUserId = normalizeMentionUid(botUserId);
  if (!normalizedBotUserId) {
    return [];
  }

  const out: OpenzaloMentionSegment[] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const row = item as { uid?: unknown; pos?: unknown; len?: unknown; text?: unknown };
      const uid = normalizeMentionUid(row.uid);
      if (uid !== normalizedBotUserId) {
        continue;
      }
      const pos =
        typeof row.pos === "number" && Number.isFinite(row.pos) && row.pos >= 0
          ? Math.trunc(row.pos)
          : undefined;
      const len =
        typeof row.len === "number" && Number.isFinite(row.len) && row.len > 0
          ? Math.trunc(row.len)
          : undefined;
      out.push({
        pos,
        len,
        text: normalizeStringValue(row.text),
      });
    }
  };

  collect(message.mentions);
  collect(message.metadata?.mentions);
  return out;
}

function stripBotMentionsFromBody(params: {
  rawBody: string;
  message: ZcaMessage;
  botUserId?: string;
}): string {
  const segments = collectBotMentionSegments(params.message, params.botUserId);
  if (segments.length === 0) {
    return params.rawBody.trim();
  }

  let output = params.rawBody;
  const ranges = segments
    .filter(
      (segment): segment is { pos: number; len: number; text?: string } =>
        typeof segment.pos === "number" && typeof segment.len === "number",
    )
    .sort((a, b) => b.pos - a.pos);
  for (const range of ranges) {
    if (range.pos >= output.length) {
      continue;
    }
    const end = Math.min(output.length, range.pos + range.len);
    output = `${output.slice(0, range.pos)} ${output.slice(end)}`;
  }
  for (const segment of segments) {
    const token = segment.text?.trim();
    if (!token) {
      continue;
    }
    output = output.split(token).join(" ");
  }
  return output.replace(/\s+/g, " ").trim();
}

function resolveControlCommandBody(params: {
  rawBody: string;
  message: ZcaMessage;
  botUserId?: string;
  wasMentionedByUid: boolean;
}): string {
  const rawTrimmed = params.rawBody.trim();
  const stripped = stripBotMentionsFromBody({
    rawBody: params.rawBody,
    message: params.message,
    botUserId: params.botUserId,
  });
  if (stripped && stripped !== rawTrimmed) {
    return stripped;
  }

  // Fallback for text-only mentions like "@Thư /new" when structured mention
  // offsets are not present in the inbound payload.
  const mentionPrefixedCommand = rawTrimmed.match(/^@\S+(?:\s+@\S+)*\s+(\/[a-z][\s\S]*)$/iu);
  if (mentionPrefixedCommand?.[1]) {
    return mentionPrefixedCommand[1].trim();
  }

  // Fallback for mention display names that include spaces (for example "@Nguyen Van A /new")
  // when structured mention metadata is unavailable.
  if (rawTrimmed.startsWith("@")) {
    const slashIndex = rawTrimmed.indexOf("/");
    if (slashIndex > 0) {
      const candidate = rawTrimmed.slice(slashIndex).trim();
      if (/^\/[a-z]/i.test(candidate)) {
        return candidate;
      }
    }
  }

  // Fallback: when explicit mention is known but mention text offsets are unavailable,
  // attempt to parse command token from first slash.
  if (params.wasMentionedByUid) {
    const slashIndex = rawTrimmed.indexOf("/");
    if (slashIndex >= 0) {
      const candidate = rawTrimmed.slice(slashIndex).trim();
      if (/^\/[a-z]/i.test(candidate)) {
        return candidate;
      }
    }
  }

  return stripped || rawTrimmed;
}

function normalizeMentionUid(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function extractMentionIds(message: ZcaMessage): string[] {
  const ids = new Set<string>();

  const collectMentionIds = (value: unknown): void => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      const uid = normalizeMentionUid(item);
      if (uid) {
        ids.add(uid);
      }
    }
  };

  const collectMentions = (value: unknown): void => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const uid = normalizeMentionUid((item as { uid?: unknown }).uid);
      if (uid) {
        ids.add(uid);
      }
    }
  };

  collectMentionIds(message.mentionIds);
  collectMentions(message.mentions);
  collectMentionIds(message.metadata?.mentionIds);
  collectMentions(message.metadata?.mentions);

  return Array.from(ids);
}

function inferIsGroupMessage(message: ZcaMessage): boolean {
  if (typeof message.metadata?.isGroup === "boolean") {
    return message.metadata.isGroup;
  }
  const chatTypeRaw = message.chatType ?? message.metadata?.chatType;
  if (typeof chatTypeRaw === "string") {
    const normalized = chatTypeRaw.trim().toLowerCase();
    if (normalized === "group") {
      return true;
    }
    if (normalized === "user" || normalized === "direct" || normalized === "dm") {
      return false;
    }
  }
  // openzca commonly emits type=1 for group thread events.
  return message.type === 1;
}

function normalizeStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function collectUniqueStrings(...values: unknown[]): string[] {
  const unique = new Set<string>();
  const add = (value: unknown): void => {
    const normalized = normalizeStringValue(value);
    if (normalized) {
      unique.add(normalized);
    }
  };

  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        add(item);
      }
      continue;
    }
    add(value);
  }

  return Array.from(unique);
}

type ResolvedOpenzaloMediaContext = {
  mediaPath?: string;
  mediaPaths?: string[];
  mediaUrl?: string;
  mediaUrls?: string[];
  mediaType?: string;
  mediaTypes?: string[];
};

function resolveMediaContext(message: ZcaMessage): ResolvedOpenzaloMediaContext {
  const messageMediaPaths = collectUniqueStrings(
    message.mediaPaths,
    message.metadata?.mediaPaths,
    message.mediaPath,
    message.metadata?.mediaPath,
  );
  const messageMediaUrls = collectUniqueStrings(
    message.mediaUrls,
    message.metadata?.mediaUrls,
    message.mediaUrl,
    message.metadata?.mediaUrl,
  );
  const messageMediaTypes = collectUniqueStrings(
    message.mediaTypes,
    message.metadata?.mediaTypes,
    message.mediaType,
    message.metadata?.mediaType,
  );

  const quoteMediaPaths = collectUniqueStrings(
    message.quoteMediaPaths,
    message.metadata?.quoteMediaPaths,
    message.quote?.mediaPaths,
    message.metadata?.quote?.mediaPaths,
    message.quoteMediaPath,
    message.metadata?.quoteMediaPath,
    message.quote?.mediaPath,
    message.metadata?.quote?.mediaPath,
  );
  const quoteMediaUrls = collectUniqueStrings(
    message.quoteMediaUrls,
    message.metadata?.quoteMediaUrls,
    message.quote?.mediaUrls,
    message.metadata?.quote?.mediaUrls,
    message.quoteMediaUrl,
    message.metadata?.quoteMediaUrl,
    message.quote?.mediaUrl,
    message.metadata?.quote?.mediaUrl,
  );
  const quoteMediaTypes = collectUniqueStrings(
    message.quoteMediaTypes,
    message.metadata?.quoteMediaTypes,
    message.quote?.mediaTypes,
    message.metadata?.quote?.mediaTypes,
    message.quoteMediaType,
    message.metadata?.quoteMediaType,
    message.quote?.mediaType,
    message.metadata?.quote?.mediaType,
  );
  const mediaPaths = collectUniqueStrings(messageMediaPaths, quoteMediaPaths);
  const mediaUrls = collectUniqueStrings(messageMediaUrls, quoteMediaUrls);
  const mediaTypes = collectUniqueStrings(messageMediaTypes, quoteMediaTypes);

  return {
    mediaPath: mediaPaths[0],
    mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    mediaUrl: mediaUrls[0],
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    mediaType: mediaTypes[0],
    mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

type ResolvedOpenzaloQuoteContext = {
  hasQuote: boolean;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
};

function resolveQuoteContext(message: ZcaMessage): ResolvedOpenzaloQuoteContext {
  const quote = message.quote ?? message.metadata?.quote;
  const replyToId = normalizeStringValue(quote?.cliMsgId);
  const replyToIdFull = normalizeStringValue(quote?.globalMsgId) ?? replyToId;
  const replyToBody = normalizeStringValue(quote?.msg);
  const replyToSender = normalizeStringValue(quote?.senderName) ?? normalizeStringValue(quote?.ownerId);
  const hasQuoteMedia =
    collectUniqueStrings(
      message.quoteMediaPaths,
      message.metadata?.quoteMediaPaths,
      message.quoteMediaUrls,
      message.metadata?.quoteMediaUrls,
      message.quoteMediaPath,
      message.metadata?.quoteMediaPath,
      message.quoteMediaUrl,
      message.metadata?.quoteMediaUrl,
    ).length > 0;

  return {
    hasQuote: Boolean(quote || replyToId || replyToBody || replyToSender || hasQuoteMedia),
    replyToId,
    replyToIdFull,
    replyToBody,
    replyToSender,
  };
}

function resolveMediaKind(mediaType?: string): string | undefined {
  if (!mediaType) {
    return undefined;
  }
  const normalized = mediaType.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "image" || normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized === "video" || normalized.startsWith("video/")) {
    return "video";
  }
  if (
    normalized === "audio" ||
    normalized === "voice" ||
    normalized.startsWith("audio/") ||
    normalized.includes("voice")
  ) {
    return "audio";
  }
  return "attachment";
}

type OpenzaloContextHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
};

type OpenzaloRecentMessageRow = {
  msgId?: unknown;
  cliMsgId?: unknown;
  senderId?: unknown;
  senderName?: unknown;
  ts?: unknown;
  msgType?: unknown;
  content?: unknown;
};

type OpenzaloRecentMessagesPayload = {
  messages?: OpenzaloRecentMessageRow[];
};

function buildSenderLabel(senderId: string, senderName?: string): string {
  const name = normalizeStringValue(senderName);
  if (name) {
    return `${name} (${senderId})`;
  }
  return `user:${senderId}`;
}

function toUnixMillis(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  if (parsed > 1e12) {
    return Math.trunc(parsed);
  }
  return Math.trunc(parsed * 1000);
}

function stringifyCompact(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateContextText(value: string, maxChars = 1200): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function buildRecentHistoryBody(row: OpenzaloRecentMessageRow): string | null {
  const payloadParts: string[] = [];
  const content = stringifyCompact(row.content).trim();
  if (content) {
    payloadParts.push(truncateContextText(content));
  }

  const refs: string[] = [];
  const msgId = normalizeStringValue(row.msgId);
  const cliMsgId = normalizeStringValue(row.cliMsgId);
  const msgType = normalizeStringValue(row.msgType);
  if (msgId) refs.push(`msgId:${msgId}`);
  if (cliMsgId) refs.push(`cliMsgId:${cliMsgId}`);
  if (msgType) refs.push(`msgType:${msgType}`);
  if (refs.length > 0) {
    payloadParts.push(`[${refs.join(" ")}]`);
  }

  if (payloadParts.length === 0) {
    return null;
  }
  return payloadParts.join("\n");
}

async function fetchGroupRecentHistory(params: {
  threadId: string;
  profile: string;
  limit: number;
  currentMsgId?: string;
  currentCliMsgId?: string;
  core: OpenzaloCoreRuntime;
  runtime: RuntimeEnv;
}): Promise<OpenzaloContextHistoryEntry[]> {
  const count = Math.min(Math.max(Math.trunc(params.limit), 1), 200);
  const recent = await readRecentMessagesOpenzalo(params.threadId, {
    profile: params.profile,
    isGroup: true,
    count,
  });
  if (!recent.ok) {
    logVerbose(
      params.core,
      params.runtime,
      `openzalo: failed to fetch group recent history for ${params.threadId}: ${recent.error ?? "unknown error"}`,
    );
    return [];
  }

  const payload = (recent.output ?? {}) as OpenzaloRecentMessagesPayload;
  const rows = Array.isArray(payload.messages) ? payload.messages : [];
  if (rows.length === 0) {
    return [];
  }

  const currentMsgId = normalizeStringValue(params.currentMsgId);
  const currentCliMsgId = normalizeStringValue(params.currentCliMsgId);
  const entries: Array<OpenzaloContextHistoryEntry & { sortTs: number }> = [];
  for (const row of rows) {
    const msgId = normalizeStringValue(row.msgId);
    const cliMsgId = normalizeStringValue(row.cliMsgId);
    if ((currentMsgId && msgId === currentMsgId) || (currentCliMsgId && cliMsgId === currentCliMsgId)) {
      continue;
    }

    const senderId = normalizeStringValue(row.senderId) ?? "unknown";
    const senderName = normalizeStringValue(row.senderName);
    const body = buildRecentHistoryBody(row);
    if (!body) {
      continue;
    }

    const ts = toUnixMillis(row.ts);
    entries.push({
      sender: buildSenderLabel(senderId, senderName),
      body,
      timestamp: ts,
      sortTs: ts ?? 0,
    });
  }

  entries.sort((a, b) => a.sortTs - b.sortTs);
  const trimmed =
    entries.length > count
      ? entries.slice(entries.length - count)
      : entries;
  return trimmed.map(({ sortTs: _sortTs, ...entry }) => entry);
}

function resolveOpenzaloHistoryLimit(params: {
  config: OpenClawConfig;
  account: ResolvedOpenzaloAccount;
}): number {
  const local = params.account.config.historyLimit;
  if (typeof local === "number" && Number.isFinite(local)) {
    return Math.max(0, Math.floor(local));
  }
  const global = params.config.messages?.groupChat?.historyLimit;
  if (typeof global === "number" && Number.isFinite(global)) {
    return Math.max(0, Math.floor(global));
  }
  // Auto-preload a recent window to provide baseline group context out of the box.
  // Set historyLimit: 0 in config to disable this behavior.
  return OPENZALO_DEFAULT_GROUP_HISTORY_LIMIT;
}

function shouldExpandGroupHistoryWindow(params: { body: string; hasQuote: boolean }): boolean {
  if (params.hasQuote) {
    return true;
  }
  const trimmed = params.body.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length <= 40) {
    return true;
  }
  const normalized = trimmed.toLowerCase();
  return CONTEXT_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function resolveAdaptiveGroupHistoryLimit(params: {
  baseLimit: number;
  body: string;
  hasQuote: boolean;
}): number {
  const base = Math.min(Math.max(Math.trunc(params.baseLimit), 0), 200);
  if (base === 0) {
    return 0;
  }
  if (!shouldExpandGroupHistoryWindow({ body: params.body, hasQuote: params.hasQuote })) {
    return base;
  }
  const expanded = Math.min(Math.max(base * 3, base + 6), 50);
  return Math.min(Math.max(expanded, 1), 200);
}

async function resolveOpenzcaUserId(
  profile: string,
  runtime: RuntimeEnv,
): Promise<string | undefined> {
  const result = await runOpenzca(["me", "info", "-j"], { profile, timeout: 10000 });
  if (!result.ok) {
    runtime.log?.(`[openzalo] failed to resolve bot user id for profile=${profile}: ${result.stderr}`);
    return undefined;
  }

  const parsed = parseJsonOutput<{ userId?: unknown }>(result.stdout);
  const userId = normalizeMentionUid(parsed?.userId);
  if (!userId) {
    runtime.log?.(`[openzalo] could not parse bot user id from me info for profile=${profile}`);
    return undefined;
  }
  return userId;
}

async function startOpenzcaListener(
  runtime: RuntimeEnv,
  profile: string,
  onMessage: (msg: ZcaMessage) => void,
  onError: (err: Error) => void,
  abortSignal: AbortSignal,
): Promise<ChildProcess> {
  let buffer = "";
  let reportedTermination = false;
  const reportTermination = (err: Error): void => {
    if (reportedTermination) {
      return;
    }
    reportedTermination = true;
    onError(err);
  };

  const { proc, promise } = await runOpenzcaStreaming(["listen", "-r", "-k"], {
    profile,
    onData: (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as ZcaMessage;
          onMessage(parsed);
        } catch {
          // ignore non-JSON lines
        }
      }
    },
    onError: (err) => {
      reportTermination(err);
    },
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const lines = data
      .toString()
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const text of lines) {
      const level = classifyOpenzcaStderr(text);
      if (level === "error") {
        runtime.error(`[openzalo] openzca stderr: ${text}`);
      } else {
        runtime.log?.(
          level === "warn"
            ? `[openzalo][warn] openzca stderr: ${text}`
            : `[openzalo] openzca stderr: ${text}`,
        );
      }

      if (!reportedTermination && shouldRestartOnOpenzcaListenerStderr(text)) {
        reportTermination(new Error(`openzca listener stream closed: ${text}`));
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
        const forceKillTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 5000);
        forceKillTimer.unref?.();
      }
    }
  });

  void promise.then((result) => {
    if (abortSignal.aborted) {
      return;
    }
    const reason = result.stderr?.trim() || `openzca listen exited with code ${result.exitCode}`;
    reportTermination(new Error(reason));
  });

  abortSignal.addEventListener(
    "abort",
    () => {
      proc.kill("SIGTERM");
    },
    { once: true },
  );

  return proc;
}

async function processMessage(
  message: ZcaMessage,
  account: ResolvedOpenzaloAccount,
  config: OpenClawConfig,
  core: OpenzaloCoreRuntime,
  runtime: RuntimeEnv,
  botUserId: string | undefined,
  historyLimit: number,
  statusSink?: (patch: OpenzaloStatusPatch) => void,
  mentionDetectionFailureWarnings?: Set<string>,
  humanPassSessions?: Set<string>,
  recordMetric?: (name: OpenzaloMetricName, delta?: number) => void,
): Promise<void> {
  const { threadId, content, timestamp, metadata } = message;
  const rawBody = normalizeStringValue(content) ?? "";
  const quoteContext = resolveQuoteContext(message);
  const mediaContext = resolveMediaContext(message);
  const hasInboundContext =
    rawBody.length > 0 ||
    quoteContext.hasQuote ||
    Boolean(mediaContext.mediaPath || mediaContext.mediaUrl);
  if (!hasInboundContext) {
    return;
  }

  const isGroup = inferIsGroupMessage(message);
  const senderId = metadata?.fromId ?? metadata?.senderId ?? message.senderId ?? threadId;
  const senderName =
    metadata?.senderName ??
    metadata?.senderDisplayName ??
    message.senderName ??
    message.senderDisplayName ??
    "";
  const groupName = metadata?.threadName ?? "";
  const chatId = threadId;

  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
  const groups = account.config.groups ?? {};
  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, `openzalo: drop group ${chatId} (groupPolicy=disabled)`);
      return;
    }
    if (groupPolicy === "allowlist") {
      const allowed = isGroupAllowed({ groupId: chatId, groupName, groups });
      if (!allowed) {
        logVerbose(core, runtime, `openzalo: drop group ${chatId} (not allowlisted)`);
        return;
      }
    }
  }

  const mentionIds = extractMentionIds(message);
  const normalizedBotUserId = normalizeMentionUid(botUserId);
  const canDetectMentionByUid = Boolean(isGroup && normalizedBotUserId);
  const wasMentionedByUid =
    canDetectMentionByUid && normalizedBotUserId
      ? mentionIds.includes(normalizedBotUserId)
      : false;
  const controlCommandBody = isGroup
    ? resolveControlCommandBody({
        rawBody,
        message,
        botUserId: normalizedBotUserId,
        wasMentionedByUid,
      })
    : rawBody;
  const commandBodyForAuth = controlCommandBody || rawBody;

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(
    commandBodyForAuth,
    config,
  );
  const storeAllowFrom =
    !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
      ? await core.channel.pairing.readAllowFromStore("openzalo").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, effectiveAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(core, runtime, `Blocked openzalo DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;

      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "openzalo",
            id: senderId,
            meta: { name: senderName || undefined },
          });

          if (created) {
            logVerbose(core, runtime, `openzalo pairing request sender=${senderId}`);
            try {
              await sendMessageOpenzalo(
                chatId,
                core.channel.pairing.buildPairingReply({
                  channel: "openzalo",
                  idLine: `Your Zalo user id: ${senderId}`,
                  code,
                }),
                { profile: account.profile },
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                core,
                runtime,
                `openzalo pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized openzalo sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  const peer = isGroup
    ? { kind: "group" as const, id: chatId }
    : { kind: "direct" as const, id: senderId };

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "openzalo",
    accountId: account.accountId,
    peer: {
      // Use "group" kind to avoid dmScope=main collapsing all DMs into the main session.
      kind: peer.kind,
      id: peer.id,
    },
  });

  const humanPassCommand =
    parseHumanPassCommand(controlCommandBody) ?? parseHumanPassCommand(rawBody);
  const isBuiltinControlCommand = core.channel.commands.isControlCommandMessage(
    controlCommandBody || rawBody,
    config,
  );
  const isControlCommand = isBuiltinControlCommand || humanPassCommand !== null;
  const canManageHumanPass = commandAuthorized === true || senderAllowedForCommands;
  const canRunControlCommand =
    commandAuthorized === true || (humanPassCommand !== null && canManageHumanPass);
  const shouldRequireMention = isGroup
      ? core.channel.groups.resolveRequireMention({
          cfg: config,
          channel: "openzalo",
          accountId: account.accountId,
          groupId: chatId,
        })
      : false;
  const shouldBypassMention = isControlCommand && shouldRequireMention && canRunControlCommand;
  const canDetectMention = canDetectMentionByUid;
  const effectiveWasMentioned = shouldBypassMention || wasMentionedByUid;

  const senderLabel = buildSenderLabel(senderId, senderName);
  const fromLabel = senderLabel;
  const normalizedGroupName = normalizeStringValue(groupName);
  const conversationLabel = isGroup
    ? (normalizedGroupName ? `${normalizedGroupName} (${chatId})` : `group:${chatId}`)
    : senderLabel;

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Zalo Personal",
    from: fromLabel,
    timestamp: timestamp ? timestamp * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });
  const combinedBody = body;
  const inboundHistory = undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: controlCommandBody || rawBody,
    From: isGroup ? `openzalo:group:${chatId}` : `openzalo:${senderId}`,
    To: `openzalo:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    GroupSubject: isGroup ? normalizedGroupName : undefined,
    GroupChannel: isGroup ? `group:${chatId}` : undefined,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    Provider: "openzalo",
    Surface: "openzalo",
    MessageSid: message.msgId ?? message.cliMsgId ?? `${timestamp}`,
    MessageSidAlt: message.cliMsgId ?? undefined,
    ReplyToId: quoteContext.replyToId,
    ReplyToIdFull: quoteContext.replyToIdFull,
    ReplyToBody: quoteContext.replyToBody,
    ReplyToSender: quoteContext.replyToSender,
    ReplyToIsQuote: quoteContext.hasQuote ? true : undefined,
    MediaPath: mediaContext.mediaPath,
    MediaPaths: mediaContext.mediaPaths,
    MediaUrl: mediaContext.mediaUrl,
    MediaUrls: mediaContext.mediaUrls,
    MediaType: mediaContext.mediaType,
    MediaTypes: mediaContext.mediaTypes,
    Timestamp: timestamp ? timestamp * 1000 : undefined,
    OriginatingChannel: "openzalo",
    OriginatingTo: `openzalo:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`openzalo: failed updating session meta: ${String(err)}`);
    },
  });

  if (isGroup && isControlCommand && !canRunControlCommand) {
    const commandPreview = commandBodyForAuth.replace(/\s+/g, " ").slice(0, 80);
    logVerbose(
      core,
      runtime,
      `openzalo: drop control command from unauthorized sender ${senderId} command="${commandPreview}" authorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowedForCommands)}`,
    );
    return;
  }

  const humanPassKey = route.sessionKey;
  if (humanPassCommand) {
    if (!canManageHumanPass) {
      logVerbose(core, runtime, `openzalo: human pass command denied for sender ${senderId}`);
      return;
    }

    const enableHumanPass = humanPassCommand === "on";
    if (enableHumanPass) {
      humanPassSessions?.add(humanPassKey);
    } else {
      humanPassSessions?.delete(humanPassKey);
    }

    const statusMessage = enableHumanPass
      ? "Human pass enabled. I will keep reading messages for context and stop replying until you send \"human pass off\"."
      : "Human pass disabled. Bot replies are enabled again.";
    const notice = await sendMessageOpenzalo(chatId, statusMessage, {
      profile: account.profile,
      isGroup,
    });
    if (!notice.ok) {
      runtime.error(
        `openzalo: failed to send human pass status message: ${notice.error || "unknown error"}`,
      );
    }
    return;
  }

  if (humanPassSessions?.has(humanPassKey)) {
    recordMetric?.("humanPassSkips");
    logVerbose(core, runtime, `openzalo: skip reply (human pass enabled): ${chatId}`);
    return;
  }

  if (isGroup && shouldRequireMention) {
    if (shouldBypassMention) {
      logVerbose(core, runtime, `openzalo: bypass mention gating for authorized control command: ${chatId}`);
    } else if (canDetectMention) {
      if (!effectiveWasMentioned) {
        logVerbose(core, runtime, `openzalo: skip group message (mention required): ${chatId}`);
        return;
      }
    } else {
      const mode = account.config.groupMentionDetectionFailure ?? "deny";
      const warningKey = `${account.accountId}:${chatId}:mention-detection:${mode}`;
      if (!mentionDetectionFailureWarnings?.has(warningKey)) {
        if (mode === "allow-with-warning") {
          warnMentionDetectionFailure({
            runtime,
            accountId: account.accountId,
            chatId,
            mode,
          });
          mentionDetectionFailureWarnings?.add(warningKey);
        } else if (mode === "deny") {
          warnMentionDetectionFailure({
            runtime,
            accountId: account.accountId,
            chatId,
            mode,
          });
          mentionDetectionFailureWarnings?.add(warningKey);
          logVerbose(
            core,
            runtime,
            `openzalo: skip group message (mention required, detection unavailable): ${chatId}`,
          );
          return;
        }
      }
    }
  }

  if (isGroup && historyLimit > 0) {
    const recentHistoryLimit = resolveAdaptiveGroupHistoryLimit({
      baseLimit: historyLimit,
      body: rawBody,
      hasQuote: quoteContext.hasQuote,
    });
    if (recentHistoryLimit > historyLimit) {
      logVerbose(
        core,
        runtime,
        `openzalo: expanding group history window ${historyLimit} -> ${recentHistoryLimit} for context-sensitive message in ${chatId}`,
      );
    }
    const recentGroupHistory = await fetchGroupRecentHistory({
      threadId: chatId,
      profile: account.profile,
      limit: recentHistoryLimit,
      currentMsgId: message.msgId,
      currentCliMsgId: message.cliMsgId,
      core,
      runtime,
    });
    if (recentGroupHistory.length > 0) {
      const historyBody = recentGroupHistory
        .map((entry) =>
          core.channel.reply.formatAgentEnvelope({
            channel: "Zalo Personal",
            from: entry.sender,
            timestamp: entry.timestamp,
            envelope: envelopeOptions,
            body: entry.body,
          }),
        )
        .join("\n");
      ctxPayload.Body = `${historyBody}\n${body}`.trim();
      ctxPayload.InboundHistory = recentGroupHistory.map((entry) => ({
        sender: entry.sender,
        body: entry.body,
        timestamp: entry.timestamp,
      }));
    }
  }

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "openzalo",
    accountId: account.accountId,
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "openzalo",
    accountId: account.accountId,
  });
  const shouldSendFailureNotice = account.config.sendFailureNotice !== false;
  const failureNoticeMessage = account.config.sendFailureMessage?.trim()
    ? account.config.sendFailureMessage.trim()
    : OPENZALO_DEFAULT_FAILURE_NOTICE_MESSAGE;

  let hadDispatchError = false;
  let hadTypingError = false;
  let sentReply = false;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      const result = await sendTypingOpenzalo(chatId, { profile: account.profile, isGroup });
      if (!result.ok) {
        throw new Error(result.error || "Failed to send typing indicator");
      }
    },
    onStartError: (err) => {
      hadTypingError = true;
      recordMetric?.("typingFailures");
      logTypingFailure({
        log: (message) => runtime.log?.(`[openzalo] ${message}`),
        channel: "openzalo",
        action: "start",
        target: chatId,
        error: err,
      });
    },
  });
  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(config, route.agentId),
      deliver: async (payload) => {
        const outcome = await deliverOpenzaloReply({
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          profile: account.profile,
          chatId,
          isGroup,
          runtime,
          core,
          config,
          accountId: account.accountId,
          statusSink,
          tableMode,
        });
        if (outcome.sent) {
          sentReply = true;
        }
        if (outcome.failed) {
          hadDispatchError = true;
          recordMetric?.("dispatchFailures");
          if (outcome.textChunkFailures > 0) {
            recordMetric?.("textChunkFailures", outcome.textChunkFailures);
          }
          if (outcome.mediaFailures > 0) {
            recordMetric?.("mediaFailures", outcome.mediaFailures);
          }
        }
      },
      onError: (err, info) => {
        hadDispatchError = true;
        recordMetric?.("dispatchFailures");
        runtime.error?.(`[${account.accountId}] Openzalo ${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart: typingCallbacks.onReplyStart,
      onIdle: typingCallbacks.onIdle,
    });

  try {
    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg: config,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        onModelSelected,
      },
    });
  } catch (err) {
    hadDispatchError = true;
    recordMetric?.("dispatchFailures");
    runtime.error?.(`[${account.accountId}] openzalo dispatch failed: ${String(err)}`);
  } finally {
    markDispatchIdle();
  }

  if ((hadDispatchError || hadTypingError) && !sentReply && shouldSendFailureNotice) {
    const notice = await sendMessageOpenzalo(chatId, failureNoticeMessage, {
      profile: account.profile,
      isGroup,
    });
    if (!notice.ok) {
      recordMetric?.("failureNoticeFailures");
      runtime.error(`openzalo: failed to send failure notice: ${notice.error || "unknown error"}`);
    } else {
      recordMetric?.("failureNoticesSent");
    }
  }
}

async function deliverOpenzaloReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  profile: string;
  chatId: string;
  isGroup: boolean;
  runtime: RuntimeEnv;
  core: OpenzaloCoreRuntime;
  config: OpenClawConfig;
  accountId?: string;
  statusSink?: (patch: OpenzaloStatusPatch) => void;
  tableMode?: MarkdownTableMode;
}): Promise<OpenzaloDispatchOutcome> {
  const { payload, profile, chatId, isGroup, runtime, core, config, accountId, statusSink } =
    params;
  let sent = false;
  let failed = false;
  let textChunkFailures = 0;
  let mediaFailures = 0;
  const tableMode = params.tableMode ?? "code";
  const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
  const configuredTextLimit = core.channel.text.resolveTextChunkLimit(config, "openzalo", accountId, {
    fallbackLimit: OPENZALO_TEXT_LIMIT,
  });
  const textLimit = Math.min(configuredTextLimit, OPENZALO_TEXT_LIMIT);
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg: config,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.openzalo?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.openzalo?.mediaMaxMb,
    accountId,
  });

  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? text : undefined;
      first = false;
      logVerbose(core, runtime, `Sending media to ${chatId}`);
      const result = await sendMessageOpenzalo(chatId, caption ?? "", {
        profile,
        mediaUrl,
        isGroup,
        maxChars: textLimit,
        maxBytes,
      });
      if (result.ok) {
        statusSink?.({ lastOutboundAt: Date.now() });
        sent = true;
      } else {
        failed = true;
        mediaFailures += 1;
        runtime.error(`Openzalo media send failed: ${result.error || "Unknown error"}`);
      }
    }
    return { sent, failed, textChunkFailures, mediaFailures };
  }

  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "openzalo", accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      text,
      textLimit,
      chunkMode,
    );
    logVerbose(core, runtime, `Sending ${chunks.length} text chunk(s) to ${chatId}`);
    for (const chunk of chunks) {
      const result = await sendMessageOpenzalo(chatId, chunk, {
        profile,
        isGroup,
        maxChars: textLimit,
        maxBytes,
      });
      if (result.ok) {
        statusSink?.({ lastOutboundAt: Date.now() });
        sent = true;
      } else {
        failed = true;
        textChunkFailures += 1;
        runtime.error(`Openzalo message send failed: ${result.error || "Unknown error"}`);
      }
    }
  }
  return { sent, failed, textChunkFailures, mediaFailures };
}

export async function monitorOpenzaloProvider(
  options: OpenzaloMonitorOptions,
): Promise<OpenzaloMonitorResult> {
  let { account, config } = options;
  const { abortSignal, statusSink, runtime } = options;

  const core = getOpenzaloRuntime();
  const metrics: OpenzaloMetricCounters = {
    dispatchFailures: 0,
    typingFailures: 0,
    textChunkFailures: 0,
    mediaFailures: 0,
    failureNoticesSent: 0,
    failureNoticeFailures: 0,
    humanPassSkips: 0,
  };
  const recordMetric = (name: OpenzaloMetricName, delta = 1): void => {
    if (delta <= 0) {
      return;
    }
    metrics[name] += delta;
    statusSink?.({ [name]: metrics[name] } as OpenzaloStatusPatch);
  };
  let stopped = false;
  let proc: ChildProcess | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveRunning: (() => void) | null = null;

  try {
    const profile = account.profile;
    const allowFromEntries = (account.config.allowFrom ?? [])
      .map((entry) => normalizeOpenzaloEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");

    if (allowFromEntries.length > 0) {
      const result = await runOpenzca(["friend", "list", "-j"], { profile, timeout: 15000 });
      if (result.ok) {
        const friends = parseJsonOutput<ZcaFriend[]>(result.stdout) ?? [];
        const byName = buildNameIndex(friends, (friend) => friend.displayName);
        const additions: string[] = [];
        const mapping: string[] = [];
        const unresolved: string[] = [];
        for (const entry of allowFromEntries) {
          if (/^\d+$/.test(entry)) {
            additions.push(entry);
            continue;
          }
          const matches = byName.get(entry.toLowerCase()) ?? [];
          const match = matches[0];
          const id = match?.userId ? String(match.userId) : undefined;
          if (id) {
            additions.push(id);
            mapping.push(`${entry}→${id}`);
          } else {
            unresolved.push(entry);
          }
        }
        const allowFrom = mergeAllowlist({ existing: account.config.allowFrom, additions });
        account = {
          ...account,
          config: {
            ...account.config,
            allowFrom,
          },
        };
        summarizeMapping("openzalo users", mapping, unresolved, runtime);
      } else {
        runtime.log?.(`openzalo user resolve failed; using config entries. ${result.stderr}`);
      }
    }

    const groupsConfig = account.config.groups ?? {};
    const groupKeys = Object.keys(groupsConfig).filter((key) => key !== "*");
    if (groupKeys.length > 0) {
      const result = await runOpenzca(["group", "list", "-j"], { profile, timeout: 15000 });
      if (result.ok) {
        const groups = parseJsonOutput<ZcaGroup[]>(result.stdout) ?? [];
        const byName = buildNameIndex(groups, (group) => group.name);
        const mapping: string[] = [];
        const unresolved: string[] = [];
        const nextGroups = { ...groupsConfig };
        for (const entry of groupKeys) {
          const cleaned = normalizeOpenzaloEntry(entry);
          if (/^\d+$/.test(cleaned)) {
            if (!nextGroups[cleaned]) {
              nextGroups[cleaned] = groupsConfig[entry];
            }
            mapping.push(`${entry}→${cleaned}`);
            continue;
          }
          const matches = byName.get(cleaned.toLowerCase()) ?? [];
          const match = matches[0];
          const id = match?.groupId ? String(match.groupId) : undefined;
          if (id) {
            if (!nextGroups[id]) {
              nextGroups[id] = groupsConfig[entry];
            }
            mapping.push(`${entry}→${id}`);
          } else {
            unresolved.push(entry);
          }
        }
        account = {
          ...account,
          config: {
            ...account.config,
            groups: nextGroups,
          },
        };
        summarizeMapping("openzalo groups", mapping, unresolved, runtime);
      } else {
        runtime.log?.(`openzalo group resolve failed; using config entries. ${result.stderr}`);
      }
    }
  } catch (err) {
    runtime.log?.(`openzalo resolve failed; using config entries. ${String(err)}`);
  }

  const mentionDetectionFailureWarnings = new Set<string>();
  const humanPassSessions = new Set<string>();
  const historyLimit = resolveOpenzaloHistoryLimit({ config, account });
  const botUserId = await resolveOpenzcaUserId(account.profile, runtime);
  if (botUserId) {
    logVerbose(core, runtime, `[${account.accountId}] resolved bot user id=${botUserId}`);
  } else {
    logVerbose(
      core,
      runtime,
      `[${account.accountId}] bot user id unavailable; structured mention detection is unavailable`,
    );
  }
  logVerbose(core, runtime, `[${account.accountId}] group recent-history limit=${historyLimit}`);
  const processInboundMessage = async (msg: ZcaMessage): Promise<void> => {
    await processMessage(
      msg,
      account,
      config,
      core,
      runtime,
      botUserId,
      historyLimit,
      statusSink,
      mentionDetectionFailureWarnings,
      humanPassSessions,
      recordMetric,
    );
  };

  const stop = () => {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (proc) {
      proc.kill("SIGTERM");
      proc = null;
    }
    resolveRunning?.();
  };

  const startListener = () => {
    if (stopped || abortSignal.aborted) {
      resolveRunning?.();
      return;
    }

    logVerbose(
      core,
      runtime,
      `[${account.accountId}] starting openzca listener (profile=${account.profile})`,
    );

    void startOpenzcaListener(
      runtime,
      account.profile,
      (msg) => {
        statusSink?.({ lastInboundAt: Date.now() });
        void processInboundMessage(msg).catch((err) => {
          runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
        });
      },
      (err) => {
        if (stopped || abortSignal.aborted) {
          resolveRunning?.();
          return;
        }
        if (proc) {
          try {
            proc.kill("SIGTERM");
          } catch {
            // ignore stale process kill failures
          }
          proc = null;
        }
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
        runtime.error(`[${account.accountId}] openzca listener stopped: ${String(err)}`);
        logVerbose(core, runtime, `[${account.accountId}] restarting listener in 5s...`);
        restartTimer = setTimeout(() => {
          restartTimer = null;
          startListener();
        }, 5000);
      },
      abortSignal,
    )
      .then((listenerProc) => {
        proc = listenerProc;
      })
      .catch((err) => {
        const listenerError = err instanceof Error ? err : new Error(String(err));
        if (stopped || abortSignal.aborted) {
          resolveRunning?.();
          return;
        }
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
        runtime.error(`[${account.accountId}] openzca listener failed to start: ${String(listenerError)}`);
        logVerbose(core, runtime, `[${account.accountId}] restarting listener in 5s...`);
        restartTimer = setTimeout(() => {
          restartTimer = null;
          startListener();
        }, 5000);
      });
  };

  // Create a promise that stays pending until abort or stop
  const runningPromise = new Promise<void>((resolve) => {
    resolveRunning = resolve;
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });

  startListener();

  // Wait for the running promise to resolve (on abort/stop)
  await runningPromise;

  return { stop };
}
