import type { ChannelAccountSnapshot, ChannelStatusIssue } from "openclaw/plugin-sdk";

type OpenzaloAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  dmPolicy?: unknown;
  groupPolicy?: unknown;
  groupRequireMention?: unknown;
  groupMentionDetectionFailure?: unknown;
  sendFailureNotice?: unknown;
  groupCount?: unknown;
  hasWildcardGroupRule?: unknown;
  groupAllowFromWildcardCount?: unknown;
  lastError?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function readOpenzaloAccountStatus(value: ChannelAccountSnapshot): OpenzaloAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  return {
    accountId: raw.accountId,
    enabled: raw.enabled,
    configured: raw.configured,
    dmPolicy: raw.dmPolicy,
    groupPolicy: raw.groupPolicy,
    groupRequireMention: raw.groupRequireMention,
    groupMentionDetectionFailure: raw.groupMentionDetectionFailure,
    sendFailureNotice: raw.sendFailureNotice,
    groupCount: raw.groupCount,
    hasWildcardGroupRule: raw.hasWildcardGroupRule,
    groupAllowFromWildcardCount: raw.groupAllowFromWildcardCount,
    lastError: raw.lastError,
  };
}

function isMissingOpenzca(lastError?: string): boolean {
  if (!lastError) {
    return false;
  }
  const lower = lastError.toLowerCase();
  return lower.includes("openzca");
}

function isMissingBinaryDependency(lastError?: string): boolean {
  if (!lastError) {
    return false;
  }
  const lower = lastError.toLowerCase();
  return (lower.includes("not found") || lower.includes("enoent")) && isMissingOpenzca(lower);
}

export function collectOpenzaloStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readOpenzaloAccountStatus(entry);
    if (!account) {
      continue;
    }
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) {
      continue;
    }

    const configured = account.configured === true;
    const lastError = asString(account.lastError)?.trim();

    if (!configured) {
      if (isMissingBinaryDependency(lastError)) {
        issues.push({
          channel: "openzalo",
          accountId,
          kind: "runtime",
          message: "openzca CLI not found in PATH.",
          fix: "Install openzca and ensure it is on PATH for the Gateway process.",
        });
      } else {
        issues.push({
          channel: "openzalo",
          accountId,
          kind: "auth",
          message: "Not authenticated (no openzca session).",
          fix: "Run: openclaw channels login --channel openzalo",
        });
      }
      continue;
    }

    if (account.dmPolicy === "open") {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "config",
        message:
          'Zalo Personal dmPolicy is "open", allowing any user to message the bot without pairing.',
        fix: 'Set channels.openzalo.dmPolicy to "pairing" or "allowlist" to restrict access.',
      });
    }

    const groupPolicy = asString(account.groupPolicy) ?? "allowlist";
    const groupRequireMention = asBoolean(account.groupRequireMention) ?? true;
    const mentionDetectionFailureMode = asString(account.groupMentionDetectionFailure) ?? "deny";
    const groupCount = asNumber(account.groupCount) ?? 0;
    const hasWildcardGroupRule = asBoolean(account.hasWildcardGroupRule) === true;
    const groupAllowFromWildcardCount = asNumber(account.groupAllowFromWildcardCount) ?? 0;

    if (groupPolicy === "open" && !groupRequireMention) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "config",
        message:
          'Zalo Personal groupPolicy is "open" and groupRequireMention is disabled; group chats can trigger very broadly.',
        fix: 'Set channels.openzalo.groupRequireMention to true, or set channels.openzalo.groupPolicy to "allowlist".',
      });
    }

    if (groupPolicy === "open" && groupCount === 0 && !hasWildcardGroupRule) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "config",
        message:
          'Zalo Personal groupPolicy is "open" with no group allowlist, so any group can trigger when mention policy allows it.',
        fix: 'Set channels.openzalo.groupPolicy to "allowlist" and configure channels.openzalo.groups.',
      });
    }

    if (groupPolicy === "allowlist" && groupCount === 0) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "config",
        message:
          'Zalo Personal groupPolicy is "allowlist" but no groups are configured, so all group messages are blocked.',
        fix: "Add entries under channels.openzalo.groups.",
      });
    }
    if (groupAllowFromWildcardCount > 0) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "config",
        message:
          `Found ${groupAllowFromWildcardCount} group rule(s) where allowFrom contains "*"; ` +
          "this allows any member in those groups to run /… commands and control directives.",
        fix: 'Remove "*" from channels.openzalo.groups.<id>.allowFrom and use explicit sender IDs.',
      });
    }

    if (groupRequireMention && mentionDetectionFailureMode === "deny") {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "config",
        message:
          'groupRequireMention is enabled and groupMentionDetectionFailure is "deny"; if mention detection is unavailable at runtime, group replies are blocked.',
        fix: 'Set channels.openzalo.groupMentionDetectionFailure to "allow-with-warning" to keep group replies available during detection fallback.',
      });
    }

    if (asBoolean(account.sendFailureNotice) === false) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "config",
        message:
          "sendFailureNotice is disabled; reply/send failures may appear as silent bot drops to end users.",
        fix: "Set channels.openzalo.sendFailureNotice to true.",
      });
    }
  }
  return issues;
}
