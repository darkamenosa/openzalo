import { formatOpenzaloOutboundTarget, parseOpenzaloTarget } from "./normalize.js";

export type OpenzaloSubagentBindingRecord = {
  accountId: string;
  to: string;
  threadId: string;
  isGroup: boolean;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundAt: number;
  lastTouchedAt: number;
  ttlMs?: number;
  expiresAt?: number;
};

const bindingsByConversation = new Map<string, OpenzaloSubagentBindingRecord>();
const conversationKeysBySession = new Map<string, Set<string>>();

const DEFAULT_ACCOUNT_ID = "default";
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

function canonicalizeAccountId(value: string): string {
  if (VALID_ID_RE.test(value)) {
    return value.toLowerCase();
  }
  return value
    .toLowerCase()
    .replace(INVALID_CHARS_RE, "-")
    .replace(LEADING_DASH_RE, "")
    .replace(TRAILING_DASH_RE, "")
    .slice(0, 64);
}

function normalizeCanonicalAccountId(value: string): string | undefined {
  const canonical = canonicalizeAccountId(value);
  if (!canonical || BLOCKED_OBJECT_KEYS.has(canonical)) {
    return undefined;
  }
  return canonical;
}

function normalizeAccountId(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_ACCOUNT_ID;
  }
  return normalizeCanonicalAccountId(trimmed) || DEFAULT_ACCOUNT_ID;
}

function toConversationKey(params: { accountId: string; to: string }): string {
  return `${params.accountId}:${params.to}`;
}

function resolveTargetFromTo(raw?: string): {
  to: string;
  threadId: string;
  isGroup: boolean;
} | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  try {
    const parsed = parseOpenzaloTarget(value);
    return {
      to: formatOpenzaloOutboundTarget({
        threadId: parsed.threadId,
        isGroup: parsed.isGroup,
      }),
      threadId: parsed.threadId,
      isGroup: parsed.isGroup,
    };
  } catch {
    return null;
  }
}

function isExpired(record: OpenzaloSubagentBindingRecord, at = Date.now()): boolean {
  if (!record.expiresAt || record.expiresAt <= 0) {
    return false;
  }
  return record.expiresAt <= at;
}

function unlinkSessionConversation(params: { sessionKey: string; conversationKey: string }) {
  const entries = conversationKeysBySession.get(params.sessionKey);
  if (!entries) {
    return;
  }
  entries.delete(params.conversationKey);
  if (entries.size === 0) {
    conversationKeysBySession.delete(params.sessionKey);
  }
}

function removeBindingByConversationKey(conversationKey: string): OpenzaloSubagentBindingRecord | null {
  const existing = bindingsByConversation.get(conversationKey);
  if (!existing) {
    return null;
  }
  bindingsByConversation.delete(conversationKey);
  unlinkSessionConversation({
    sessionKey: existing.childSessionKey,
    conversationKey,
  });
  return existing;
}

function setBindingRecord(record: OpenzaloSubagentBindingRecord): OpenzaloSubagentBindingRecord {
  const conversationKey = toConversationKey({
    accountId: record.accountId,
    to: record.to,
  });
  removeBindingByConversationKey(conversationKey);
  bindingsByConversation.set(conversationKey, record);
  const sessionEntries = conversationKeysBySession.get(record.childSessionKey) ?? new Set<string>();
  sessionEntries.add(conversationKey);
  conversationKeysBySession.set(record.childSessionKey, sessionEntries);
  return record;
}

function sweepExpiredBindings(now = Date.now()) {
  for (const [conversationKey, record] of bindingsByConversation.entries()) {
    if (!isExpired(record, now)) {
      continue;
    }
    removeBindingByConversationKey(conversationKey);
  }
}

function cloneRecord(record: OpenzaloSubagentBindingRecord): OpenzaloSubagentBindingRecord {
  return { ...record };
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function restoreBindingRecord(raw: unknown, nowMs: number): OpenzaloSubagentBindingRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const target = resolveTargetFromTo(toOptionalString(source.to));
  if (!target) {
    return null;
  }

  const childSessionKey = toOptionalString(source.childSessionKey);
  const agentId = toOptionalString(source.agentId);
  if (!childSessionKey || !agentId) {
    return null;
  }

  const accountId = normalizeAccountId(toOptionalString(source.accountId));
  const label = toOptionalString(source.label);
  const ttlMs = toPositiveInteger(source.ttlMs);
  const boundAt = toTimestamp(source.boundAt) ?? nowMs;
  const lastTouchedAt = toTimestamp(source.lastTouchedAt) ?? boundAt;
  const expiresAt = toPositiveInteger(source.expiresAt) ?? (ttlMs ? lastTouchedAt + ttlMs : undefined);
  if (expiresAt && expiresAt <= nowMs) {
    return null;
  }

  return {
    accountId,
    to: target.to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    childSessionKey,
    agentId,
    label,
    boundAt,
    lastTouchedAt,
    ttlMs,
    expiresAt,
  };
}

