import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readStringParam,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionName,
} from "openclaw/plugin-sdk";
import { listEnabledOpenzaloAccounts, resolveOpenzaloAccount } from "./accounts.js";
import {
  getLatestOpenzaloMessageForThread,
  resolveOpenzaloMessageRef,
} from "./message-refs.js";
import { normalizeOpenzaloId, parseOpenzaloTarget } from "./normalize.js";
import { runOpenzcaCommand, runOpenzcaJson } from "./openzca.js";
import type { CoreConfig, ResolvedOpenzaloAccount } from "./types.js";

const SUPPORTED_ACTIONS = new Set<ChannelMessageActionName>([
  "react",
  "read",
  "edit",
  "unsend",
  "renameGroup",
  "addParticipant",
  "removeParticipant",
  "leaveGroup",
  "pin",
  "unpin",
  "list-pins",
  "member-info",
]);

type OpenzcaRecentRow = {
  msgId?: unknown;
  cliMsgId?: unknown;
  threadId?: unknown;
  senderId?: unknown;
  [key: string]: unknown;
};

type OpenzcaRecentResult = {
  threadId?: unknown;
  threadType?: unknown;
  count?: unknown;
  messages?: OpenzcaRecentRow[];
};

const normalizeId = normalizeOpenzaloId;

function resolveActionTarget(
  params: Record<string, unknown>,
  required = true,
  fallbackTarget?: string,
) {
  const to = readStringParam(params, "to") ?? fallbackTarget?.trim() ?? "";
  if (!to) {
    if (required) {
      throw new Error("OpenZalo action requires target (to=...).");
    }
    return null;
  }
  return parseOpenzaloTarget(to);
}

function requireActionTarget(params: Record<string, unknown>, fallbackTarget?: string) {
  const target = resolveActionTarget(params, true, fallbackTarget);
  if (!target) {
    throw new Error("OpenZalo action requires target (to=...).");
  }
  return target;
}

function readCliMessageId(params: Record<string, unknown>): string {
  return (
    readStringParam(params, "cliMsgId") ??
    readStringParam(params, "cliMessageId") ??
    readStringParam(params, "clientMessageId") ??
    ""
  );
}

function readMessageId(params: Record<string, unknown>): string {
  return (
    readStringParam(params, "messageId") ??
    readStringParam(params, "msgId") ??
    readStringParam(params, "messageSid") ??
    readStringParam(params, "messageSidFull") ??
    ""
  );
}

function resolveGroupTarget(params: Record<string, unknown>, fallbackTarget?: string) {
  const target = requireActionTarget(params, fallbackTarget);
  if (!target.isGroup) {
    throw new Error("Group action requires a group target: use to=group:<groupId>.");
  }
  return target;
}

function readIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeId(item)).filter(Boolean);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return [String(Math.trunc(value))];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.includes(",")) {
      return trimmed
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return [trimmed];
  }
  return [];
}

function readParticipantIds(params: Record<string, unknown>): string[] {
  const candidates = [
    ...readIdList(params.userIds),
    ...readIdList(params.users),
    ...readIdList(params.participants),
    ...readIdList(params.participant),
    ...readIdList(params.userId),
    ...readIdList(params.address),
  ];
  const deduped = new Set<string>();
  for (const item of candidates) {
    const normalized = normalizeId(item);
    if (normalized) {
      deduped.add(normalized);
    }
  }
  return Array.from(deduped);
}

function extractRecentRows(payload: unknown): OpenzcaRecentRow[] {
  if (Array.isArray(payload)) {
    return payload.filter((item) => Boolean(item && typeof item === "object")) as OpenzcaRecentRow[];
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const result = payload as OpenzcaRecentResult;
  if (!Array.isArray(result.messages)) {
    return [];
  }
  return result.messages.filter((item) => Boolean(item && typeof item === "object"));
}

function normalizePinnedThreadIds(payload: unknown): string[] {
  const out = new Set<string>();
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          const id = item.trim();
          if (id) {
            out.add(id);
          }
          continue;
        }
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const id = normalizeId(
            record.threadId ?? record.thread_id ?? record.id ?? record.conversationId ?? record.conversation_id,
          );
          if (id) {
            out.add(id);
          }
        }
      }
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      collect(record.conversations);
      collect(record.items);
    }
  };
  collect(payload);
  return Array.from(out);
}

