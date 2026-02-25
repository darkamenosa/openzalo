import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveOpenzaloAccount } from "./accounts.js";
import {
  bindOpenzaloSubagentSession,
  type OpenzaloSubagentBindingRecord,
  replaceOpenzaloSubagentBindings,
  resolveOpenzaloBoundOriginBySession,
  snapshotOpenzaloSubagentBindings,
  unbindOpenzaloSubagentSessionByKey,
} from "./subagent-bindings.js";
import type { CoreConfig } from "./types.js";

const DEFAULT_THREAD_BINDING_TTL_HOURS = 24;
const BINDINGS_STORE_VERSION = 1;

type FileLockOptions = {
  retries: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
    randomize?: boolean;
  };
  stale: number;
};

const STORE_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 8,
    factor: 1.5,
    minTimeout: 10,
    maxTimeout: 400,
    randomize: true,
  },
  stale: 30_000,
};

type PersistedOpenzaloSubagentBindings = {
  version: number;
  bindings: OpenzaloSubagentBindingRecord[];
};

function computeLockDelayMs(retries: FileLockOptions["retries"], attempt: number): number {
  const base = Math.min(
    retries.maxTimeout,
    Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt),
  );
  const jitter = retries.randomize ? 1 + Math.random() : 1;
  return Math.min(retries.maxTimeout, Math.round(base * jitter));
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const raw = await fsp.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { createdAt?: string };
    if (parsed.createdAt) {
      const createdAt = Date.parse(parsed.createdAt);
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) {
        return true;
      }
    }
  } catch {
    // Fall back to mtime check below.
  }
  try {
    const stat = await fsp.stat(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

async function withStoreFileLock<T>(
  filePath: string,
  options: FileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const normalizedPath = path.resolve(filePath);
  const lockPath = `${normalizedPath}.lock`;
  await fsp.mkdir(path.dirname(normalizedPath), { recursive: true });
  const attempts = Math.max(1, options.retries.retries + 1);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => undefined);
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        throw err;
      }
      if (await isStaleLock(lockPath, options.stale)) {
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (attempt >= attempts - 1) {
        break;
      }
      await sleep(computeLockDelayMs(options.retries, attempt));
    }
  }

  throw new Error(`file lock timeout for ${normalizedPath}`);
}

