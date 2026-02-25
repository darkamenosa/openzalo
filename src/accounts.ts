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
  const configuredDefault = cfg.channels?.openzalo?.defaultAccount?.trim();
  if (configuredDefault) {
    return configuredDefault;
  }
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

function hasExplicitAccountConfig(config: OpenzaloAccountConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  if (config.profile?.trim()) {
    return true;
  }
  if (config.zcaBinary?.trim()) {
    return true;
  }
  if (config.dmPolicy) {
    return true;
  }
  if (Array.isArray(config.allowFrom) && config.allowFrom.length > 0) {
    return true;
  }
  if (config.groupPolicy) {
    return true;
  }
  if (Array.isArray(config.groupAllowFrom) && config.groupAllowFrom.length > 0) {
    return true;
  }
  if (config.groups && Object.keys(config.groups).length > 0) {
    return true;
  }
  if (typeof config.historyLimit === "number") {
    return true;
  }
  if (typeof config.dmHistoryLimit === "number") {
    return true;
  }
  if (typeof config.textChunkLimit === "number") {
    return true;
  }
  if (config.chunkMode) {
    return true;
  }
  if (typeof config.blockStreaming === "boolean") {
    return true;
  }
  if (typeof config.mediaMaxMb === "number") {
    return true;
  }
  if (Array.isArray(config.mediaLocalRoots) && config.mediaLocalRoots.length > 0) {
    return true;
  }
  if (typeof config.sendTypingIndicators === "boolean") {
    return true;
  }
  if (config.threadBindings && Object.keys(config.threadBindings).length > 0) {
    return true;
  }
  if (config.actions && Object.keys(config.actions).length > 0) {
    return true;
  }
  if (config.dms && Object.keys(config.dms).length > 0) {
    return true;
  }
  return false;
}

function mergeOpenzaloAccountConfig(cfg: CoreConfig, accountId: string): OpenzaloAccountConfig {
  const base = (cfg.channels?.openzalo ?? {}) as OpenzaloAccountConfig & {
    defaultAccount?: string;
    accounts?: unknown;
  };
  const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...rest } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...rest, ...account };
}

export function resolveOpenzaloAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedOpenzaloAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.openzalo?.enabled;
  const baseConfig = (params.cfg.channels?.openzalo ?? {}) as OpenzaloAccountConfig & {
    defaultAccount?: string;
    accounts?: unknown;
  };
  const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...topLevelConfig } =
    baseConfig;
  const accountConfig = resolveAccountConfig(params.cfg, accountId);
  const merged = mergeOpenzaloAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const profile = merged.profile?.trim() || accountId;
  const zcaBinary = merged.zcaBinary?.trim() || process.env.OPENZCA_BINARY?.trim() || "openzca";
  const configured =
    hasExplicitAccountConfig(topLevelConfig) || hasExplicitAccountConfig(accountConfig);

  return {
    accountId,
    enabled: baseEnabled !== false && accountEnabled,
    name: merged.name?.trim() || undefined,
    profile,
    zcaBinary,
    configured,
    config: merged,
  };
}

export function listEnabledOpenzaloAccounts(cfg: CoreConfig): ResolvedOpenzaloAccount[] {
  return listOpenzaloAccountIds(cfg)
    .map((accountId) => resolveOpenzaloAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
