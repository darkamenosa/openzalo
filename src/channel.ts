import type {
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelDock,
  ChannelGroupContext,
  ChannelPlugin,
  ChannelMessageActionName,
  OpenClawConfig,
  GroupToolPolicyConfig,
} from "openclaw/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  createActionGate,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  jsonResult,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  readNumberParam,
  readStringParam,
  resolveToolsBySender,
  resolveChannelMediaMaxBytes,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";
import type { OpenzaloActionsConfig, ZcaFriend, ZcaGroup, ZcaUserInfo } from "./types.js";
import {
  listOpenzaloAccountIds,
  resolveDefaultOpenzaloAccountId,
  resolveOpenzaloAccountSync,
  getZcaUserInfo,
  checkZcaAuthenticated,
  type ResolvedOpenzaloAccount,
} from "./accounts.js";
import { OpenzaloConfigSchema } from "./config-schema.js";
import { openzaloOnboardingAdapter } from "./onboarding.js";
import { probeOpenzalo } from "./probe.js";
import {
  deleteMessageOpenzalo,
  editMessageOpenzalo,
  getMemberInfoOpenzalo,
  listPinnedConversationsOpenzalo,
  pinConversationOpenzalo,
  readRecentMessagesOpenzalo,
  sendMessageOpenzalo,
  sendReactionOpenzalo,
  unsendMessageOpenzalo,
} from "./send.js";
import { collectOpenzaloStatusIssues } from "./status-issues.js";
import { checkOpenzcaInstalled, parseJsonOutput, resolveOpenzcaProfileEnv, runOpenzca, runOpenzcaInteractive } from "./openzca.js";
import { OPENZALO_DEFAULT_GROUP_HISTORY_LIMIT, OPENZALO_TEXT_LIMIT } from "./constants.js";
import { getOpenzaloRuntime } from "./runtime.js";
import {
  normalizeOpenzaloTarget,
  parseOpenzaloActionTarget,
  resolveOpenzaloThreadTarget,
} from "./target.js";

const meta = {
  id: "openzalo",
  label: "Zalo Personal",
  selectionLabel: "Zalo (Personal Account)",
  docsPath: "/channels/openzalo",
  docsLabel: "openzalo",
  blurb: "Zalo personal account via QR code login.",
  aliases: ["zlu"],
  order: 85,
  quickstartAllowFrom: true,
};

function resolveOpenzaloQrProfile(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId);
  if (!normalized || normalized === DEFAULT_ACCOUNT_ID) {
    return resolveOpenzcaProfileEnv() || "default";
  }
  return normalized;
}

function mapUser(params: {
  id: string;
  name?: string | null;
  avatarUrl?: string | null;
  raw?: unknown;
}): ChannelDirectoryEntry {
  return {
    kind: "user",
    id: params.id,
    name: params.name ?? undefined,
    avatarUrl: params.avatarUrl ?? undefined,
    raw: params.raw,
  };
}

function mapGroup(params: {
  id: string;
  name?: string | null;
  raw?: unknown;
}): ChannelDirectoryEntry {
  return {
    kind: "group",
    id: params.id,
    name: params.name ?? undefined,
    raw: params.raw,
  };
}

function resolveOpenzaloGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const account = resolveOpenzaloAccountSync({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
  const groups = account.config.groups ?? {};
  const groupId = params.groupId?.trim();
  const groupChannel = params.groupChannel?.trim();
  const candidates = [
    groupId,
    groupChannel,
    groupId ? `group:${groupId}` : undefined,
    "*",
  ].filter((value): value is string => Boolean(value));
  for (const key of candidates) {
    const entry = groups[key];
    if (!entry) {
      continue;
    }
    const senderPolicy = resolveToolsBySender({
      toolsBySender: entry.toolsBySender,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
    if (senderPolicy) {
      return senderPolicy;
    }
    if (entry.tools) {
      return entry.tools;
    }
  }
  return undefined;
}

function resolveOpenzaloGroupRequireMention({
  cfg,
  accountId,
  groupId,
  groupChannel,
}: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
}): boolean {
  const account = resolveOpenzaloAccountSync({
    cfg,
    accountId: accountId ?? undefined,
  });
  const groups = account.config.groups ?? {};
  const normalizedCandidates = [
    groupId?.trim(),
    groupChannel?.trim(),
    groupId?.trim() ? `group:${groupId.trim()}` : undefined,
    "*",
  ].filter((value): value is string => Boolean(value));
  for (const key of normalizedCandidates) {
    const groupConfig = groups[key];
    if (groupConfig?.requireMention !== undefined) {
      return groupConfig.requireMention;
    }
  }

  return account.config.groupRequireMention ?? true;
}

type OpenzaloThreadingToolContext = {
  currentChannelId?: string;
  hasRepliedRef?: { value: boolean };
  replyToId?: string;
  replyToIdFull?: string;
};

type OpenzaloUndoRef = {
  accountId: string;
  threadId: string;
  isGroup: boolean;
  msgId: string;
  cliMsgId: string;
  ts: number;
};

const OPENZALO_UNDO_REF_MAX_AGE_MS = 30 * 60 * 1000;
const OPENZALO_UNDO_REF_MAX_PER_ACCOUNT = 40;
const openzaloUndoRefCache = new Map<string, OpenzaloUndoRef[]>();

function buildOpenzaloThreadingToolContext(params: {
  context: { From?: string; To?: string; ChatType?: string; ReplyToId?: string; ReplyToIdFull?: string };
  hasRepliedRef?: { value: boolean };
}): OpenzaloThreadingToolContext {
  const currentChannelId =
    coerceOpenzaloThreadingTarget(params.context.From, params.context.ChatType) ||
    coerceOpenzaloThreadingTarget(params.context.To, params.context.ChatType) ||
    undefined;
  const replyToId =
    typeof params.context.ReplyToId === "string" && params.context.ReplyToId.trim()
      ? params.context.ReplyToId.trim()
      : undefined;
  const replyToIdFull =
    typeof params.context.ReplyToIdFull === "string" && params.context.ReplyToIdFull.trim()
      ? params.context.ReplyToIdFull.trim()
      : undefined;
  return {
    currentChannelId,
    hasRepliedRef: params.hasRepliedRef,
    replyToId,
    replyToIdFull,
  };
}

function coerceOpenzaloThreadingTarget(rawTarget?: string, chatType?: string): string | undefined {
  const trimmed = rawTarget?.trim();
  if (!trimmed) {
    return undefined;
  }
  if ((chatType ?? "").trim().toLowerCase() !== "group") {
    return trimmed;
  }
  const parsed = parseOpenzaloActionTarget(trimmed);
  if (!parsed.threadId || parsed.isGroup) {
    return trimmed;
  }
  if (/^(openzalo|zlu):/i.test(trimmed)) {
    return `openzalo:group:${parsed.threadId}`;
  }
  return `group:${parsed.threadId}`;
}

function readActionMessageField(params: Record<string, unknown>, key: string): string | undefined {
  const direct = readStringParam(params, key);
  if (direct) {
    return direct;
  }
  const fromMessage = params.message;
  if (!fromMessage || typeof fromMessage !== "object") {
    return undefined;
  }
  const value = (fromMessage as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveOpenzaloActionThread(
  params: Record<string, unknown>,
  toolContext?: OpenzaloThreadingToolContext,
): { threadId: string; isGroup: boolean } {
  const toTarget = readStringParam(params, "to");
  const threadTarget = readStringParam(params, "threadId");
  const channelTarget = readStringParam(params, "channelId");
  const hasExplicitTarget = Boolean(toTarget || threadTarget || channelTarget);
  const contextTarget = toolContext?.currentChannelId?.trim();
  const rawTarget = toTarget ?? threadTarget ?? channelTarget ?? contextTarget;
  if (!rawTarget) {
    throw new Error("thread target required");
  }
  return resolveOpenzaloThreadTarget({
    rawTarget,
    isGroup: typeof params.isGroup === "boolean" ? params.isGroup : undefined,
    hasExplicitTarget,
    groupHintTargets: [channelTarget, toTarget, contextTarget].filter(
      (value): value is string => Boolean(value),
    ),
    chatType: readStringParam(params, "chatType") ?? readStringParam(params, "chat_type"),
  });
}

function readToolContextString(
  toolContext: unknown,
  key: "replyToId" | "replyToIdFull",
): string | undefined {
  if (!toolContext || typeof toolContext !== "object") {
    return undefined;
  }
  const value = (toolContext as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeActionId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return undefined;
}

function cacheUndoRef(ref: OpenzaloUndoRef): void {
  const list = openzaloUndoRefCache.get(ref.accountId) ?? [];
  const deduped = list.filter(
    (item) =>
      !(
        item.threadId === ref.threadId &&
        item.isGroup === ref.isGroup &&
        item.msgId === ref.msgId &&
        item.cliMsgId === ref.cliMsgId
      ),
  );
  deduped.unshift(ref);
  const now = Date.now();
  const next = deduped
    .filter((item) => now - item.ts <= OPENZALO_UNDO_REF_MAX_AGE_MS)
    .slice(0, OPENZALO_UNDO_REF_MAX_PER_ACCOUNT);
  openzaloUndoRefCache.set(ref.accountId, next);
}

function findCachedUndoRef(params: {
  accountId: string;
  threadId?: string;
  isGroup?: boolean;
}): OpenzaloUndoRef | undefined {
  const list = openzaloUndoRefCache.get(params.accountId) ?? [];
  const now = Date.now();
  const alive = list.filter((item) => now - item.ts <= OPENZALO_UNDO_REF_MAX_AGE_MS);
  if (alive.length !== list.length) {
    openzaloUndoRefCache.set(params.accountId, alive);
  }
  if (!params.threadId) {
    return alive[0];
  }
  return alive.find(
    (item) =>
      item.threadId === params.threadId &&
      (typeof params.isGroup === "boolean" ? item.isGroup === params.isGroup : true),
  );
}

function extractUndoRefFromRecentRow(row: unknown): {
  msgId?: string;
  cliMsgId?: string;
  senderId?: string;
  ts?: number;
} {
  if (!row || typeof row !== "object") {
    return {};
  }
  const rec = row as Record<string, unknown>;
  const undo = rec.undo as Record<string, unknown> | undefined;
  const data = rec.data as Record<string, unknown> | undefined;
  const msgId =
    normalizeActionId(undo?.msgId) ??
    normalizeActionId(rec.msgId) ??
    normalizeActionId(data?.msgId) ??
    normalizeActionId(rec.messageId);
  const cliMsgId =
    normalizeActionId(undo?.cliMsgId) ??
    normalizeActionId(rec.cliMsgId) ??
    normalizeActionId(data?.cliMsgId);
  const senderId =
    normalizeActionId(rec.senderId) ??
    normalizeActionId(rec.uidFrom) ??
    normalizeActionId(data?.uidFrom) ??
    normalizeActionId((rec.sender as Record<string, unknown> | undefined)?.id);
  const tsRaw = rec.ts ?? data?.ts;
  const ts =
    typeof tsRaw === "number" && Number.isFinite(tsRaw)
      ? tsRaw
      : typeof tsRaw === "string" && Number.isFinite(Number(tsRaw))
        ? Number(tsRaw)
        : undefined;
  return { msgId, cliMsgId, senderId, ts };
}

function isOwnRecentMessageSender(senderId: string | undefined, botUserId?: string): boolean {
  if (!senderId) {
    return true;
  }
  if (senderId === "0") {
    return true;
  }
  if (!botUserId) {
    return true;
  }
  return senderId === botUserId;
}

async function resolveLatestOwnUndoRefFromRecent(params: {
  profile: string;
  threadId: string;
  isGroup: boolean;
  botUserId?: string;
}): Promise<{ msgId: string; cliMsgId: string } | undefined> {
  const recent = await readRecentMessagesOpenzalo(params.threadId, {
    profile: params.profile,
    isGroup: params.isGroup,
    count: 30,
  });
  if (!recent.ok) {
    return undefined;
  }
  const payload = (recent.output ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length === 0) {
    return undefined;
  }

  let best:
    | {
        msgId: string;
        cliMsgId: string;
        score: number;
      }
    | undefined;

  for (let index = 0; index < messages.length; index += 1) {
    const row = messages[index];
    const parsed = extractUndoRefFromRecentRow(row);
    if (!parsed.msgId || !parsed.cliMsgId) {
      continue;
    }
    if (!isOwnRecentMessageSender(parsed.senderId, params.botUserId)) {
      continue;
    }
    const tsScore = typeof parsed.ts === "number" ? parsed.ts : Number.MAX_SAFE_INTEGER - index;
    if (!best || tsScore > best.score) {
      best = { msgId: parsed.msgId, cliMsgId: parsed.cliMsgId, score: tsScore };
    }
  }

  if (!best) {
    return undefined;
  }
  return { msgId: best.msgId, cliMsgId: best.cliMsgId };
}

function resolveOpenzaloMediaMaxBytes(cfg: OpenClawConfig, accountId?: string | null): number | undefined {
  return resolveChannelMediaMaxBytes({
    cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.openzalo?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.openzalo?.mediaMaxMb,
    accountId,
  });
}

function readSnapshotMetric(
  snapshot: ChannelAccountSnapshot | undefined,
  key: string,
): number {
  const raw = snapshot as Record<string, unknown> | undefined;
  const value = raw?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function listOpenzaloPeersDirectory(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
}): Promise<ChannelDirectoryEntry[]> {
  const ok = await checkOpenzcaInstalled();
  if (!ok) {
    throw new Error("Missing dependency: `openzca` not found in PATH");
  }
  const account = resolveOpenzaloAccountSync({ cfg: params.cfg, accountId: params.accountId });
  const args = params.query?.trim()
    ? ["friend", "find", params.query.trim()]
    : ["friend", "list", "-j"];
  const result = await runOpenzca(args, { profile: account.profile, timeout: 15000 });
  if (!result.ok) {
    throw new Error(result.stderr || "Failed to list peers");
  }
  const parsed = parseJsonOutput<ZcaFriend[]>(result.stdout);
  const rows = Array.isArray(parsed)
    ? parsed.map((f) =>
        mapUser({
          id: String(f.userId),
          name: f.displayName ?? null,
          avatarUrl: f.avatar ?? null,
          raw: f,
        }),
      )
    : [];
  const limit = params.limit;
  return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
}

async function listOpenzaloGroupsDirectory(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
}): Promise<ChannelDirectoryEntry[]> {
  const ok = await checkOpenzcaInstalled();
  if (!ok) {
    throw new Error("Missing dependency: `openzca` not found in PATH");
  }
  const account = resolveOpenzaloAccountSync({ cfg: params.cfg, accountId: params.accountId });
  const result = await runOpenzca(["group", "list", "-j"], {
    profile: account.profile,
    timeout: 15000,
  });
  if (!result.ok) {
    throw new Error(result.stderr || "Failed to list groups");
  }
  const parsed = parseJsonOutput<ZcaGroup[]>(result.stdout);
  let rows = Array.isArray(parsed)
    ? parsed.map((g) =>
        mapGroup({
          id: String(g.groupId),
          name: g.name ?? null,
          raw: g,
        }),
      )
    : [];
  const q = params.query?.trim().toLowerCase();
  if (q) {
    rows = rows.filter((g) => (g.name ?? "").toLowerCase().includes(q) || g.id.includes(q));
  }
  const limit = params.limit;
  return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
}

export const openzaloDock: ChannelDock = {
  id: "openzalo",
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    unsend: true,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  outbound: { textChunkLimit: OPENZALO_TEXT_LIMIT },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveOpenzaloAccountSync({ cfg: cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(openzalo|zlu):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  groups: {
    resolveRequireMention: resolveOpenzaloGroupRequireMention,
    resolveToolPolicy: resolveOpenzaloGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
    buildToolContext: ({ context, hasRepliedRef }) =>
      buildOpenzaloThreadingToolContext({ context, hasRepliedRef }),
  },
};

export const openzaloPlugin: ChannelPlugin<ResolvedOpenzaloAccount> = {
  id: "openzalo",
  meta,
  onboarding: openzaloOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    unsend: true,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  agentPrompt: {
    messageToolHints: () => [
      `- Openzalo group context: the latest ${OPENZALO_DEFAULT_GROUP_HISTORY_LIMIT} group messages are preloaded by default. If context is insufficient, call \`action=read\` with a higher \`limit\` (for example 12-30) before replying.`,
      "- Openzalo targeting: prefer explicit IDs (`group:<id>` / `user:<id>`). Bare numeric IDs are ambiguous; set `isGroup` explicitly when needed.",
      "- Openzalo does support unsend (`action=unsend`). Do not claim unsend is unsupported.",
      "- Voice note handling: when upstream provides a clear transcript, execute the request directly (no confirmation paraphrase).",
      "- Ask clarifying questions only when the transcript/intent is ambiguous or missing critical parameters.",
      "- Example: with a clear transcript like 'bây giờ là mấy giờ', answer the current time directly.",
      "- Cross-chat unsend flow (for example user asks in DM to unsend in a group): first resolve explicit target `group:<id>`, then call `action=read` on that target to fetch `msgId` + `cliMsgId`, then call `action=unsend`.",
      "- If unsend ids are missing, do not stop at 'missing cliMsgId'. Read recent messages in the target thread and recover ids from `[recent_message_refs_for_unsend]` or `[msgId:... cliMsgId:...]` blocks.",
      "- For unsend: if user replies to a message, use `ReplyToIdFull` as `msgId` and `ReplyToId` as `cliMsgId`; otherwise use recent refs (`[recent_message_refs_for_unsend]` or `[msgId:... cliMsgId:...]`) and call `action=unsend`.",
      "- Openzalo media/file send: if a valid local path or URL is already available, call `action=send` directly with `media`/`path`/`filePath`. Avoid extra prep/tool steps unless explicitly requested.",
      "- Openzalo unsend: after `action=send`, keep the returned `undo` payload (`msgId`/`messageId` + `cliMsgId` + thread) and reuse it for `action=unsend`.",
    ],
  },
  reload: { configPrefixes: ["channels.openzalo"] },
  configSchema: buildChannelConfigSchema(OpenzaloConfigSchema),
  config: {
    listAccountIds: (cfg) => listOpenzaloAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveOpenzaloAccountSync({ cfg: cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultOpenzaloAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg,
        sectionKey: "openzalo",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg,
        sectionKey: "openzalo",
        accountId,
        clearBaseFields: [
          "profile",
          "name",
          "dmPolicy",
          "allowFrom",
          "groupPolicy",
          "groups",
          "messagePrefix",
        ],
      }),
    isConfigured: async (account) => {
      // Check if openzca auth status is OK for this profile
      const result = await runOpenzca(["auth", "status"], {
        profile: account.profile,
        timeout: 5000,
      });
      return result.ok;
    },
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: undefined,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveOpenzaloAccountSync({ cfg: cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(openzalo|zlu):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.openzalo?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.openzalo.accounts.${resolvedAccountId}.`
        : "channels.openzalo.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("openzalo"),
        normalizeEntry: (raw) => raw.replace(/^(openzalo|zlu):/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      const groups = account.config.groups ?? {};
      const groupCount = Object.keys(groups).length;
      const requireMention = account.config.groupRequireMention ?? true;
      const wildcardGroupSenderAllowlists = Object.entries(groups)
        .filter(([, groupConfig]) =>
          (groupConfig?.allowFrom ?? []).some((entry) => String(entry).trim() === "*"),
        )
        .map(([groupKey]) => groupKey);

      if (groupPolicy === "open") {
        if (!requireMention) {
          warnings.push(
            `- Openzalo groups: groupPolicy="open" and groupRequireMention=false allows broad group triggering. Set channels.openzalo.groupRequireMention=true or use channels.openzalo.groupPolicy="allowlist".`,
          );
        } else if (groupCount === 0) {
          warnings.push(
            `- Openzalo groups: groupPolicy="open" with no channels.openzalo.groups allowlist. Any group can trigger when mentioned. Set channels.openzalo.groupPolicy="allowlist" and configure channels.openzalo.groups.`,
          );
        }
      }

      if (groupPolicy === "allowlist" && groupCount === 0) {
        warnings.push(
          `- Openzalo groups: groupPolicy="allowlist" but channels.openzalo.groups is empty, so all group messages are blocked until groups are configured.`,
        );
      }
      if (wildcardGroupSenderAllowlists.length > 0) {
        warnings.push(
          `- Openzalo groups: groups.<id>.allowFrom contains "*" (${wildcardGroupSenderAllowlists.join(", ")}), which allows any member in those groups to run /… commands and control directives. Remove "*" and use explicit sender IDs.`,
        );
      }

      return warnings;
    },
  },
  groups: {
    resolveRequireMention: resolveOpenzaloGroupRequireMention,
    resolveToolPolicy: resolveOpenzaloGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
    buildToolContext: ({ context, hasRepliedRef }) =>
      buildOpenzaloThreadingToolContext({ context, hasRepliedRef }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "openzalo",
        accountId,
        name,
      }),
    validateInput: () => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "openzalo",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "openzalo",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            openzalo: {
              ...next.channels?.openzalo,
              enabled: true,
            },
          },
        } as OpenClawConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          openzalo: {
            ...next.channels?.openzalo,
            enabled: true,
            accounts: {
              ...next.channels?.openzalo?.accounts,
              [accountId]: {
                ...next.channels?.openzalo?.accounts?.[accountId],
                enabled: true,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw?.trim();
      if (!trimmed) {
        return undefined;
      }
      const normalized = normalizeOpenzaloTarget(trimmed);
      return normalized || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        const parsed = parseOpenzaloActionTarget(trimmed);
        return /^\d{3,}$/.test(parsed.threadId);
      },
      hint: "<group:threadId|user:threadId|g-threadId|u-threadId|threadId+isGroup>",
    },
  },
  directory: {
    self: async ({ cfg, accountId, runtime }) => {
      const ok = await checkOpenzcaInstalled();
      if (!ok) {
        throw new Error("Missing dependency: `openzca` not found in PATH");
      }
      const account = resolveOpenzaloAccountSync({ cfg: cfg, accountId });
      const result = await runOpenzca(["me", "info", "-j"], {
        profile: account.profile,
        timeout: 10000,
      });
      if (!result.ok) {
        runtime.error(result.stderr || "Failed to fetch profile");
        return null;
      }
      const parsed = parseJsonOutput<ZcaUserInfo>(result.stdout);
      if (!parsed?.userId) {
        return null;
      }
      return mapUser({
        id: String(parsed.userId),
        name: parsed.displayName ?? null,
        avatarUrl: parsed.avatar ?? null,
        raw: parsed,
      });
    },
    listPeers: async ({ cfg, accountId, query, limit }) =>
      listOpenzaloPeersDirectory({ cfg, accountId, query, limit }),
    listGroups: async ({ cfg, accountId, query, limit }) =>
      listOpenzaloGroupsDirectory({ cfg, accountId, query, limit }),
    listPeersLive: async ({ cfg, accountId, query, limit }) =>
      listOpenzaloPeersDirectory({ cfg, accountId, query, limit }),
    listGroupsLive: async ({ cfg, accountId, query, limit }) =>
      listOpenzaloGroupsDirectory({ cfg, accountId, query, limit }),
    listGroupMembers: async ({ cfg, accountId, groupId, limit }) => {
      const ok = await checkOpenzcaInstalled();
      if (!ok) {
        throw new Error("Missing dependency: `openzca` not found in PATH");
      }
      const account = resolveOpenzaloAccountSync({ cfg: cfg, accountId });
      const result = await runOpenzca(["group", "members", groupId, "-j"], {
        profile: account.profile,
        timeout: 20000,
      });
      if (!result.ok) {
        throw new Error(result.stderr || "Failed to list group members");
      }
      const parsed = parseJsonOutput<Array<Partial<ZcaFriend> & { userId?: string | number }>>(
        result.stdout,
      );
      const rows = Array.isArray(parsed)
        ? parsed
            .map((m) => {
              const id = m.userId ?? (m as { id?: string | number }).id;
              if (!id) {
                return null;
              }
              return mapUser({
                id: String(id),
                name: (m as { displayName?: string }).displayName ?? null,
                avatarUrl: (m as { avatar?: string }).avatar ?? null,
                raw: m,
              });
            })
            .filter(Boolean)
        : [];
      const sliced = typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
      return sliced as ChannelDirectoryEntry[];
    },
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) => {
      const results = [];
      for (const input of inputs) {
        const trimmed = input.trim();
        if (!trimmed) {
          results.push({ input, resolved: false, note: "empty input" });
          continue;
        }
        if (/^\d+$/.test(trimmed)) {
          results.push({ input, resolved: true, id: trimmed });
          continue;
        }
        try {
          const account = resolveOpenzaloAccountSync({
            cfg: cfg,
            accountId: accountId ?? DEFAULT_ACCOUNT_ID,
          });
          const args =
            kind === "user"
              ? trimmed
                ? ["friend", "find", trimmed]
                : ["friend", "list", "-j"]
              : ["group", "list", "-j"];
          const result = await runOpenzca(args, { profile: account.profile, timeout: 15000 });
          if (!result.ok) {
            throw new Error(result.stderr || "openzca lookup failed");
          }
          if (kind === "user") {
            const parsed = parseJsonOutput<ZcaFriend[]>(result.stdout) ?? [];
            const matches = Array.isArray(parsed)
              ? parsed.map((f) => ({
                  id: String(f.userId),
                  name: f.displayName ?? undefined,
                }))
              : [];
            const best = matches[0];
            results.push({
              input,
              resolved: Boolean(best?.id),
              id: best?.id,
              name: best?.name,
              note: matches.length > 1 ? "multiple matches; chose first" : undefined,
            });
          } else {
            const parsed = parseJsonOutput<ZcaGroup[]>(result.stdout) ?? [];
            const matches = Array.isArray(parsed)
              ? parsed.map((g) => ({
                  id: String(g.groupId),
                  name: g.name ?? undefined,
                }))
              : [];
            const best =
              matches.find((g) => g.name?.toLowerCase() === trimmed.toLowerCase()) ?? matches[0];
            results.push({
              input,
              resolved: Boolean(best?.id),
              id: best?.id,
              name: best?.name,
              note: matches.length > 1 ? "multiple matches; chose first" : undefined,
            });
          }
        } catch (err) {
          runtime.error?.(`openzalo resolve failed: ${String(err)}`);
          results.push({ input, resolved: false, note: "lookup failed" });
        }
      }
      return results;
    },
  },
  actions: {
    listActions: ({ cfg }) => {
      const accountIds = listOpenzaloAccountIds(cfg);
      const accounts = accountIds
        .map((id) => resolveOpenzaloAccountSync({ cfg, accountId: id }))
        .filter((account) => account.enabled);
      if (accounts.length === 0) {
        return [];
      }

      const actions = new Set<ChannelMessageActionName>(["send"]);
      const isAnyEnabled = (key: keyof OpenzaloActionsConfig, defaultValue = true) =>
        accounts.some((account) =>
          createActionGate((account.config.actions ?? {}) as OpenzaloActionsConfig)(
            key,
            defaultValue,
          ),
        );

      if (isAnyEnabled("messages")) {
        actions.add("read");
        actions.add("edit");
        actions.add("delete");
        actions.add("unsend");
        actions.add("pin");
        actions.add("unpin");
        actions.add("list-pins");
        actions.add("member-info");
      }
      if (isAnyEnabled("reactions")) {
        actions.add("react");
      }
      return Array.from(actions);
    },
    extractToolSend: ({ args }) => {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      if (action !== "sendMessage") {
        return null;
      }
      const to =
        (typeof args.to === "string" ? args.to.trim() : "") ||
        (typeof args.threadId === "string" ? args.threadId.trim() : "");
      if (!to) {
        return null;
      }
      const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
      return { to, accountId };
    },
    handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
      const account = resolveOpenzaloAccountSync({ cfg, accountId });
      const actionGate = createActionGate(
        (account.config.actions ?? {}) as OpenzaloActionsConfig,
      );
      const maxChars =
        typeof account.config.textChunkLimit === "number" && account.config.textChunkLimit > 0
          ? Math.min(Math.floor(account.config.textChunkLimit), OPENZALO_TEXT_LIMIT)
          : OPENZALO_TEXT_LIMIT;
      const maxBytes = resolveOpenzaloMediaMaxBytes(cfg, accountId);

      if (action === "send") {
        const mediaUrl =
          readStringParam(params, "media", { trim: false }) ??
          readStringParam(params, "path", { trim: false }) ??
          readStringParam(params, "filePath", { trim: false });
        const messageText =
          readStringParam(params, "message", {
            required: !mediaUrl,
            allowEmpty: true,
          }) ?? undefined;
        const captionText = readStringParam(params, "caption", { allowEmpty: true });
        const content = messageText ?? captionText ?? "";
        const target = resolveOpenzaloActionThread(params, toolContext);
        const result = await sendMessageOpenzalo(target.threadId, content, {
          profile: account.profile,
          isGroup: target.isGroup,
          mediaUrl: mediaUrl ?? undefined,
          maxChars,
          maxBytes,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to send message");
        }
        const sentMsgId = result.messageId ?? result.msgId;
        if (sentMsgId && result.cliMsgId) {
          cacheUndoRef({
            accountId: account.accountId,
            threadId: target.threadId,
            isGroup: target.isGroup,
            msgId: sentMsgId,
            cliMsgId: result.cliMsgId,
            ts: Date.now(),
          });
        }
        return jsonResult({
          ok: true,
          action: "send",
          threadId: target.threadId,
          messageId: sentMsgId ?? null,
          msgId: sentMsgId ?? null,
          cliMsgId: result.cliMsgId ?? null,
          undo:
            sentMsgId && result.cliMsgId
              ? {
                  msgId: sentMsgId,
                  cliMsgId: result.cliMsgId,
                  threadId: target.threadId,
                  isGroup: target.isGroup,
                }
              : null,
        });
      }

      if (action === "read") {
        if (!actionGate("messages")) {
          throw new Error("Openzalo read action is disabled via actions.messages.");
        }
        const target = resolveOpenzaloActionThread(params, toolContext);
        const count = readNumberParam(params, "limit", { integer: true });
        const result = await readRecentMessagesOpenzalo(target.threadId, {
          profile: account.profile,
          isGroup: target.isGroup,
          count: count ?? undefined,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to read recent messages");
        }
        return jsonResult({
          ok: true,
          action: "read",
          threadId: target.threadId,
          data: result.output ?? null,
        });
      }

      if (action === "react") {
        if (!actionGate("reactions")) {
          throw new Error("Openzalo reactions are disabled via actions.reactions.");
        }
        const target = resolveOpenzaloActionThread(params, toolContext);
        const msgId =
          readActionMessageField(params, "msgId") ??
          readActionMessageField(params, "messageId") ??
          readStringParam(params, "msgId", { required: true, label: "msgId/messageId" });
        const cliMsgId =
          readActionMessageField(params, "cliMsgId") ??
          readActionMessageField(params, "clientMessageId") ??
          readStringParam(params, "cliMsgId", { required: true });
        const reaction =
          readStringParam(params, "emoji") ??
          readStringParam(params, "reaction", { required: true });
        const result = await sendReactionOpenzalo(
          {
            threadId: target.threadId,
            msgId,
            cliMsgId,
            reaction,
          },
          {
            profile: account.profile,
            isGroup: target.isGroup,
          },
        );
        if (!result.ok) {
          throw new Error(result.error || "Failed to react to message");
        }
        return jsonResult({
          ok: true,
          action: "react",
          threadId: target.threadId,
          data: result.output ?? null,
        });
      }

      if (action === "edit") {
        if (!actionGate("messages")) {
          throw new Error("Openzalo edit action is disabled via actions.messages.");
        }
        const target = resolveOpenzaloActionThread(params, toolContext);
        const msgId =
          readActionMessageField(params, "msgId") ??
          readActionMessageField(params, "messageId") ??
          readStringParam(params, "msgId", { required: true, label: "msgId/messageId" });
        const cliMsgId =
          readActionMessageField(params, "cliMsgId") ??
          readActionMessageField(params, "clientMessageId") ??
          readStringParam(params, "cliMsgId", { required: true });
        const message = readStringParam(params, "message", {
          required: true,
          allowEmpty: true,
        });
        const result = await editMessageOpenzalo(
          {
            threadId: target.threadId,
            msgId,
            cliMsgId,
            message,
          },
          {
            profile: account.profile,
            isGroup: target.isGroup,
            maxChars,
          },
        );
        if (!result.ok) {
          throw new Error(result.error || "Failed to edit message");
        }
        return jsonResult({
          ok: true,
          action: "edit",
          threadId: target.threadId,
          data: result.output ?? null,
        });
      }

      if (action === "pin" || action === "unpin") {
        if (!actionGate("messages")) {
          throw new Error(`Openzalo ${action} action is disabled via actions.messages.`);
        }
        const target = resolveOpenzaloActionThread(params, toolContext);
        const pinned = action === "pin";
        const result = await pinConversationOpenzalo(target.threadId, {
          profile: account.profile,
          isGroup: target.isGroup,
          pinned,
        });
        if (!result.ok) {
          throw new Error(
            result.error || `Failed to ${pinned ? "pin" : "unpin"} conversation`,
          );
        }
        return jsonResult({
          ok: true,
          action,
          threadId: target.threadId,
          pinned,
          data: result.output ?? null,
        });
      }

      if (action === "list-pins") {
        if (!actionGate("messages")) {
          throw new Error("Openzalo list-pins action is disabled via actions.messages.");
        }
        const result = await listPinnedConversationsOpenzalo({
          profile: account.profile,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to list pinned conversations");
        }
        return jsonResult({
          ok: true,
          action: "list-pins",
          data: result.output ?? null,
        });
      }

      if (action === "member-info") {
        if (!actionGate("messages")) {
          throw new Error("Openzalo member-info action is disabled via actions.messages.");
        }
        const userId =
          readStringParam(params, "userId") ??
          readStringParam(params, "memberId") ??
          readStringParam(params, "id", { required: true, label: "userId/memberId" });
        const result = await getMemberInfoOpenzalo(userId, {
          profile: account.profile,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to get member info");
        }
        return jsonResult({
          ok: true,
          action: "member-info",
          userId,
          data: result.output ?? null,
        });
      }

      if (action === "unsend") {
        if (!actionGate("messages")) {
          throw new Error("Openzalo unsend action is disabled via actions.messages.");
        }
        let target = resolveOpenzaloActionThread(params, toolContext);
        const hasExplicitTarget = Boolean(
          readStringParam(params, "to") ??
            readStringParam(params, "threadId") ??
            readStringParam(params, "channelId"),
        );
        let msgId =
          readActionMessageField(params, "msgId") ??
          readActionMessageField(params, "messageId") ??
          readActionMessageField(params, "globalMsgId") ??
          readActionMessageField(params, "replyToIdFull") ??
          readStringParam(params, "msgId") ??
          readStringParam(params, "messageId") ??
          readStringParam(params, "replyToIdFull") ??
          readToolContextString(toolContext, "replyToIdFull");
        let cliMsgId =
          readActionMessageField(params, "cliMsgId") ??
          readActionMessageField(params, "clientMessageId") ??
          readActionMessageField(params, "replyToId") ??
          readStringParam(params, "cliMsgId") ??
          readStringParam(params, "clientMessageId") ??
          readStringParam(params, "replyToId") ??
          readToolContextString(toolContext, "replyToId");
        if (!msgId || !cliMsgId) {
          const cachedForTarget = findCachedUndoRef({
            accountId: account.accountId,
            threadId: target.threadId,
            isGroup: target.isGroup,
          });
          if (cachedForTarget) {
            msgId = msgId ?? cachedForTarget.msgId;
            cliMsgId = cliMsgId ?? cachedForTarget.cliMsgId;
          }
        }
        if ((!msgId || !cliMsgId) && !hasExplicitTarget) {
          const cachedLatest = findCachedUndoRef({ accountId: account.accountId });
          if (cachedLatest) {
            target = {
              threadId: cachedLatest.threadId,
              isGroup: cachedLatest.isGroup,
            };
            msgId = msgId ?? cachedLatest.msgId;
            cliMsgId = cliMsgId ?? cachedLatest.cliMsgId;
          }
        }
        if (!msgId || !cliMsgId) {
          const me = await getZcaUserInfo(account.profile);
          const botUserId = normalizeActionId(me?.userId);
          const recentRef = await resolveLatestOwnUndoRefFromRecent({
            profile: account.profile,
            threadId: target.threadId,
            isGroup: target.isGroup,
            botUserId,
          });
          if (recentRef) {
            msgId = msgId ?? recentRef.msgId;
            cliMsgId = cliMsgId ?? recentRef.cliMsgId;
            cacheUndoRef({
              accountId: account.accountId,
              threadId: target.threadId,
              isGroup: target.isGroup,
              msgId: recentRef.msgId,
              cliMsgId: recentRef.cliMsgId,
              ts: Date.now(),
            });
          }
        }
        if (!msgId || !cliMsgId) {
          throw new Error(
            "Could not resolve msgId/cliMsgId for unsend. Reply directly to the target message, provide both IDs, or specify the target thread/group explicitly.",
          );
        }
        const result = await unsendMessageOpenzalo(
          { threadId: target.threadId, msgId, cliMsgId },
          {
            profile: account.profile,
            isGroup: target.isGroup,
          },
        );
        if (!result.ok) {
          throw new Error(result.error || "Failed to unsend message");
        }
        return jsonResult({
          ok: true,
          action: "unsend",
          threadId: target.threadId,
          data: result.output ?? null,
        });
      }

      if (action === "delete") {
        if (!actionGate("messages")) {
          throw new Error("Openzalo delete action is disabled via actions.messages.");
        }
        const target = resolveOpenzaloActionThread(params, toolContext);
        const msgId =
          readActionMessageField(params, "msgId") ??
          readActionMessageField(params, "messageId") ??
          readStringParam(params, "msgId", { required: true, label: "msgId/messageId" });
        const cliMsgId =
          readActionMessageField(params, "cliMsgId") ??
          readActionMessageField(params, "clientMessageId") ??
          readStringParam(params, "cliMsgId", { required: true });
        const uidFrom =
          readActionMessageField(params, "uidFrom") ??
          readActionMessageField(params, "senderId") ??
          readActionMessageField(params, "fromId") ??
          readStringParam(params, "uidFrom", { required: true, label: "uidFrom/senderId" });
        const onlyMe =
          typeof params.onlyMe === "boolean"
            ? params.onlyMe
            : typeof params.only_me === "boolean"
              ? params.only_me
              : false;
        const result = await deleteMessageOpenzalo(
          {
            threadId: target.threadId,
            msgId,
            cliMsgId,
            uidFrom,
            onlyMe,
          },
          {
            profile: account.profile,
            isGroup: target.isGroup,
          },
        );
        if (!result.ok) {
          throw new Error(result.error || "Failed to delete message");
        }
        return jsonResult({
          ok: true,
          action: "delete",
          threadId: target.threadId,
          data: result.output ?? null,
        });
      }

      throw new Error(`Action ${action} is not supported for provider openzalo.`);
    },
  },
  pairing: {
    idLabel: "openzaloUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(openzalo|zlu):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveOpenzaloAccountSync({ cfg: cfg });
      const authenticated = await checkZcaAuthenticated(account.profile);
      if (!authenticated) {
        throw new Error("Openzalo not authenticated");
      }
      await sendMessageOpenzalo(id, "Your pairing request has been approved.", {
        profile: account.profile,
      });
    },
  },
  auth: {
    login: async ({ cfg, accountId, runtime }) => {
      const account = resolveOpenzaloAccountSync({
        cfg: cfg,
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
      });
      const ok = await checkOpenzcaInstalled();
      if (!ok) {
        throw new Error(
          "Missing dependency: `openzca` not found in PATH. See https://openzca.com/",
        );
      }
      runtime.log(
        `Scan the QR code in this terminal to link Zalo Personal (account: ${account.accountId}, profile: ${account.profile}).`,
      );
      const result = await runOpenzcaInteractive(["auth", "login"], { profile: account.profile });
      if (!result.ok) {
        throw new Error(result.stderr || "Openzalo login failed");
      }
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getOpenzaloRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: OPENZALO_TEXT_LIMIT,
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveOpenzaloAccountSync({ cfg: cfg, accountId });
      const target = parseOpenzaloActionTarget(to);
      const maxChars =
        typeof account.config.textChunkLimit === "number" && account.config.textChunkLimit > 0
          ? Math.min(Math.floor(account.config.textChunkLimit), OPENZALO_TEXT_LIMIT)
          : OPENZALO_TEXT_LIMIT;
      const maxBytes = resolveOpenzaloMediaMaxBytes(cfg, accountId);
      const result = await sendMessageOpenzalo(target.threadId, text, {
        profile: account.profile,
        isGroup: target.isGroup,
        maxChars,
        maxBytes,
      });
      return {
        channel: "openzalo",
        ok: result.ok,
        messageId: result.messageId ?? result.msgId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const account = resolveOpenzaloAccountSync({ cfg: cfg, accountId });
      const target = parseOpenzaloActionTarget(to);
      const maxChars =
        typeof account.config.textChunkLimit === "number" && account.config.textChunkLimit > 0
          ? Math.min(Math.floor(account.config.textChunkLimit), OPENZALO_TEXT_LIMIT)
          : OPENZALO_TEXT_LIMIT;
      const maxBytes = resolveOpenzaloMediaMaxBytes(cfg, accountId);
      const result = await sendMessageOpenzalo(target.threadId, text, {
        profile: account.profile,
        isGroup: target.isGroup,
        mediaUrl,
        maxChars,
        maxBytes,
      });
      return {
        channel: "openzalo",
        ok: result.ok,
        messageId: result.messageId ?? result.msgId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      dispatchFailures: 0,
      typingFailures: 0,
      textChunkFailures: 0,
      mediaFailures: 0,
      failureNoticesSent: 0,
      failureNoticeFailures: 0,
      humanPassSkips: 0,
    } as ChannelAccountSnapshot,
    collectStatusIssues: collectOpenzaloStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => probeOpenzalo(account.profile, timeoutMs),
    buildAccountSnapshot: async ({ account, runtime }) => {
      const zcaInstalled = await checkOpenzcaInstalled();
      const configured = zcaInstalled ? await checkZcaAuthenticated(account.profile) : false;
      const configError = zcaInstalled ? "not authenticated" : "openzca CLI not found in PATH";
      const groupRules = Object.values(account.config.groups ?? {});
      const groupAllowFromConfiguredCount = groupRules.filter(
        (groupRule) => (groupRule?.allowFrom ?? []).length > 0,
      ).length;
      const groupAllowFromWildcardCount = groupRules.filter((groupRule) =>
        (groupRule?.allowFrom ?? []).some((entry) => String(entry).trim() === "*"),
      ).length;
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: configured ? (runtime?.lastError ?? null) : (runtime?.lastError ?? configError),
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
        dmPolicy: account.config.dmPolicy ?? "pairing",
        groupPolicy: account.config.groupPolicy ?? "allowlist",
        groupRequireMention: account.config.groupRequireMention ?? true,
        groupMentionDetectionFailure: account.config.groupMentionDetectionFailure,
        sendFailureNotice: account.config.sendFailureNotice !== false,
        groupCount: Object.keys(account.config.groups ?? {}).length,
        hasWildcardGroupRule: Boolean(account.config.groups?.["*"]),
        groupAllowFromConfiguredCount,
        groupAllowFromWildcardCount,
        dispatchFailures: readSnapshotMetric(runtime, "dispatchFailures"),
        typingFailures: readSnapshotMetric(runtime, "typingFailures"),
        textChunkFailures: readSnapshotMetric(runtime, "textChunkFailures"),
        mediaFailures: readSnapshotMetric(runtime, "mediaFailures"),
        failureNoticesSent: readSnapshotMetric(runtime, "failureNoticesSent"),
        failureNoticeFailures: readSnapshotMetric(runtime, "failureNoticeFailures"),
        humanPassSkips: readSnapshotMetric(runtime, "humanPassSkips"),
      } as ChannelAccountSnapshot;
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      let userLabel = "";
      try {
        const userInfo = await getZcaUserInfo(account.profile);
        if (userInfo?.displayName) {
          userLabel = ` (${userInfo.displayName})`;
        }
        ctx.setStatus({
          accountId: account.accountId,
          profile: userInfo,
        });
      } catch {
        // ignore probe errors
      }
      ctx.log?.info(`[${account.accountId}] starting openzalo provider${userLabel}`);
      const { monitorOpenzaloProvider } = await import("./monitor.js");
      return monitorOpenzaloProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
    loginWithQrStart: async (params) => {
      const profile = resolveOpenzaloQrProfile(params.accountId);
      // Start login and get QR code
      const result = await runOpenzca(["auth", "login", "--qr-base64"], {
        profile,
        timeout: params.timeoutMs ?? 30000,
      });
      if (!result.ok) {
        return { message: result.stderr || "Failed to start QR login" };
      }
      // The stdout should contain the base64 QR data URL
      const qrMatch = result.stdout.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/);
      if (qrMatch) {
        return { qrDataUrl: qrMatch[0], message: "Scan QR code with Zalo app" };
      }
      return { message: result.stdout || "QR login started" };
    },
    loginWithQrWait: async (params) => {
      const profile = resolveOpenzaloQrProfile(params.accountId);
      // Check if already authenticated
      const statusResult = await runOpenzca(["auth", "status"], {
        profile,
        timeout: params.timeoutMs ?? 60000,
      });
      return {
        connected: statusResult.ok,
        message: statusResult.ok ? "Login successful" : statusResult.stderr || "Login pending",
      };
    },
    logoutAccount: async (ctx) => {
      const result = await runOpenzca(["auth", "logout"], {
        profile: ctx.account.profile,
        timeout: 10000,
      });
      return {
        cleared: result.ok,
        loggedOut: result.ok,
        message: result.ok ? "Logged out" : result.stderr,
      };
    },
  },
};

export type { ResolvedOpenzaloAccount };