async function writeJsonFileAtomically(filePath: string, payload: unknown): Promise<void> {
  const normalizedPath = path.resolve(filePath);
  await fsp.mkdir(path.dirname(normalizedPath), { recursive: true });
  const tmpPath =
    `${normalizedPath}.${process.pid}.${Date.now()}.` +
    `${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fsp.rename(tmpPath, normalizedPath);
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function resolveThreadBindingTtlMs(ttlHours?: number): number | undefined {
  if (typeof ttlHours !== "number" || !Number.isFinite(ttlHours) || ttlHours <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(ttlHours * 60 * 60 * 1000));
}

function resolveBindingsStorePath(api: OpenClawPluginApi): string {
  const stateDir = api.runtime.state.resolveStateDir(process.env);
  return path.join(stateDir, "openzalo", "subagent-bindings.json");
}

function loadBindingsFromDiskSync(api: OpenClawPluginApi, storePath: string): void {
  const logger = api.runtime.logging.getChildLogger({ plugin: "openzalo", scope: "subagent-hooks" });
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedOpenzaloSubagentBindings | OpenzaloSubagentBindingRecord[];
    const bindings = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.bindings)
        ? parsed.bindings
        : [];
    replaceOpenzaloSubagentBindings(bindings);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      replaceOpenzaloSubagentBindings([]);
      return;
    }
    logger.warn(`openzalo subagent bindings restore failed: ${summarizeError(err)}`);
    replaceOpenzaloSubagentBindings([]);
  }
}

async function persistBindingsToDisk(api: OpenClawPluginApi, storePath: string): Promise<void> {
  const logger = api.runtime.logging.getChildLogger({ plugin: "openzalo", scope: "subagent-hooks" });
  try {
    await withStoreFileLock(storePath, STORE_LOCK_OPTIONS, async () => {
      const payload: PersistedOpenzaloSubagentBindings = {
        version: BINDINGS_STORE_VERSION,
        bindings: snapshotOpenzaloSubagentBindings(),
      };
      await writeJsonFileAtomically(storePath, payload);
    });
  } catch (err) {
    logger.warn(`openzalo subagent bindings persist failed: ${summarizeError(err)}`);
  }
}

export function registerOpenzaloSubagentHooks(api: OpenClawPluginApi) {
  const storePath = resolveBindingsStorePath(api);
  loadBindingsFromDiskSync(api, storePath);
  let persistQueue: Promise<void> = Promise.resolve();
  const persistBindings = async () => {
    // Serialize writes so each persist observes a stable in-memory snapshot.
    persistQueue = persistQueue.catch(() => undefined).then(() => persistBindingsToDisk(api, storePath));
    await persistQueue;
  };

  const resolveThreadBindingFlags = (accountId?: string) => {
    const cfg = api.config as CoreConfig;
    const account = resolveOpenzaloAccount({
      cfg,
      accountId,
    });
    const baseThreadBindings = cfg.channels?.openzalo?.threadBindings;
    const accountThreadBindings = cfg.channels?.openzalo?.accounts?.[account.accountId]?.threadBindings;
    const ttlHoursRaw =
      accountThreadBindings?.ttlHours ??
      baseThreadBindings?.ttlHours ??
      cfg.session?.threadBindings?.ttlHours ??
      DEFAULT_THREAD_BINDING_TTL_HOURS;
    const ttlHours =
      typeof ttlHoursRaw === "number" && Number.isFinite(ttlHoursRaw)
        ? Math.max(0, ttlHoursRaw)
        : DEFAULT_THREAD_BINDING_TTL_HOURS;
    return {
      enabled:
        accountThreadBindings?.enabled ??
        baseThreadBindings?.enabled ??
        cfg.session?.threadBindings?.enabled ??
        true,
      spawnSubagentSessions:
        accountThreadBindings?.spawnSubagentSessions ??
        baseThreadBindings?.spawnSubagentSessions ??
        true,
      ttlHours,
    };
  };

  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel = event.requester?.channel?.trim().toLowerCase();
    if (channel !== "openzalo") {
      // Ignore non-OpenZalo channels so each channel plugin can own its thread/session behavior.
      return;
    }

    const threadBindingFlags = resolveThreadBindingFlags(event.requester?.accountId);
    if (!threadBindingFlags.enabled) {
      return {
        status: "error" as const,
        error:
          "OpenZalo thread bindings are disabled (set channels.openzalo.threadBindings.enabled=true or session.threadBindings.enabled=true).",
      };
    }
    if (!threadBindingFlags.spawnSubagentSessions) {
      return {
        status: "error" as const,
        error:
          "OpenZalo thread-bound subagent spawns are disabled (set channels.openzalo.threadBindings.spawnSubagentSessions=true).",
      };
    }

    try {
      const requesterTo = event.requester?.to?.trim();
      if (!requesterTo) {
        return {
          status: "error" as const,
          error: "OpenZalo thread bind failed: requester target is missing.",
        };
      }
      const binding = bindOpenzaloSubagentSession({
        accountId: event.requester?.accountId,
        to: requesterTo,
        childSessionKey: event.childSessionKey,
        agentId: event.agentId,
        label: event.label,
        ttlMs: resolveThreadBindingTtlMs(threadBindingFlags.ttlHours),
      });
      if (!binding) {
        return {
          status: "error" as const,
          error:
            "Unable to bind this OpenZalo conversation for thread=true (invalid requester target context).",
        };
      }
      await persistBindings();
      return { status: "ok" as const, threadBindingReady: true };
    } catch (err) {
      return {
        status: "error" as const,
        error: `OpenZalo thread bind failed: ${summarizeError(err)}`,
      };
    }
  });

  api.on("subagent_ended", async (event) => {
    if (event.targetKind !== "subagent") {
      return;
    }
    const removed = unbindOpenzaloSubagentSessionByKey({
      childSessionKey: event.targetSessionKey,
      accountId: event.accountId,
    });
    if (removed.length > 0) {
      await persistBindings();
    }
  });

  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== "openzalo") {
      return;
    }
    const binding = resolveOpenzaloBoundOriginBySession({
      childSessionKey: event.childSessionKey,
      accountId: event.requesterOrigin?.accountId,
    });
    if (!binding) {
      return;
    }
    return {
      origin: {
        channel: "openzalo",
        accountId: binding.accountId,
        to: binding.to,
        threadId: binding.threadId,
      },
    };
  });
}
