import type { ChannelAccountSnapshot, ChannelAccountState, ChannelStatusIssue } from "openclaw/plugin-sdk";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readProbeFailure(value: unknown): { failed: boolean; error?: string } {
  if (!value || typeof value !== "object") {
    return { failed: false };
  }
  const probe = value as { ok?: unknown; error?: unknown };
  if (probe.ok !== false) {
    return { failed: false };
  }
  return {
    failed: true,
    error: asString(probe.error ?? null) ?? undefined,
  };
}

export function resolveOpenzaloAccountState(params: {
  enabled: boolean;
  configured: boolean;
}): ChannelAccountState {
  if (!params.enabled) {
    return "disabled";
  }
  if (!params.configured) {
    return "not configured";
  }
  return "configured";
}

export function collectOpenzaloStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];

  for (const account of accounts) {
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) {
      continue;
    }

    const configured = account.configured === true;
    if (!configured) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "config",
        message: "Not configured (missing OpenZalo account settings).",
        fix: "Set channels.openzalo profile/settings and run: openclaw channels login --channel openzalo",
      });
      continue;
    }

    const probeFailure = readProbeFailure(account.probe);
    if (probeFailure.failed) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "runtime",
        message: probeFailure.error
          ? `openzca auth check failed: ${probeFailure.error}`
          : "openzca auth check failed",
        fix: "Verify openzca login/profile on the gateway host.",
      });
    }

    const running = account.running === true;
    const connected =
      account.connected === false ? false : account.connected === true ? true : null;
    const reconnectAttempts = asNumber(account.reconnectAttempts);
    const lastError = asString(account.lastError);
    if (running && connected === false) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "runtime",
        message:
          `openzca disconnected${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}` +
          `${lastError ? `: ${lastError}` : "."}`,
        fix: "Check openzca auth/profile health on the gateway host and inspect gateway logs.",
      });
      continue;
    }

    if (lastError) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "runtime",
        message: `Channel error: ${lastError}`,
      });
    }
  }

  return issues;
}
