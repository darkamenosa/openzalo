import { normalizeOpenzaloId } from "./normalize.js";

type NormalizedGroupMember = {
  id: string;
  name?: string;
  displayName?: string;
  zaloName?: string;
  raw?: unknown;
};

const normalizeId = normalizeOpenzaloId;

export function normalizeOpenzaloGroupMembers(payload: unknown): NormalizedGroupMember[] {
  const items = pickGroupMemberItems(payload);
  const members = new Map<string, NormalizedGroupMember>();

  for (const item of items) {
    const id = normalizeGroupMemberId(item);
    if (!id) {
      continue;
    }

    const displayName = readFirstString(item, [
      "displayName",
      "display_name",
      "fullName",
      "full_name",
      "name",
    ]);
    const zaloName = readFirstString(item, [
      "zaloName",
      "zalo_name",
      "username",
    ]);
    const name = displayName || zaloName;

    const existing = members.get(id);
    if (!existing) {
      members.set(id, {
        id,
        ...(name ? { name } : {}),
        ...(displayName ? { displayName } : {}),
        ...(zaloName ? { zaloName } : {}),
        raw: item,
      });
      continue;
    }

    let updated = false;
    if (!existing.displayName && displayName) {
      existing.displayName = displayName;
      updated = true;
    }
    if (!existing.zaloName && zaloName) {
      existing.zaloName = zaloName;
      updated = true;
    }
    if (!existing.name && name) {
      existing.name = name;
      updated = true;
    }
    if (updated) {
      existing.raw = item;
    }
  }

  return Array.from(members.values());
}

function pickGroupMemberItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const arrayCandidates = [
    record.members,
    record.memberList,
    record.member_list,
    record.participants,
    record.users,
    record.items,
    record.data,
  ];
  for (const candidate of arrayCandidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  const objectCandidates = [
    record.members,
    record.memberList,
    record.member_list,
    record.participants,
    record.users,
    record.items,
    record.data,
  ];
  for (const candidate of objectCandidates) {
    if (candidate && typeof candidate === "object") {
      return Object.values(candidate as Record<string, unknown>);
    }
  }

  return [record];
}

function normalizeGroupMemberId(row: unknown): string {
  if (typeof row === "string" || typeof row === "number") {
    return normalizeId(row);
  }
  if (!row || typeof row !== "object") {
    return "";
  }
  const record = row as Record<string, unknown>;
  const nestedUser = getNestedUser(record);
  return normalizeId(
    record.userId ??
      record.user_id ??
      record.memberId ??
      record.member_id ??
      record.uid ??
      record.id ??
      nestedUser?.userId ??
      nestedUser?.user_id ??
      nestedUser?.id,
  );
}

function readFirstString(row: unknown, keys: string[]): string | undefined {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const nestedUser = getNestedUser(record);
  const candidates: unknown[] = [
    ...keys.map((key) => record[key]),
    ...keys.map((key) => nestedUser?.[key]),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const normalized = candidate.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function getNestedUser(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return record.user && typeof record.user === "object" ? (record.user as Record<string, unknown>) : undefined;
}
