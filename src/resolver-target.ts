import { normalizeOpenzaloMessagingTarget, stripOpenzaloPrefix } from "./normalize.js";

export function normalizeResolvedUserTarget(input: string): string {
  const normalized = normalizeOpenzaloMessagingTarget(input);
  if (!normalized) {
    return "";
  }
  if (/^group:/i.test(normalized)) {
    return "";
  }
  return normalized.replace(/^(dm|user):/i, "").trim();
}

export function normalizeResolvedGroupTarget(input: string): string {
  const stripped = stripOpenzaloPrefix(input).replace(/^thread:/i, "").trim();
  if (!stripped) {
    return "";
  }
  if (/^(dm|user|u):/i.test(stripped) || /^u-/i.test(stripped)) {
    return "";
  }

  const normalized = normalizeOpenzaloMessagingTarget(stripped);
  if (!normalized) {
    return "";
  }
  if (/^group:/i.test(normalized)) {
    const groupId = normalized.replace(/^group:/i, "").trim();
    return groupId ? `group:${groupId}` : "";
  }
  if (/^(dm|user):/i.test(normalized)) {
    return "";
  }
  const groupId = normalized.trim();
  if (!groupId) {
    return "";
  }
  return `group:${groupId}`;
}
