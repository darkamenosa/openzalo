import { parseJsonOutput } from "./json-output.js";
import { normalizeOpenzaloId } from "./normalize.js";

type OpenzaloMessageRef = {
  msgId?: string;
  cliMsgId?: string;
};

export type OpenzaloMessageCacheEntry = {
  accountId: string;
  threadId: string;
  isGroup: boolean;
  msgId?: string;
  cliMsgId?: string;
  shortId: string;
  timestamp: number;
  preview?: string;
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 4000;

const cacheByKey = new Map<string, OpenzaloMessageCacheEntry>();
const cacheByMsgId = new Map<string, string>();
const cacheByCliMsgId = new Map<string, string>();
const cacheByShortId = new Map<string, string>();
const latestByThread = new Map<string, string>();
let shortIdCounter = 0;

const normalizeId = normalizeOpenzaloId;

function makeScopedId(accountId: string, id: string): string {
  return `${accountId}:${id}`;
}

function makeThreadKey(params: { accountId: string; threadId: string; isGroup: boolean }): string {
  return `${params.accountId}:${params.isGroup ? "group" : "dm"}:${params.threadId}`;
}

function pickRefsFromRecord(value: Record<string, unknown>): OpenzaloMessageRef {
  const data = value.data && typeof value.data === "object" ? (value.data as Record<string, unknown>) : null;
  const message =
    value.message && typeof value.message === "object" ? (value.message as Record<string, unknown>) : null;
  const undo = value.undo && typeof value.undo === "object" ? (value.undo as Record<string, unknown>) : null;

  const msgId =
    normalizeId(value.msgId) ||
    normalizeId(value.messageId) ||
    normalizeId(value.globalMsgId) ||
    normalizeId(data?.msgId) ||
    normalizeId(data?.messageId) ||
    normalizeId(message?.msgId) ||
    normalizeId(message?.messageId) ||
    normalizeId(undo?.msgId) ||
    undefined;

  const cliMsgId =
    normalizeId(value.cliMsgId) ||
    normalizeId(data?.cliMsgId) ||
    normalizeId(message?.cliMsgId) ||
    normalizeId(undo?.cliMsgId) ||
    undefined;

  return { msgId, cliMsgId };
}

function pickRefs(value: unknown): OpenzaloMessageRef {
  if (!value) {
    return {};
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") {
        const refs = pickRefsFromRecord(item as Record<string, unknown>);
        if (refs.msgId || refs.cliMsgId) {
          return refs;
        }
      }
    }
    return {};
  }
  if (typeof value !== "object") {
    return {};
  }

  const refs = pickRefsFromRecord(value as Record<string, unknown>);
  if (refs.msgId || refs.cliMsgId) {
    return refs;
  }

  const record = value as Record<string, unknown>;
  const nestedCandidates = [record.result, record.response, record.payload];
  for (const nested of nestedCandidates) {
    const nestedRefs = pickRefs(nested);
    if (nestedRefs.msgId || nestedRefs.cliMsgId) {
      return nestedRefs;
    }
  }

  return {};
}

function pruneExpired(): void {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [key, entry] of cacheByKey) {
    if (entry.timestamp >= cutoff) {
      continue;
    }
    cacheByKey.delete(key);
    if (entry.msgId) {
      cacheByMsgId.delete(makeScopedId(entry.accountId, entry.msgId));
    }
    if (entry.cliMsgId) {
      cacheByCliMsgId.delete(makeScopedId(entry.accountId, entry.cliMsgId));
    }
    cacheByShortId.delete(makeScopedId(entry.accountId, entry.shortId));
  }

  while (cacheByKey.size > CACHE_MAX) {
    const oldestKey = cacheByKey.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    const oldest = cacheByKey.get(oldestKey);
    cacheByKey.delete(oldestKey);
    if (!oldest) {
      continue;
    }
    if (oldest.msgId) {
      cacheByMsgId.delete(makeScopedId(oldest.accountId, oldest.msgId));
    }
    if (oldest.cliMsgId) {
      cacheByCliMsgId.delete(makeScopedId(oldest.accountId, oldest.cliMsgId));
    }
    cacheByShortId.delete(makeScopedId(oldest.accountId, oldest.shortId));
  }
}

function makeCacheKey(params: {
  accountId: string;
  msgId?: string;
  cliMsgId?: string;
  threadId: string;
}): string {
  const msgPart = params.msgId || "_";
  const cliPart = params.cliMsgId || "_";
  return `${params.accountId}:${params.threadId}:${msgPart}:${cliPart}`;
}

function getEntryByCacheKey(cacheKey: string | undefined): OpenzaloMessageCacheEntry | null {
  if (!cacheKey) {
    return null;
  }
  return cacheByKey.get(cacheKey) ?? null;
}

function splitFullId(raw: string): OpenzaloMessageRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null;
  }
  const msgId = trimmed.slice(0, separatorIndex).trim();
  const cliMsgId = trimmed.slice(separatorIndex + 1).trim();
  if (!msgId || !cliMsgId) {
    return null;
  }
  return { msgId, cliMsgId };
}

