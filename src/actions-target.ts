import { normalizeResolvedGroupTarget } from "./resolver-target.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveListGroupMembersFallbackTarget(
  params: Record<string, unknown>,
  fallbackTarget?: string,
): string | undefined {
  const explicitGroup =
    readString(params.groupId) ??
    readString(params.group_id) ??
    readString(params.threadId) ??
    readString(params.thread_id);

  if (explicitGroup) {
    const normalized = normalizeResolvedGroupTarget(explicitGroup);
    if (normalized) {
      return normalized;
    }
  }

  return fallbackTarget;
}

