import type { OpenzaloInboundMessage, OpenzcaRawPayload } from "./types.js";

function toId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return typeof value === "string" ? value.trim() : "";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeMentionUid(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function collectMentionIds(params: {
  value: unknown;
  sink: Set<string>;
  depth: number;
}): void {
  if (params.depth > 4 || params.value === undefined || params.value === null) {
    return;
  }

  if (Array.isArray(params.value)) {
    for (const item of params.value) {
      collectMentionIds({
        value: item,
        sink: params.sink,
        depth: params.depth + 1,
      });
    }
    return;
  }

  const scalarId = normalizeMentionUid(params.value);
  if (scalarId) {
    params.sink.add(scalarId);
    return;
  }

  const record = toRecord(params.value);
  if (!record) {
    return;
  }

  const inlineUid = normalizeMentionUid(record.uid ?? record.userId ?? record.user_id ?? record.id);
  if (inlineUid) {
    params.sink.add(inlineUid);
  }

  const nestedKeys = [
    "mentionIds",
    "mentions",
    "mentionInfo",
    "mention_info",
    "mentionList",
    "mention_list",
    "mention",
  ];
  for (const key of nestedKeys) {
    if (!(key in record)) {
      continue;
    }
    collectMentionIds({
      value: record[key],
      sink: params.sink,
      depth: params.depth + 1,
    });
  }
}

function extractMentionIds(params: {
  payload: OpenzcaRawPayload;
  metadata: Record<string, unknown> | null;
}): string[] {
  const sink = new Set<string>();
  const candidates: unknown[] = [
    params.payload.mentionIds,
    params.payload.mentions,
    params.payload.mentionInfo,
    params.payload.mention_info,
    params.payload.mentionList,
    params.payload.mention_list,
    params.payload.mention,
    params.metadata?.mentionIds,
    params.metadata?.mentions,
    params.metadata?.mentionInfo,
    params.metadata?.mention_info,
    params.metadata?.mentionList,
    params.metadata?.mention_list,
    params.metadata?.mention,
  ];

  for (const candidate of candidates) {
    collectMentionIds({ value: candidate, sink, depth: 0 });
  }

  return Array.from(sink);
}

function toEpochMs(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Date.now();
  }
  if (numeric < 10_000_000_000) {
    return Math.floor(numeric * 1000);
  }
  return Math.floor(numeric);
}

function resolveDmPeerId(params: {
  threadId: string;
  senderId: string;
  toId?: string;
  selfId?: string;
}): string {
  const threadId = params.threadId.trim();
  const senderId = params.senderId.trim();
  const toId = (params.toId ?? "").trim();
  const selfId = (params.selfId ?? "").trim();

  if (selfId) {
    if (senderId === selfId && toId && toId !== selfId) {
      return toId;
    }
    if (toId === selfId && senderId && senderId !== selfId) {
      return senderId;
    }
    if (threadId && threadId !== selfId) {
      return threadId;
    }
    if (toId && toId !== selfId) {
      return toId;
    }
    if (senderId && senderId !== selfId) {
      return senderId;
    }
  }

  if (senderId && toId && senderId === threadId && toId !== senderId) {
    return toId;
  }
  if (senderId && toId && toId === threadId && senderId !== toId) {
    return senderId;
  }
  if (threadId) {
    return threadId;
  }
  if (toId && toId !== senderId) {
    return toId;
  }
  return senderId;
}

function summarizeQuoteText(quote: Record<string, unknown>): string | undefined {
  const directText =
    (typeof quote.msg === "string" ? quote.msg.trim() : "") ||
    (typeof quote.text === "string" ? quote.text.trim() : "") ||
    (typeof quote.content === "string" ? quote.content.trim() : "");
  if (directText) {
    return directText;
  }

  const attach = toRecord(quote.attach);
  if (!attach) {
    return undefined;
  }
  const title =
    (typeof attach.title === "string" ? attach.title.trim() : "") ||
    (typeof attach.description === "string" ? attach.description.trim() : "");
  if (title) {
    return title;
  }
  const href = typeof attach.href === "string" ? attach.href.trim() : "";
  return href || undefined;
}