async function readRecentRows(params: {
  account: ResolvedOpenzaloAccount;
  target: { threadId: string; isGroup: boolean };
}): Promise<OpenzcaRecentRow[]> {
  const args = ["msg", "recent", params.target.threadId, "--json", "-n", "80"];
  if (params.target.isGroup) {
    args.push("--group");
  }

  const recent = await runOpenzcaJson<unknown>({
    binary: params.account.zcaBinary,
    profile: params.account.profile,
    args,
    timeoutMs: 25_000,
  });
  return extractRecentRows(recent);
}

async function resolveMessageRefsFromRecent(params: {
  account: ResolvedOpenzaloAccount;
  target: { threadId: string; isGroup: boolean };
  messageId?: string;
  cliMessageId?: string;
}): Promise<{ msgId?: string; cliMsgId?: string }> {
  const wantedMsgId = normalizeId(params.messageId);
  const wantedCliMsgId = normalizeId(params.cliMessageId);
  const rows = await readRecentRows({
    account: params.account,
    target: params.target,
  });

  for (const row of rows) {
    const rowMsgId = normalizeId(row.msgId);
    const rowCliMsgId = normalizeId(row.cliMsgId);
    if (!rowMsgId && !rowCliMsgId) {
      continue;
    }
    const msgMatches =
      wantedMsgId && (rowMsgId === wantedMsgId || rowCliMsgId === wantedMsgId);
    const cliMatches =
      wantedCliMsgId && (rowCliMsgId === wantedCliMsgId || rowMsgId === wantedCliMsgId);
    if (msgMatches || cliMatches) {
      return {
        msgId: rowMsgId || undefined,
        cliMsgId: rowCliMsgId || undefined,
      };
    }
  }

  if (!wantedMsgId && !wantedCliMsgId) {
    for (const row of rows) {
      const rowMsgId = normalizeId(row.msgId);
      const rowCliMsgId = normalizeId(row.cliMsgId);
      if (!rowMsgId || !rowCliMsgId) {
        continue;
      }

      // DM fallback: skip peer-authored messages when we can infer peer id from target.
      if (!params.target.isGroup) {
        const rowSenderId = normalizeId(row.senderId);
        if (rowSenderId && rowSenderId === params.target.threadId) {
          continue;
        }
      }
      return {
        msgId: rowMsgId,
        cliMsgId: rowCliMsgId,
      };
    }
  }

  return {};
}

async function resolveActionMessageRefs(params: {
  account: ResolvedOpenzaloAccount;
  target: { threadId: string; isGroup: boolean };
  messageId?: string;
  cliMessageId?: string;
  allowLatestFromCache?: boolean;
}): Promise<{ msgId: string; cliMsgId: string } | null> {
  let msgId = "";
  let cliMsgId = normalizeId(params.cliMessageId);
  const rawMessageId = normalizeId(params.messageId);

  if (rawMessageId) {
    const resolved = resolveOpenzaloMessageRef({
      accountId: params.account.accountId,
      rawId: rawMessageId,
    });
    msgId = normalizeId(resolved.msgId);
    if (!cliMsgId) {
      cliMsgId = normalizeId(resolved.cliMsgId);
    }
  }

  if (!msgId && !cliMsgId && params.allowLatestFromCache) {
    const latest = getLatestOpenzaloMessageForThread({
      accountId: params.account.accountId,
      threadId: params.target.threadId,
      isGroup: params.target.isGroup,
    });
    if (latest) {
      msgId = normalizeId(latest.msgId);
      cliMsgId = normalizeId(latest.cliMsgId);
    }
  }

  if (msgId && cliMsgId) {
    return { msgId, cliMsgId };
  }

  const fromRecent = await resolveMessageRefsFromRecent({
    account: params.account,
    target: params.target,
    messageId: msgId || rawMessageId || undefined,
    cliMessageId: cliMsgId || undefined,
  });
  if (!msgId) {
    msgId = normalizeId(fromRecent.msgId);
  }
  if (!cliMsgId) {
    cliMsgId = normalizeId(fromRecent.cliMsgId);
  }

  if (msgId && cliMsgId) {
    return { msgId, cliMsgId };
  }
  return null;
}