export function formatOpenzaloMessageSidFull(params: {
  msgId?: string;
  cliMsgId?: string;
  fallback?: string;
}): string {
  const msgId = normalizeId(params.msgId);
  const cliMsgId = normalizeId(params.cliMsgId);
  if (msgId && cliMsgId) {
    return `${msgId}:${cliMsgId}`;
  }
  return msgId || cliMsgId || normalizeId(params.fallback);
}

export function parseOpenzcaMessageRefs(stdout: string): OpenzaloMessageRef {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  const parsed = parseJsonOutput(trimmed);
  const fromJson = pickRefs(parsed);
  if (fromJson.msgId || fromJson.cliMsgId) {
    return fromJson;
  }

  const msgIdMatch =
    trimmed.match(/\bmsgId\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i) ||
    trimmed.match(/\bmessage[_\s]?id\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i) ||
    trimmed.match(/\bglobalMsgId\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i);
  const cliMsgIdMatch = trimmed.match(/\bcliMsgId\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i);
  const msgId = msgIdMatch?.[1];
  const cliMsgId = cliMsgIdMatch?.[1];
  if (msgId || cliMsgId) {
    return { msgId, cliMsgId };
  }

  const firstWord = trimmed.split(/\s+/g)[0];
  if (firstWord && /^[0-9A-Za-z_-]+$/.test(firstWord)) {
    return { msgId: firstWord };
  }
  return {};
}

export function rememberOpenzaloMessage(params: {
  accountId: string;
  threadId: string;
  isGroup: boolean;
  msgId?: string;
  cliMsgId?: string;
  timestamp?: number;
  preview?: string;
}): OpenzaloMessageCacheEntry | null {
  const accountId = params.accountId.trim();
  const threadId = params.threadId.trim();
  const msgId = normalizeId(params.msgId);
  const cliMsgId = normalizeId(params.cliMsgId);
  if (!accountId || !threadId || (!msgId && !cliMsgId)) {
    return null;
  }

  pruneExpired();

  const cacheKey = makeCacheKey({ accountId, threadId, msgId: msgId || undefined, cliMsgId: cliMsgId || undefined });
  const existing = cacheByKey.get(cacheKey);
  const shortId = existing?.shortId || String(++shortIdCounter);
  const timestamp =
    typeof params.timestamp === "number" && Number.isFinite(params.timestamp) && params.timestamp > 0
      ? Math.trunc(params.timestamp)
      : Date.now();
  const preview = params.preview?.trim() || undefined;

  const entry: OpenzaloMessageCacheEntry = {
    accountId,
    threadId,
    isGroup: params.isGroup,
    msgId: msgId || undefined,
    cliMsgId: cliMsgId || undefined,
    shortId,
    timestamp,
    preview,
  };

  cacheByKey.delete(cacheKey);
  cacheByKey.set(cacheKey, entry);
  cacheByShortId.set(makeScopedId(accountId, shortId), cacheKey);
  if (msgId) {
    cacheByMsgId.set(makeScopedId(accountId, msgId), cacheKey);
  }
  if (cliMsgId) {
    cacheByCliMsgId.set(makeScopedId(accountId, cliMsgId), cacheKey);
  }

  latestByThread.set(makeThreadKey({ accountId, threadId, isGroup: params.isGroup }), cacheKey);
  return entry;
}

export function getLatestOpenzaloMessageForThread(params: {
  accountId: string;
  threadId: string;
  isGroup: boolean;
}): OpenzaloMessageCacheEntry | null {
  pruneExpired();
  const threadKey = makeThreadKey({
    accountId: params.accountId.trim(),
    threadId: params.threadId.trim(),
    isGroup: params.isGroup,
  });
  return getEntryByCacheKey(latestByThread.get(threadKey));
}

export function resolveOpenzaloMessageRef(params: {
  accountId: string;
  rawId: string;
}): { msgId?: string; cliMsgId?: string; shortId?: string } {
  pruneExpired();
  const accountId = params.accountId.trim();
  const rawId = params.rawId.trim();
  if (!accountId || !rawId) {
    return {};
  }

  const fromPair = splitFullId(rawId);
  if (fromPair?.msgId || fromPair?.cliMsgId) {
    return fromPair;
  }

  // Keep short ids intentionally small to avoid colliding with real numeric message ids.
  if (/^\d{1,6}$/.test(rawId)) {
    const byShort = getEntryByCacheKey(cacheByShortId.get(makeScopedId(accountId, rawId)));
    if (byShort) {
      return {
        msgId: byShort.msgId,
        cliMsgId: byShort.cliMsgId,
        shortId: byShort.shortId,
      };
    }
  }

  const byMsg = getEntryByCacheKey(cacheByMsgId.get(makeScopedId(accountId, rawId)));
  if (byMsg) {
    return {
      msgId: byMsg.msgId,
      cliMsgId: byMsg.cliMsgId,
      shortId: byMsg.shortId,
    };
  }

  const byCli = getEntryByCacheKey(cacheByCliMsgId.get(makeScopedId(accountId, rawId)));
  if (byCli) {
    return {
      msgId: byCli.msgId,
      cliMsgId: byCli.cliMsgId,
      shortId: byCli.shortId,
    };
  }

  return { msgId: rawId };
}