function extractQuoteContext(params: {
  payload: OpenzcaRawPayload;
  metadata: Record<string, unknown> | null;
}): {
  quoteMsgId?: string;
  quoteCliMsgId?: string;
  quoteSender?: string;
  quoteText?: string;
} {
  const quote = toRecord(params.payload.quote) ?? toRecord(params.metadata?.quote);
  if (!quote) {
    return {};
  }

  const quoteMsgId = toId(quote.globalMsgId) || toId(quote.msgId) || toId(quote.realMsgId);
  const quoteCliMsgId = toId(quote.cliMsgId);
  const quoteSender =
    (typeof quote.senderName === "string" ? quote.senderName.trim() : "") ||
    (typeof quote.ownerId === "string" ? quote.ownerId.trim() : "") ||
    (typeof quote.fromId === "string" ? quote.fromId.trim() : "") ||
    undefined;
  const quoteText = summarizeQuoteText(quote);

  return {
    quoteMsgId: quoteMsgId || undefined,
    quoteCliMsgId: quoteCliMsgId || undefined,
    quoteSender,
    quoteText,
  };
}

function isSelfMessage(params: {
  payload: OpenzcaRawPayload;
  metadata: Record<string, unknown> | null;
  senderId: string;
  selfId?: string;
}): boolean {
  if (
    toBoolean(params.payload.fromMe) === true ||
    toBoolean(params.payload.isFromMe) === true ||
    toBoolean(params.metadata?.fromMe) === true ||
    toBoolean(params.metadata?.isFromMe) === true
  ) {
    return true;
  }
  if (params.senderId === "0") {
    return true;
  }
  const normalizedSelfId = (params.selfId ?? "").trim();
  return Boolean(normalizedSelfId) && params.senderId === normalizedSelfId;
}

export function normalizeOpenzcaInboundPayload(
  payload: OpenzcaRawPayload,
  selfId?: string,
): OpenzaloInboundMessage | null {
  if (payload.kind === "lifecycle") {
    return null;
  }

  const metadata =
    payload.metadata && typeof payload.metadata === "object"
      ? (payload.metadata as Record<string, unknown>)
      : null;

  const threadId =
    toId(payload.threadId) ||
    toId(payload.targetId) ||
    toId(payload.conversationId) ||
    toId(metadata?.threadId) ||
    toId(metadata?.targetId);
  const senderId = toId(payload.senderId) || toId(metadata?.senderId) || toId(metadata?.fromId);
  if (!threadId || !senderId) {
    return null;
  }
  if (isSelfMessage({ payload, metadata, senderId, selfId })) {
    return null;
  }
  const toIdValue = toId(payload.toId) || toId(metadata?.toId);

  const chatType =
    typeof payload.chatType === "string"
      ? payload.chatType
      : typeof metadata?.chatType === "string"
        ? metadata.chatType
        : "";
  const isGroup = toBoolean(metadata?.isGroup) ?? chatType.toLowerCase() === "group";

  const mediaPaths = [
    ...toStringArray(payload.mediaPaths),
    ...(typeof payload.mediaPath === "string" ? [payload.mediaPath.trim()] : []),
  ].filter(Boolean);

  const mediaUrls = [
    ...toStringArray(payload.mediaUrls),
    ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl.trim()] : []),
  ].filter(Boolean);

  const mediaTypes = [
    ...toStringArray(payload.mediaTypes),
    ...(typeof payload.mediaType === "string" ? [payload.mediaType.trim()] : []),
  ].filter(Boolean);

  const text = typeof payload.content === "string" ? payload.content : "";
  const msgId = toId(payload.msgId) || toId(metadata?.msgId);
  const cliMsgId = toId(payload.cliMsgId) || toId(metadata?.cliMsgId);
  const messageId = msgId || cliMsgId || `${Date.now()}:${threadId}`;
  const dmPeerId = isGroup
    ? undefined
    : resolveDmPeerId({
        threadId,
        senderId,
        toId: toIdValue,
        selfId,
      });
  const quote = extractQuoteContext({ payload, metadata });
  const mentionIds = extractMentionIds({ payload, metadata });

  return {
    messageId,
    msgId: msgId || undefined,
    cliMsgId: cliMsgId || undefined,
    threadId,
    toId: toIdValue || undefined,
    dmPeerId: dmPeerId || undefined,
    senderId,
    senderName:
      (typeof payload.senderName === "string" ? payload.senderName.trim() : "") ||
      (typeof payload.senderDisplayName === "string" ? payload.senderDisplayName.trim() : "") ||
      (typeof metadata?.senderName === "string" ? metadata.senderName.trim() : "") ||
      undefined,
    text,
    timestamp: toEpochMs(payload.timestamp ?? payload.ts ?? metadata?.timestamp),
    isGroup,
    quoteMsgId: quote.quoteMsgId,
    quoteCliMsgId: quote.quoteCliMsgId,
    quoteSender: quote.quoteSender,
    quoteText: quote.quoteText,
    mentionIds,
    mediaPaths,
    mediaUrls,
    mediaTypes,
    raw: payload,
  };
}
