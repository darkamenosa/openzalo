import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { OpenzaloAcpBindingRecord } from "./types.js";

const STORE_VERSION = 1;

type PersistedOpenzaloAcpBindings = {
  version: number;
  bindings: OpenzaloAcpBindingRecord[];
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function sanitizeAgentId(agent: string): string {
  const sanitized = agent
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "codex";
}

function buildConversationHash(params: { accountId: string; conversationId: string }): string {
  return createHash("sha256")
    .update(`${params.accountId}:${params.conversationId}`)
    .digest("hex")
    .slice(0, 16);
}

function resolveBindingsPath(stateDir: string): string {
  return path.join(stateDir, "openzalo", "acp-local-bindings.json");
}

function restoreBindingRecord(raw: unknown): OpenzaloAcpBindingRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const accountId = normalizeText(source.accountId);
  const conversationId = normalizeText(source.conversationId);
  const sessionName = normalizeText(source.sessionName);
  const sessionKey = normalizeText(source.sessionKey);
  const agent = normalizeText(source.agent);
  const cwd = normalizeText(source.cwd);
  if (!accountId || !conversationId || !sessionName || !sessionKey || !agent || !cwd) {
    return null;
  }
  const boundAt = normalizeTimestamp(source.boundAt, Date.now());
  const updatedAt = normalizeTimestamp(source.updatedAt, boundAt);
  return {
    accountId,
    conversationId,
    sessionName,
    sessionKey,
    agent,
    cwd,
    boundAt,
    updatedAt,
  };
}

async function readBindings(stateDir: string): Promise<OpenzaloAcpBindingRecord[]> {
  const filePath = resolveBindingsPath(stateDir);
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedOpenzaloAcpBindings | OpenzaloAcpBindingRecord[];
    const bindings = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bindings) ? parsed.bindings : [];
    return bindings
      .map((entry) => restoreBindingRecord(entry))
      .filter((entry): entry is OpenzaloAcpBindingRecord => Boolean(entry));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function writeBindings(stateDir: string, bindings: OpenzaloAcpBindingRecord[]): Promise<void> {
  const filePath = resolveBindingsPath(stateDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const payload: PersistedOpenzaloAcpBindings = {
    version: STORE_VERSION,
    bindings,
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fsp.rename(tmpPath, filePath);
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

export function createOpenzaloAcpBindingRecord(params: {
  accountId: string;
  conversationId: string;
  agent: string;
  cwd: string;
  now?: number;
}): OpenzaloAcpBindingRecord {
  const now = params.now ?? Date.now();
  const hash = buildConversationHash({
    accountId: params.accountId,
    conversationId: params.conversationId,
  });
  const safeAgent = sanitizeAgentId(params.agent);
  return {
    accountId: params.accountId,
    conversationId: params.conversationId,
    sessionName: `openzalo:${params.accountId}:${hash}`,
    sessionKey: `agent:${safeAgent}:openzalo-acp:${hash}`,
    agent: params.agent.trim(),
    cwd: params.cwd.trim(),
    boundAt: now,
    updatedAt: now,
  };
}

export async function listOpenzaloAcpBindings(params: {
  stateDir: string;
}): Promise<OpenzaloAcpBindingRecord[]> {
  return await readBindings(params.stateDir);
}

export async function resolveOpenzaloAcpBinding(params: {
  stateDir: string;
  accountId: string;
  conversationId: string;
}): Promise<OpenzaloAcpBindingRecord | null> {
  const bindings = await readBindings(params.stateDir);
  return (
    bindings.find(
      (entry) =>
        entry.accountId === params.accountId && entry.conversationId === params.conversationId,
    ) ?? null
  );
}

export async function upsertOpenzaloAcpBinding(params: {
  stateDir: string;
  record: OpenzaloAcpBindingRecord;
}): Promise<OpenzaloAcpBindingRecord> {
  const bindings = await readBindings(params.stateDir);
  const next = bindings.filter(
    (entry) =>
      !(
        entry.accountId === params.record.accountId &&
        entry.conversationId === params.record.conversationId
      ),
  );
  next.push(params.record);
  await writeBindings(params.stateDir, next);
  return params.record;
}

export async function removeOpenzaloAcpBinding(params: {
  stateDir: string;
  accountId: string;
  conversationId: string;
}): Promise<OpenzaloAcpBindingRecord | null> {
  const bindings = await readBindings(params.stateDir);
  const removed =
    bindings.find(
      (entry) =>
        entry.accountId === params.accountId && entry.conversationId === params.conversationId,
    ) ?? null;
  if (!removed) {
    return null;
  }
  const next = bindings.filter(
    (entry) =>
      !(
        entry.accountId === params.accountId && entry.conversationId === params.conversationId
      ),
  );
  await writeBindings(params.stateDir, next);
  return removed;
}
