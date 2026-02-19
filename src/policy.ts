import {
  normalizeOpenzaloAllowEntry,
  stripOpenzaloPrefix,
} from "./normalize.js";
import type { OpenzaloAccountConfig, OpenzaloGroupConfig } from "./types.js";

export type OpenzaloGroupMatch = {
  allowed: boolean;
  groupConfig?: OpenzaloGroupConfig;
  wildcardConfig?: OpenzaloGroupConfig;
  hasConfiguredGroups: boolean;
};

export type OpenzaloGroupAccessGate = {
  allowed: boolean;
  reason: string;
};

function resolveGroupId(rawTarget: string): string {
  const stripped = stripOpenzaloPrefix(rawTarget).replace(/^thread:/i, "").trim();
  if (!stripped) {
    return "";
  }
  if (/^group:/i.test(stripped)) {
    return stripped.replace(/^group:/i, "").trim();
  }
  if (/^g[:-]/i.test(stripped)) {
    return stripped.replace(/^g[:-]/i, "").trim();
  }
  return stripped;
}

function buildGroupLookupKeys(target: string): string[] {
  const groupId = resolveGroupId(target);
  const candidates = [
    target.trim(),
    stripOpenzaloPrefix(target).trim(),
    groupId,
    groupId ? `group:${groupId}` : "",
    groupId ? `g-${groupId}` : "",
    groupId ? `g:${groupId}` : "",
  ]
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(candidates));
}

function matchesGroupAllowlist(params: {
  groupAllowFrom: string[];
  target: string;
}): boolean {
  const aliases = buildGroupLookupKeys(params.target);
  return aliases.some((alias) => allowlistHasEntry(params.groupAllowFrom, alias));
}

export function resolveOpenzaloGroupMatch(params: {
  groups?: Record<string, OpenzaloGroupConfig>;
  target: string;
}): OpenzaloGroupMatch {
  const groups = params.groups ?? {};
  const hasConfiguredGroups = Object.keys(groups).length > 0;
  const wildcard = groups["*"];

  for (const key of buildGroupLookupKeys(params.target)) {
    const direct = groups[key];
    if (direct) {
      return {
        allowed: true,
        groupConfig: direct,
        wildcardConfig: wildcard,
        hasConfiguredGroups,
      };
    }
  }
  if (wildcard) {
    return {
      allowed: true,
      wildcardConfig: wildcard,
      hasConfiguredGroups,
    };
  }

  return {
    allowed: false,
    hasConfiguredGroups,
  };
}

export function normalizeAllowlist(entries?: Array<string | number>): string[] {
  return (entries ?? [])
    .map((entry) => normalizeOpenzaloAllowEntry(String(entry)))
    .filter(Boolean);
}

export function allowlistHasEntry(allowFrom: string[], value: string): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalized = normalizeOpenzaloAllowEntry(value);
  return allowFrom.includes(normalized);
}

export function resolveOpenzaloGroupAccessGate(params: {
  groupPolicy: OpenzaloAccountConfig["groupPolicy"];
  groupAllowFrom: string[];
  groupMatch: OpenzaloGroupMatch;
  target: string;
}): OpenzaloGroupAccessGate {
  const policy = params.groupPolicy ?? "allowlist";
  if (policy === "disabled") {
    return { allowed: false, reason: "groupPolicy=disabled" };
  }

  if (
    params.groupMatch.groupConfig?.enabled === false ||
    params.groupMatch.wildcardConfig?.enabled === false
  ) {
    return { allowed: false, reason: "group disabled" };
  }

  const targetAllowed =
    params.groupMatch.allowed ||
    matchesGroupAllowlist({
      groupAllowFrom: params.groupAllowFrom,
      target: params.target,
    });

  if (policy === "allowlist") {
    if (!targetAllowed) {
      if (!params.groupMatch.hasConfiguredGroups && params.groupAllowFrom.length === 0) {
        return {
          allowed: false,
          reason: "groupPolicy=allowlist and no groups configured",
        };
      }
      return { allowed: false, reason: "group not allowlisted" };
    }
  }

  return {
    allowed: true,
    reason: policy === "open" ? "open" : "allowlisted",
  };
}