export function bindOpenzaloSubagentSession(params: {
  accountId?: string;
  to: string;
  childSessionKey: string;
  agentId: string;
  label?: string;
  ttlMs?: number;
}): OpenzaloSubagentBindingRecord | null {
  const target = resolveTargetFromTo(params.to);
  if (!target) {
    return null;
  }
  const childSessionKey = params.childSessionKey.trim();
  const agentId = params.agentId.trim();
  if (!childSessionKey || !agentId) {
    return null;
  }
  const accountId = normalizeAccountId(params.accountId);
  const now = Date.now();
  const ttlMs = toPositiveInteger(params.ttlMs);
  const record: OpenzaloSubagentBindingRecord = {
    accountId,
    to: target.to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    childSessionKey,
    agentId,
    label: params.label?.trim() || undefined,
    boundAt: now,
    lastTouchedAt: now,
    ttlMs,
    expiresAt: ttlMs ? now + ttlMs : undefined,
  };
  return cloneRecord(setBindingRecord(record));
}

export function resolveOpenzaloBoundSessionByTarget(params: {
  accountId?: string;
  to: string;
}): OpenzaloSubagentBindingRecord | null {
  sweepExpiredBindings();
  const normalizedTarget = resolveTargetFromTo(params.to);
  if (!normalizedTarget) {
    return null;
  }
  const accountId = normalizeAccountId(params.accountId);
  const conversationKey = toConversationKey({
    accountId,
    to: normalizedTarget.to,
  });
  const record = bindingsByConversation.get(conversationKey);
  if (!record) {
    return null;
  }
  return cloneRecord(record);
}

export function resolveOpenzaloBoundOriginBySession(params: {
  childSessionKey: string;
  accountId?: string;
}): OpenzaloSubagentBindingRecord | null {
  sweepExpiredBindings();
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    return null;
  }
  const conversationKeys = conversationKeysBySession.get(childSessionKey);
  if (!conversationKeys || conversationKeys.size === 0) {
    return null;
  }
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : "";
  const candidates: OpenzaloSubagentBindingRecord[] = [];
  for (const key of conversationKeys) {
    const entry = bindingsByConversation.get(key);
    if (!entry) {
      continue;
    }
    if (accountId && entry.accountId !== accountId) {
      continue;
    }
    candidates.push(entry);
  }
  const selected = candidates[0];
  if (!selected) {
    return null;
  }
  return cloneRecord(selected);
}

export function unbindOpenzaloSubagentSessionByKey(params: {
  childSessionKey: string;
  accountId?: string;
}): OpenzaloSubagentBindingRecord[] {
  sweepExpiredBindings();
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    return [];
  }
  const conversationKeys = conversationKeysBySession.get(childSessionKey);
  if (!conversationKeys || conversationKeys.size === 0) {
    return [];
  }
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : "";
  const removed: OpenzaloSubagentBindingRecord[] = [];
  for (const conversationKey of [...conversationKeys]) {
    const existing = bindingsByConversation.get(conversationKey);
    if (!existing) {
      conversationKeys.delete(conversationKey);
      continue;
    }
    if (accountId && existing.accountId !== accountId) {
      continue;
    }
    const deleted = removeBindingByConversationKey(conversationKey);
    if (deleted) {
      removed.push(cloneRecord(deleted));
    }
  }
  if (conversationKeys.size === 0) {
    conversationKeysBySession.delete(childSessionKey);
  }
  return removed;
}

export function snapshotOpenzaloSubagentBindings(nowMs = Date.now()): OpenzaloSubagentBindingRecord[] {
  sweepExpiredBindings(nowMs);
  return [...bindingsByConversation.values()].map((entry) => cloneRecord(entry));
}

export function replaceOpenzaloSubagentBindings(records: unknown, nowMs = Date.now()): number {
  bindingsByConversation.clear();
  conversationKeysBySession.clear();
  if (!Array.isArray(records)) {
    return 0;
  }
  let count = 0;
  for (const raw of records) {
    const restored = restoreBindingRecord(raw, nowMs);
    if (!restored) {
      continue;
    }
    setBindingRecord(restored);
    count += 1;
  }
  return count;
}

export const __testing = {
  resetOpenzaloSubagentBindingsForTests() {
    bindingsByConversation.clear();
    conversationKeysBySession.clear();
  },
  listBindingsForTests(): OpenzaloSubagentBindingRecord[] {
    return snapshotOpenzaloSubagentBindings();
  },
};
