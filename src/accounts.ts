import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, OpenzaloAccountConfig, ResolvedOpenzaloAccount } from "./types.js";

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.openzalo?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listOpenzaloAccountIds(cfg: CoreConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultOpenzaloAccountId(cfg: CoreConfig): string {
  const ids = listOpenzaloAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: CoreConfig, accountId: string): OpenzaloAccountConfig | undefined {
  const accounts = cfg.channels?.openzalo?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as OpenzaloAccountConfig | undefined;
}

function mergeOpenzaloAccountConfig(cfg: CoreConfig, accountId: string): OpenzaloAccountConfig {
  const base = (cfg.channels?.openzalo ?? {}) as OpenzaloAccountConfig & {
    accounts?: unknown;
  };
  const { accounts: _ignored, ...rest } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const chunkMode = account.chunkMode ?? rest.chunkMode ?? "length";
  return { ...rest, ...account, chunkMode };
}

export function resolveOpenzaloAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedOpenzaloAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.openzalo?.enabled;
  const merged = mergeOpenzaloAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const profile = merged.profile?.trim() || accountId;
  const zcaBinary = merged.zcaBinary?.trim() || process.env.OPENZCA_BINARY?.trim() || "openzca";

  return {
    accountId,
    enabled: baseEnabled !== false && accountEnabled,
    name: merged.name?.trim() || undefined,
    profile,
    zcaBinary,
    configured: Boolean(profile),
    config: merged,
  };
}

export function listEnabledOpenzaloAccounts(cfg: CoreConfig): ResolvedOpenzaloAccount[] {
  return listOpenzaloAccountIds(cfg)
    .map((accountId) => resolveOpenzaloAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