export function resolveOpenzaloRequireMention(params: {
  groupConfig?: OpenzaloGroupConfig;
  wildcardConfig?: OpenzaloGroupConfig;
}): boolean {
  if (params.groupConfig?.requireMention !== undefined) {
    return params.groupConfig.requireMention;
  }
  if (params.wildcardConfig?.requireMention !== undefined) {
    return params.wildcardConfig.requireMention;
  }
  return true;
}

export function resolveOpenzaloGroupSenderAllowed(params: {
  groupPolicy: OpenzaloAccountConfig["groupPolicy"];
  senderId: string;
  groupConfig?: OpenzaloGroupConfig;
  wildcardConfig?: OpenzaloGroupConfig;
}): boolean {
  const sender = normalizeOpenzaloAllowEntry(params.senderId);
  const inner = normalizeAllowlist(
    params.groupConfig?.allowFrom?.length
      ? params.groupConfig.allowFrom
      : params.wildcardConfig?.allowFrom,
  );

  if (inner.length > 0) {
    return inner.includes("*") || inner.includes(sender);
  }

  // If no per-group sender allowlist is configured, do not block by sender.
  return true;
}

function normalizeSenderKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return withoutAt.toLowerCase();
}

export function resolveOpenzaloToolsBySender(params: {
  toolsBySender?: OpenzaloGroupConfig["toolsBySender"];
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}): OpenzaloGroupConfig["tools"] | undefined {
  const toolsBySender = params.toolsBySender;
  if (!toolsBySender) {
    return undefined;
  }
  const entries = Object.entries(toolsBySender);
  if (entries.length === 0) {
    return undefined;
  }

  const normalized = new Map<string, OpenzaloGroupConfig["tools"]>();
  let wildcard: OpenzaloGroupConfig["tools"] | undefined;
  for (const [rawKey, policy] of entries) {
    if (!policy) {
      continue;
    }
    const key = normalizeSenderKey(rawKey);
    if (!key) {
      continue;
    }
    if (key === "*") {
      wildcard = policy;
      continue;
    }
    if (!normalized.has(key)) {
      normalized.set(key, policy);
    }
  }

  const candidates = [
    params.senderId?.trim(),
    params.senderE164?.trim(),
    params.senderUsername?.trim(),
    params.senderName?.trim(),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const key = normalizeSenderKey(candidate);
    if (!key) {
      continue;
    }
    const matched = normalized.get(key);
    if (matched) {
      return matched;
    }
  }

  return wildcard;
}

export function resolveOpenzaloGroupToolPolicy(params: {
  groupConfig?: OpenzaloGroupConfig;
  wildcardConfig?: OpenzaloGroupConfig;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}): OpenzaloGroupConfig["tools"] | undefined {
  const fromGroup = resolveOpenzaloToolsBySender({
    toolsBySender: params.groupConfig?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (fromGroup) {
    return fromGroup;
  }
  if (params.groupConfig?.tools) {
    return params.groupConfig.tools;
  }

  const fromWildcard = resolveOpenzaloToolsBySender({
    toolsBySender: params.wildcardConfig?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (fromWildcard) {
    return fromWildcard;
  }
  return params.wildcardConfig?.tools;
}

export function resolveOpenzaloGroupCommandAuthorizers(params: {
  senderId: string;
  ownerAllowFrom: string[];
  groupConfig?: OpenzaloGroupConfig;
  wildcardConfig?: OpenzaloGroupConfig;
}): {
  owner: { configured: boolean; allowed: boolean };
  group: { configured: boolean; allowed: boolean };
} {
  const normalizedSender = normalizeOpenzaloAllowEntry(params.senderId);
  const groupAllowFrom = normalizeAllowlist(
    params.groupConfig?.allowFrom?.length
      ? params.groupConfig.allowFrom
      : params.wildcardConfig?.allowFrom,
  );

  return {
    owner: {
      configured: params.ownerAllowFrom.length > 0,
      allowed: allowlistHasEntry(params.ownerAllowFrom, normalizedSender),
    },
    group: {
      configured: groupAllowFrom.length > 0,
      allowed: allowlistHasEntry(groupAllowFrom, normalizedSender),
    },
  };
}
