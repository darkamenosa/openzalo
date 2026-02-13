import type { ChildProcess } from "node:child_process";
import type {
  OpenClawConfig,
  MarkdownTableMode,
  RuntimeEnv,
  HistoryEntry,
} from "openclaw/plugin-sdk";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createReplyPrefixOptions,
  createTypingCallbacks,
  DEFAULT_GROUP_HISTORY_LIMIT,
  logTypingFailure,
  mergeAllowlist,
  recordPendingHistoryEntryIfEnabled,
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
import { sendMessageOpenzalo, sendTypingOpenzalo } from "./send.js";
import { parseJsonOutput, runOpenzca, runOpenzcaStreaming } from "./openzca.js";
import {
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

function buildPendingHistoryEntry(params: {
  senderName: string;
  rawBody: string;
  quoteContext: ResolvedOpenzaloQuoteContext;
  mediaContext: ResolvedOpenzaloMediaContext;
  timestamp?: number;
  messageId?: string;
}): HistoryEntry | null {
  const bodyParts: string[] = [];
  if (params.rawBody) {
    bodyParts.push(params.rawBody);
  }

  if (!params.rawBody && params.quoteContext.replyToBody) {
    bodyParts.push(`[quote] ${params.quoteContext.replyToBody}`);
  }

  const mediaType = params.mediaContext.mediaType ?? params.mediaContext.mediaTypes?.[0];
  const mediaKind = resolveMediaKind(mediaType);
  const hasMediaRef = Boolean(params.mediaContext.mediaPath || params.mediaContext.mediaUrl);
  if (hasMediaRef || mediaKind) {
    const mediaTokens = [`<media:${mediaKind ?? "attachment"}>`];
    if (params.mediaContext.mediaPath) {
      mediaTokens.push(`path:${params.mediaContext.mediaPath}`);
    }
    if (params.mediaContext.mediaUrl) {
      mediaTokens.push(`url:${params.mediaContext.mediaUrl}`);
    }
    bodyParts.push(mediaTokens.join(" "));
  }

  const body = bodyParts.join("\n").trim();
  if (!body) {
    return null;
  }

  return {
    sender: params.senderName.trim() || "unknown",
    body,
    timestamp: typeof params.timestamp === "number" ? params.timestamp * 1000 : undefined,
    messageId: params.messageId,
  };
}

function resolveOpenzaloHistoryLimit(params: {
  config: OpenClawConfig;
  account: ResolvedOpenzaloAccount;
}): number {
  const configured =
    params.account.config.historyLimit ?? params.config.messages?.groupChat?.historyLimit;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(0, Math.floor(configured));
  }
  return DEFAULT_GROUP_HISTORY_LIMIT;
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
    const text = data.toString().trim();
    if (!text) {
      return;
    }

    const level = classifyOpenzcaStderr(text);
    if (level === "error") {
      runtime.error(`[openzalo] openzca stderr: ${text}`);
      return;
    }
    runtime.log?.(
      level === "warn" ? `[openzalo][warn] openzca stderr: ${text}` : `[openzalo] openzca stderr: ${text}`,
    );
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
  groupHistories: Map<string, HistoryEntry[]>,
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

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
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

  const humanPassCommand = parseHumanPassCommand(rawBody);
  const isBuiltinControlCommand = core.channel.commands.isControlCommandMessage(rawBody, config);
  const isControlCommand = isBuiltinControlCommand || humanPassCommand !== null;
  const canManageHumanPass = commandAuthorized === true || senderAllowedForCommands;
  const canRunControlCommand =
    commandAuthorized === true || (humanPassCommand !== null && canManageHumanPass);

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

  const mentionIds = extractMentionIds(message);
  const normalizedBotUserId = normalizeMentionUid(botUserId);
  const canDetectMentionByUid = Boolean(isGroup && normalizedBotUserId);
  const wasMentionedByUid =
    canDetectMentionByUid && normalizedBotUserId
      ? mentionIds.includes(normalizedBotUserId)
      : false;
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

  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
  const historyKey = isGroup ? route.sessionKey : undefined;
  const pendingHistoryEntry =
    isGroup && historyKey
      ? buildPendingHistoryEntry({
          senderName: senderName || fromLabel,
          rawBody,
          quoteContext,
          mediaContext,
          timestamp,
          messageId: message.msgId ?? message.cliMsgId,
        })
      : null;
  const recordPendingGroupHistory = (): void => {
    if (!historyKey) {
      return;
    }
    recordPendingHistoryEntryIfEnabled({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      entry: pendingHistoryEntry,
    });
  };

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
  let combinedBody = body;
  if (isGroup && historyKey) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        core.channel.reply.formatAgentEnvelope({
          channel: "Zalo Personal",
          from: fromLabel,
          timestamp: entry.timestamp,
          envelope: envelopeOptions,
          body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
        }),
    });
  }
  const inboundHistory =
    isGroup && historyKey && historyLimit > 0
      ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `openzalo:group:${chatId}` : `openzalo:${senderId}`,
    To: `openzalo:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    Provider: "openzalo",
    Surface: "openzalo",
    MessageSid: message.msgId ?? message.cliMsgId ?? `${timestamp}`,
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
    logVerbose(
      core,
      runtime,
      `openzalo: drop control command from unauthorized sender ${senderId}`,
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
    if (isGroup) {
      recordPendingGroupHistory();
    }
    recordMetric?.("humanPassSkips");
    logVerbose(core, runtime, `openzalo: skip reply (human pass enabled): ${chatId}`);
    return;
  }

  if (isGroup && shouldRequireMention) {
    if (canDetectMention) {
      if (!effectiveWasMentioned) {
        recordPendingGroupHistory();
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
          recordPendingGroupHistory();
          return;
        }
      }
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

  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
    });
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
  const groupHistories = new Map<string, HistoryEntry[]>();
  const historyLimit = resolveOpenzaloHistoryLimit({ config, account });
  const groupConversationLanes = new Map<string, Promise<void>>();
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
  logVerbose(core, runtime, `[${account.accountId}] group history limit=${historyLimit}`);
  const processInboundMessage = async (msg: ZcaMessage): Promise<void> => {
    await processMessage(
      msg,
      account,
      config,
      core,
      runtime,
      botUserId,
      groupHistories,
      historyLimit,
      statusSink,
      mentionDetectionFailureWarnings,
      humanPassSessions,
      recordMetric,
    );
  };

  const enqueueGroupMessage = (msg: ZcaMessage): void => {
    const threadId = normalizeStringValue(msg.threadId) ?? "unknown";
    const laneKey = `${account.accountId}:${threadId}`;
    const hasPending = groupConversationLanes.has(laneKey);
    if (hasPending) {
      logVerbose(core, runtime, `[${account.accountId}] queue inbound lane=${laneKey}`);
    }
    const previous = groupConversationLanes.get(laneKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        logVerbose(core, runtime, `[${account.accountId}] inbound message lane=${laneKey}`);
        await processInboundMessage(msg);
      })
      .catch((err) => {
        runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
      })
      .finally(() => {
        if (groupConversationLanes.get(laneKey) === next) {
          groupConversationLanes.delete(laneKey);
        }
      });
    groupConversationLanes.set(laneKey, next);
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
    groupConversationLanes.clear();
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
        if (inferIsGroupMessage(msg)) {
          enqueueGroupMessage(msg);
          return;
        }
        void processInboundMessage(msg).catch((err) => {
          runtime.error(`[${account.accountId}] Failed to process DM message: ${String(err)}`);
        });
      },
      (err) => {
        if (stopped || abortSignal.aborted) {
          resolveRunning?.();
          return;
        }
        runtime.error(`[${account.accountId}] openzca listener stopped: ${String(err)}`);
        logVerbose(core, runtime, `[${account.accountId}] restarting listener in 5s...`);
        restartTimer = setTimeout(startListener, 5000);
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
        runtime.error(`[${account.accountId}] openzca listener failed to start: ${String(listenerError)}`);
        logVerbose(core, runtime, `[${account.accountId}] restarting listener in 5s...`);
        restartTimer = setTimeout(startListener, 5000);
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
