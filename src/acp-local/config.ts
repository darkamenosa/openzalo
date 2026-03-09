import type { CoreConfig } from "../types.js";
import {
  type OpenzaloAcpxNonInteractivePermissions,
  type OpenzaloAcpxPermissionMode,
  type ResolvedOpenzaloAcpxConfig,
} from "./types.js";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeTimeoutSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function normalizePermissionMode(value: unknown): OpenzaloAcpxPermissionMode | undefined {
  return value === "approve-all" || value === "approve-reads" || value === "deny-all"
    ? value
    : undefined;
}

function normalizeNonInteractivePermissions(
  value: unknown,
): OpenzaloAcpxNonInteractivePermissions | undefined {
  return value === "deny" || value === "fail" ? value : undefined;
}

export function resolveOpenzaloAcpxConfig(params: {
  cfg: CoreConfig;
  accountId: string;
}): ResolvedOpenzaloAcpxConfig {
  const rootConfig = params.cfg.channels?.openzalo?.acpx;
  const accountConfig = params.cfg.channels?.openzalo?.accounts?.[params.accountId]?.acpx;

  return {
    enabled: accountConfig?.enabled ?? rootConfig?.enabled ?? true,
    command:
      normalizeText(accountConfig?.command) ??
      normalizeText(rootConfig?.command) ??
      normalizeText(process.env.OPENZALO_ACPX_COMMAND) ??
      "acpx",
    agent:
      normalizeText(accountConfig?.agent) ??
      normalizeText(rootConfig?.agent) ??
      normalizeText(process.env.OPENZALO_ACPX_AGENT) ??
      "codex",
    cwd:
      normalizeText(accountConfig?.cwd) ??
      normalizeText(rootConfig?.cwd) ??
      normalizeText(process.env.OPENZALO_ACPX_CWD) ??
      process.cwd(),
    timeoutSeconds:
      normalizeTimeoutSeconds(accountConfig?.timeoutSeconds) ??
      normalizeTimeoutSeconds(rootConfig?.timeoutSeconds),
    permissionMode:
      normalizePermissionMode(accountConfig?.permissionMode) ??
      normalizePermissionMode(rootConfig?.permissionMode) ??
      "approve-all",
    nonInteractivePermissions:
      normalizeNonInteractivePermissions(accountConfig?.nonInteractivePermissions) ??
      normalizeNonInteractivePermissions(rootConfig?.nonInteractivePermissions) ??
      "fail",
  };
}