export const openzaloMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledOpenzaloAccounts(cfg as CoreConfig).filter((account) => account.configured);
    if (accounts.length === 0) {
      return [];
    }
    const actions = new Set<ChannelMessageActionName>([]);

    for (const account of accounts) {
      const gate = createActionGate(account.config.actions ?? {});
      if (gate("reactions")) {
        actions.add("react");
      }
      if (gate("messages")) {
        actions.add("read");
        actions.add("edit");
        actions.add("unsend");
      }
      if (gate("groups")) {
        actions.add("renameGroup");
        actions.add("addParticipant");
        actions.add("removeParticipant");
        actions.add("leaveGroup");
      }
      if (gate("pins")) {
        actions.add("pin");
        actions.add("unpin");
        actions.add("list-pins");
      }
      if (gate("memberInfo")) {
        actions.add("member-info");
      }
    }

    return Array.from(actions);
  },
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    const account = resolveOpenzaloAccount({ cfg: cfg as CoreConfig, accountId });
    const contextTarget =
      typeof toolContext?.currentChannelId === "string" ? toolContext.currentChannelId.trim() : "";

    if (action === "react") {
      const target = requireActionTarget(params, contextTarget);
      const refs = await resolveActionMessageRefs({
        account,
        target,
        messageId: readMessageId(params),
        cliMessageId: readCliMessageId(params),
        allowLatestFromCache: true,
      });
      if (!refs) {
        throw new Error(
          "OpenZalo react could not resolve message references. " +
            "Pass messageId/cliMsgId, use [message_id:N] from context, or run action=read first.",
        );
      }
      const remove = typeof params.remove === "boolean" ? params.remove : false;
      if (remove) {
        throw new Error("OpenZalo remove reaction is not supported by openzca msg react.");
      }
      const emoji =
        readStringParam(params, "emoji") ??
        readStringParam(params, "reaction", { required: true });

      const args = ["msg", "react", refs.msgId, refs.cliMsgId, target.threadId, emoji];
      if (target.isGroup) {
        args.push("--group");
      }

      await runOpenzcaCommand({
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 15_000,
      });
      return jsonResult({ ok: true, reacted: emoji, msgId: refs.msgId, cliMsgId: refs.cliMsgId });
    }

    if (action === "read") {
      const target = requireActionTarget(params, contextTarget);
      const limit = readNumberParam(params, "limit", { integer: true });
      const args = ["msg", "recent", target.threadId, "--json"];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
        args.push("-n", String(limit));
      }
      if (target.isGroup) {
        args.push("--group");
      }

      const payload = await runOpenzcaJson<unknown>({
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 20_000,
      });
      const rows = extractRecentRows(payload);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const objectPayload = payload as Record<string, unknown>;
        return jsonResult({
          ok: true,
          ...objectPayload,
          messages: rows.length > 0 ? rows : objectPayload.messages,
        });
      }
      return jsonResult({ ok: true, count: rows.length, messages: rows });
    }

    if (action === "edit") {
      const target = requireActionTarget(params, contextTarget);
      const refs = await resolveActionMessageRefs({
        account,
        target,
        messageId: readMessageId(params),
        cliMessageId: readCliMessageId(params),
        allowLatestFromCache: true,
      });
      if (!refs) {
        throw new Error(
          "OpenZalo edit could not resolve message references. " +
            "Pass messageId/cliMsgId, use [message_id:N] from context, or run action=read first.",
        );
      }
      const message =
        readStringParam(params, "message", { allowEmpty: true }) ??
        readStringParam(params, "text", { required: true, allowEmpty: true });

      const args = ["msg", "edit", refs.msgId, refs.cliMsgId, target.threadId, message];
      if (target.isGroup) {
        args.push("--group");
      }

      await runOpenzcaCommand({
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 20_000,
      });
      return jsonResult({ ok: true, edited: refs.msgId, cliMsgId: refs.cliMsgId });
    }

    if (action === "unsend") {
      const target = requireActionTarget(params, contextTarget);
      const refs = await resolveActionMessageRefs({
        account,
        target,
        messageId: readMessageId(params),
        cliMessageId: readCliMessageId(params),
        allowLatestFromCache: true,
      });
      if (!refs) {
        throw new Error(
          "OpenZalo unsend could not resolve message references. " +
            "Pass messageId/cliMsgId, use [message_id:N] from context, or run action=read first.",
        );
      }

      const args = ["msg", "undo", refs.msgId, refs.cliMsgId, target.threadId];
      if (target.isGroup) {
        args.push("--group");
      }

      await runOpenzcaCommand({
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 20_000,
      });
      return jsonResult({ ok: true, unsent: refs.msgId, cliMsgId: refs.cliMsgId });
    }

    if (action === "renameGroup") {
      const target = resolveGroupTarget(params, contextTarget);
      const displayName =
        readStringParam(params, "displayName") ??
        readStringParam(params, "name", { required: true });
      await runOpenzcaCommand({
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["group", "rename", target.threadId, displayName],
        timeoutMs: 20_000,
      });
      return jsonResult({ ok: true, groupId: target.threadId, displayName });
    }

    if (action === "addParticipant" || action === "removeParticipant") {
      const target = resolveGroupTarget(params, contextTarget);
      const participantIds = readParticipantIds(params);
      if (participantIds.length === 0) {
        throw new Error(
          `OpenZalo ${action} requires at least one participant id (participant, participantIds, or userId).`,
        );
      }
      await runOpenzcaCommand({
        binary: account.zcaBinary,
        profile: account.profile,
        args: [
          "group",
          action === "addParticipant" ? "add" : "remove",
          target.threadId,
          ...participantIds,
        ],
        timeoutMs: 30_000,
      });
      return jsonResult({
        ok: true,
        action,
        groupId: target.threadId,
        participants: participantIds,
      });
    }

    if (action === "leaveGroup") {
      const target = resolveGroupTarget(params, contextTarget);
      await runOpenzcaCommand({
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["group", "leave", target.threadId],
        timeoutMs: 20_000,
      });
      return jsonResult({ ok: true, left: target.threadId });
    }

    if (action === "pin" || action === "unpin") {
      const target = requireActionTarget(params, contextTarget);
      const args = ["msg", action === "pin" ? "pin" : "unpin", target.threadId];
      if (target.isGroup) {
        args.push("--group");
      }

      await runOpenzcaCommand({
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 20_000,
      });
      return jsonResult({ ok: true, action, threadId: target.threadId });
    }

    if (action === "list-pins") {
      const target = resolveActionTarget(params, false, contextTarget);
      const payload = await runOpenzcaJson<unknown>({
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["msg", "list-pins", "--json"],
        timeoutMs: 15_000,
      });
      const pins = normalizePinnedThreadIds(payload).map((threadId) => ({ threadId, pinned: true }));

      if (!target) {
        return jsonResult({ ok: true, pins });
      }

      const filtered = pins.filter((row) => row.threadId === target.threadId);
      return jsonResult({ ok: true, pins: filtered, threadId: target.threadId });
    }

    if (action === "member-info") {
      const userId = readStringParam(params, "userId", { required: true });
      const row = await runOpenzcaJson<unknown>({
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["msg", "member-info", userId, "--json"],
        timeoutMs: 15_000,
      });
      return jsonResult({ ok: true, member: row });
    }

    throw new Error(`Action ${action} is not supported for provider openzalo.`);
  },
};
