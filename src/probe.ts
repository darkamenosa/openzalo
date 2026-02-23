import { runOpenzcaCommand } from "./openzca.js";
import type { OpenzaloProbe, ResolvedOpenzaloAccount } from "./types.js";

const PROBE_CACHE_TTL_MS = 15_000;
const MAX_PROBE_CACHE_SIZE = 64;

type ProbeCacheEntry = {
  probe: OpenzaloProbe;
  expiresAt: number;
};

const probeCache = new Map<string, ProbeCacheEntry>();

function toErrorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

function buildProbeCacheKey(account: ResolvedOpenzaloAccount): string {
  return [account.accountId.trim(), account.profile.trim(), account.zcaBinary.trim()].join("|");
}

function readCachedProbe(key: string, now: number): OpenzaloProbe | null {
  const cached = probeCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= now) {
    probeCache.delete(key);
    return null;
  }
  return cached.probe;
}

function writeCachedProbe(key: string, probe: OpenzaloProbe, now: number, ttlMs: number): void {
  probeCache.set(key, {
    probe,
    expiresAt: now + ttlMs,
  });
  if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
    const oldest = probeCache.keys().next().value;
    if (oldest) {
      probeCache.delete(oldest);
    }
  }
}

export function clearOpenzaloProbeCache(): void {
  probeCache.clear();
}

export async function probeOpenzaloAuth(params: {
  account: ResolvedOpenzaloAccount;
  timeoutMs?: number;
  forceRefresh?: boolean;
  cacheTtlMs?: number;
  deps?: {
    now?: () => number;
    runCommand?: typeof runOpenzcaCommand;
  };
}): Promise<OpenzaloProbe> {
  const { account, timeoutMs, forceRefresh, cacheTtlMs, deps } = params;
  const now = deps?.now ?? Date.now;
  const runCommand = deps?.runCommand ?? runOpenzcaCommand;
  const ttlMs = Math.max(0, cacheTtlMs ?? PROBE_CACHE_TTL_MS);
  const base: OpenzaloProbe = {
    ok: false,
    profile: account.profile,
    binary: account.zcaBinary,
  };
  const cacheKey = buildProbeCacheKey(account);
  if (!forceRefresh && ttlMs > 0) {
    const cached = readCachedProbe(cacheKey, now());
    if (cached) {
      return cached;
    }
  }

  try {
    await runCommand({
      binary: account.zcaBinary,
      profile: account.profile,
      args: ["auth", "status"],
      timeoutMs: timeoutMs ?? 8_000,
    });
    const probe: OpenzaloProbe = {
      ...base,
      ok: true,
    };
    if (ttlMs > 0) {
      writeCachedProbe(cacheKey, probe, now(), ttlMs);
    }
    return probe;
  } catch (err) {
    const probe: OpenzaloProbe = {
      ...base,
      error: toErrorText(err),
    };
    if (ttlMs > 0) {
      writeCachedProbe(cacheKey, probe, now(), ttlMs);
    }
    return probe;
  }
}
