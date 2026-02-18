import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { ResolvedOpenzaloAccount, OpenzaloAccountConfig, OpenzaloConfig } from "./types.js";
import { runOpenzca, parseJsonOutput, resolveOpenzcaProfileEnv } from "./openzca.js";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels?.openzalo as OpenzaloConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listOpenzaloAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultOpenzaloAccountId(cfg: OpenClawConfig): string {
  const openzaloConfig = cfg.channels?.openzalo as OpenzaloConfig | undefined;
  if (openzaloConfig?.defaultAccount?.trim()) {
    return openzaloConfig.defaultAccount.trim();
  }
  const ids = listOpenzaloAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): OpenzaloAccountConfig | undefined {
  const accounts = (cfg.channels?.openzalo as OpenzaloConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as OpenzaloAccountConfig | undefined;
}

function mergeOpenzaloAccountConfig(cfg: OpenClawConfig, accountId: string): OpenzaloAccountConfig {
  const raw = (cfg.channels?.openzalo ?? {}) as OpenzaloConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveZcaProfile(config: OpenzaloAccountConfig, accountId: string): string {
  if (config.profile?.trim()) {
    return config.profile.trim();
  }
  const profileFromEnv = resolveOpenzcaProfileEnv();
  if (profileFromEnv) {
    return profileFromEnv;
  }
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return accountId;
  }
  return "default";
}

export async function checkZcaAuthenticated(profile: string): Promise<boolean> {
  const result = await runOpenzca(["auth", "status"], { profile, timeout: 5000 });
  return result.ok;
}

export function resolveOpenzaloAccountSync(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedOpenzaloAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled =
    (params.cfg.channels?.openzalo as OpenzaloConfig | undefined)?.enabled !== false;
  const merged = mergeOpenzaloAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const profile = resolveZcaProfile(merged, accountId);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    profile,
    authenticated: false, // unknown without async check
    config: merged,
  };
}

export async function getZcaUserInfo(
  profile: string,
): Promise<{ userId?: string; displayName?: string } | null> {
  const result = await runOpenzca(["me", "info", "-j"], { profile, timeout: 10000 });
  if (!result.ok) {
    return null;
  }
  return parseJsonOutput<{ userId?: string; displayName?: string }>(result.stdout);
}

export type { ResolvedOpenzaloAccount } from "./types.js";
