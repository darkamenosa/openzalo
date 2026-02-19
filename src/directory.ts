import { runOpenzcaJson } from "./openzca.js";
import type { ResolvedOpenzaloAccount } from "./types.js";

type MeInfo = {
  userId?: string | number;
  displayName?: string;
};

type FriendRow = {
  userId?: string | number;
  displayName?: string;
  username?: string;
  phone?: string;
};

type GroupRow = {
  groupId?: string | number;
  name?: string;
  totalMember?: number;
  type?: string;
};

const toId = (value: unknown): string => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return typeof value === "string" ? value.trim() : "";
};

export async function listOpenzaloDirectorySelf(params: {
  account: ResolvedOpenzaloAccount;
}): Promise<{ kind: "user"; id: string; name?: string; raw?: unknown } | null> {
  const { account } = params;
  const me = await runOpenzcaJson<MeInfo>({
    binary: account.zcaBinary,
    profile: account.profile,
    args: ["me", "info", "--json"],
    timeoutMs: 10_000,
  });

  const id = toId(me?.userId);
  if (!id) {
    return null;
  }

  return {
    kind: "user",
    id,
    name: me?.displayName?.trim() || undefined,
    raw: me,
  };
}

export async function listOpenzaloDirectoryPeers(params: {
  account: ResolvedOpenzaloAccount;
  query?: string;
  limit?: number;
}): Promise<Array<{ kind: "user"; id: string; name?: string; raw?: unknown }>> {
  const { account, query, limit } = params;
  const rows = await runOpenzcaJson<FriendRow[]>({
    binary: account.zcaBinary,
    profile: account.profile,
    args: ["friend", "list", "--json"],
    timeoutMs: 20_000,
  });

  const q = query?.trim().toLowerCase() ?? "";
  const max = typeof limit === "number" && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const out: Array<{ kind: "user"; id: string; name?: string; raw?: unknown }> = [];

  for (const row of rows ?? []) {
    const id = toId(row?.userId);
    if (!id) {
      continue;
    }
    const name = row?.displayName?.trim() || row?.username?.trim() || undefined;
    const haystack = [id, name, row?.phone].filter(Boolean).join(" ").toLowerCase();
    if (q && !haystack.includes(q)) {
      continue;
    }
    out.push({
      kind: "user",
      id,
      name,
      raw: row,
    });
    if (out.length >= max) {
      break;
    }
  }

  return out;
}

export async function listOpenzaloDirectoryGroups(params: {
  account: ResolvedOpenzaloAccount;
  query?: string;
  limit?: number;
}): Promise<Array<{ kind: "group"; id: string; name?: string; raw?: unknown }>> {
  const { account, query, limit } = params;
  const rows = await runOpenzcaJson<GroupRow[]>({
    binary: account.zcaBinary,
    profile: account.profile,
    args: ["group", "list", "--json"],
    timeoutMs: 20_000,
  });

  const q = query?.trim().toLowerCase() ?? "";
  const max = typeof limit === "number" && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const out: Array<{ kind: "group"; id: string; name?: string; raw?: unknown }> = [];

  for (const row of rows ?? []) {
    const id = toId(row?.groupId);
    if (!id) {
      continue;
    }
    const name = row?.name?.trim() || undefined;
    const haystack = [id, name].filter(Boolean).join(" ").toLowerCase();
    if (q && !haystack.includes(q)) {
      continue;
    }
    out.push({
      kind: "group",
      id,
      name,
      raw: row,
    });
    if (out.length >= max) {
      break;
    }
  }

  return out;
}
