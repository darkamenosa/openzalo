import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { listOpenzaloDirectoryGroups, listOpenzaloDirectoryPeers, listOpenzaloDirectorySelf } from "./directory.js";
import { handleOpenzaloInbound } from "./inbound.js";
import { monitorOpenzaloProvider } from "./monitor.js";
import { openzaloMessageActions } from "./actions.js";
import {
  looksLikeOpenzaloTargetId,
  normalizeOpenzaloAllowEntry,
  normalizeOpenzaloMessagingTarget,
  parseOpenzaloTarget,
} from "./normalize.js";
import {
  listOpenzaloAccountIds,
  resolveDefaultOpenzaloAccountId,
  resolveOpenzaloAccount,
} from "./accounts.js";
import {
  resolveOpenzaloGroupMatch,
  resolveOpenzaloGroupToolPolicy,
  resolveOpenzaloRequireMention,
} from "./policy.js";
import { openzaloOnboardingAdapter } from "./onboarding.js";
import { probeOpenzaloAuth } from "./probe.js";
import { getOpenzaloRuntime } from "./runtime.js";
import { sendMediaOpenzalo, sendTextOpenzalo } from "./send.js";
import { OpenzaloConfigSchema } from "./config-schema.js";
import { collectOpenzaloStatusIssues, resolveOpenzaloAccountState } from "./status.js";
import { runOpenzcaCommand, runOpenzcaInteractive } from "./openzca.js";
import { normalizeResolvedGroupTarget, normalizeResolvedUserTarget } from "./resolver-target.js";
import type { CoreConfig, OpenzaloProbe, ResolvedOpenzaloAccount } from "./types.js";

const meta = {
  id: "openzalo",
  label: "OpenZalo",
  selectionLabel: "OpenZalo (personal account)",
  detailLabel: "OpenZalo",
  docsPath: "/channels/openzalo",
  docsLabel: "openzalo",
  blurb: "Personal Zalo account integration via openzca CLI.",
  systemImage: "message",
  aliases: ["ozl", "zlu", "zalo-personal"],
  order: 80,
  quickstartAllowFrom: true,
};

function normalizeDirectoryName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveAccount(cfg: unknown, accountId?: string | null): ResolvedOpenzaloAccount {
  return resolveOpenzaloAccount({ cfg: cfg as CoreConfig, accountId });
}

function chooseDirectoryMatch<Row extends { id: string; name?: string }>(params: {
  query: string;
  entries: Row[];
}): { best?: Row; ambiguous: boolean } {
  const query = params.query.trim().toLowerCase();
  if (!query) {
    return { ambiguous: false };
  }
  const exactMatches = params.entries.filter(
    (entry) =>
      entry.id.toLowerCase() === query || normalizeDirectoryName(entry.name).toLowerCase() === query,
  );
  if (exactMatches.length === 1) {
    return { best: exactMatches[0], ambiguous: false };
  }
  if (exactMatches.length > 1) {
    return { best: exactMatches[0], ambiguous: true };
  }
  const partialMatches = params.entries.filter((entry) => {
    const name = normalizeDirectoryName(entry.name).toLowerCase();
    return entry.id.toLowerCase().includes(query) || (name ? name.includes(query) : false);
  });
  if (partialMatches.length === 1) {
    return { best: partialMatches[0], ambiguous: false };
  }
  if (partialMatches.length > 1) {
    return { best: partialMatches[0], ambiguous: true };
  }
  return { ambiguous: false };
}

export const openzaloPlugin: ChannelPlugin<ResolvedOpenzaloAccount, OpenzaloProbe> = {
  id: "openzalo",
  meta,
  onboarding: openzaloOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    unsend: true,
    groupManagement: true,
    blockStreaming: true,
  },
  pairing: {
    idLabel: "openzaloSenderId",
    normalizeAllowEntry: (entry) => normalizeOpenzaloAllowEntry(entry),
    notifyApproval: async ({ cfg, id, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      await sendTextOpenzalo({
        cfg: cfg as CoreConfig,
        account,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  reload: { configPrefixes: ["channels.openzalo"] },
  configSchema: buildChannelConfigSchema(OpenzaloConfigSchema),
  config: {
    listAccountIds: (cfg) => listOpenzaloAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
    defaultAccountId: (cfg) => resolveDefaultOpenzaloAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "openzalo",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "openzalo",
        accountId,
        clearBaseFields: ["name", "profile", "zcaBinary"],
      }),
    // Keep startup config static so gateway-level restart/backoff can recover
    // from transient auth/CLI failures after updates or restarts.
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      profile: account.profile,
      zcaBinary: account.zcaBinary,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveAccount(cfg, accountId).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => normalizeOpenzaloAllowEntry(String(entry)))
        .filter(Boolean),
  },
  actions: openzaloMessageActions,
  agentPrompt: {
    messageToolHints: () => [
      "- OpenZalo action workflow: after `message` tool actions like `edit`, `unsend`, `react`, or `unreact`, always send a normal assistant reply that summarizes what you changed.",
      "- OpenZalo `list-group-members`: do not pass `target`/`to`. Use current group context, or pass `groupId` when context is unavailable.",
      "- OpenZalo `member-info`: pass only `userId` (no `target`/`to`).",
      "- Do not reply with `NO_REPLY` after non-send actions. Use `NO_REPLY` only when `action=send` already contains the full user-facing response.",
      "- If an action fails, send a concise failure summary naming the action and error reason.",
      "- Restart recovery: if recent history shows tool actions completed but no assistant confirmation (for example after interruption/restart), send a brief recovery summary of completed and failed actions before handling the new request.",
    ],
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
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("openzalo"),
        normalizeEntry: (raw) => normalizeOpenzaloAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      const hasGroups = Boolean(account.config.groups && Object.keys(account.config.groups).length > 0);
      const hasGroupAllowFrom = Boolean(account.config.groupAllowFrom?.length);

      if (groupPolicy === "open" && !hasGroups && !hasGroupAllowFrom) {
        warnings.push(
          '- OpenZalo groups: groupPolicy="open" with no group restrictions allows all groups (mention-gated). Prefer channels.openzalo.groupPolicy="allowlist".',
        );
      }

      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveAccount(cfg, accountId);
      if (!groupId) {
        return true;
      }
      const match = resolveOpenzaloGroupMatch({
        groups: account.config.groups,
        target: groupId,
      });
      return resolveOpenzaloRequireMention({
        groupConfig: match.groupConfig,
        wildcardConfig: match.wildcardConfig,
      });
    },
    resolveToolPolicy: ({ cfg, accountId, groupId, senderId, senderName, senderUsername, senderE164 }) => {
      const account = resolveAccount(cfg, accountId);
      if (!groupId) {
        return undefined;
      }
      const match = resolveOpenzaloGroupMatch({
        groups: account.config.groups,
        target: groupId,
      });
      return resolveOpenzaloGroupToolPolicy({
        groupConfig: match.groupConfig,
        wildcardConfig: match.wildcardConfig,
        senderId,
        senderName,
        senderUsername,
        senderE164,
      });
    },
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => {
      const normalizedCurrentChannelId = context.To
        ? normalizeOpenzaloMessagingTarget(context.To.trim())
        : "";
      return {
        currentChannelId: normalizedCurrentChannelId || context.To?.trim() || undefined,
        currentThreadTs:
          context.MessageSidFull ??
          context.MessageSid ??
          context.ReplyToIdFull ??
          context.ReplyToId,
        hasRepliedRef,
      };
    },
  },
  messaging: {
    normalizeTarget: normalizeOpenzaloMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeOpenzaloTargetId,
      hint: "<userId|group:groupId>",
    },
  },
  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      return await listOpenzaloDirectorySelf({ account });
    },
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveAccount(cfg, accountId);
      return await listOpenzaloDirectoryPeers({ account, query, limit });
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveAccount(cfg, accountId);
      return await listOpenzaloDirectoryGroups({ account, query, limit });
    },
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) => {
      const account = resolveAccount(cfg, accountId);
      const results = inputs.map((input) => ({
        input,
        resolved: false,
        id: undefined as string | undefined,
        name: undefined as string | undefined,
        note: undefined as string | undefined,
      }));
      const unresolved: Array<{ query: string; index: number }> = [];

      for (const [index, input] of inputs.entries()) {
        const trimmed = input.trim();
        if (!trimmed) {
          results[index]!.note = "empty input";
          continue;
        }
        if (kind === "user") {
          const normalized = normalizeResolvedUserTarget(trimmed);
          if (normalized) {
            results[index] = {
              input,
              resolved: true,
              id: normalized,
            };
            continue;
          }
          unresolved.push({ query: trimmed, index });
          continue;
        }
        const normalizedGroup = normalizeResolvedGroupTarget(trimmed);
        if (normalizedGroup) {
          results[index] = {
            input,
            resolved: true,
            id: normalizedGroup,
          };
          continue;
        }
        unresolved.push({ query: trimmed, index });
      }

      if (unresolved.length === 0) {
        return results;
      }

      try {
        if (kind === "user") {
          const peers = await listOpenzaloDirectoryPeers({
            account,
          });
          for (const pending of unresolved) {
            const match = chooseDirectoryMatch({
              query: pending.query,
              entries: peers.map((entry) => ({ id: entry.id, name: entry.name })),
            });
            if (!match.best) {
              results[pending.index]!.note = "no user match";
              continue;
            }
            results[pending.index] = {
              input: results[pending.index]!.input,
              resolved: true,
              id: match.best.id,
              name: match.best.name,
              ...(match.ambiguous ? { note: "multiple matches; chose first" } : {}),
            };
          }
          return results;
        }

        const groups = await listOpenzaloDirectoryGroups({
          account,
        });
        for (const pending of unresolved) {
          const match = chooseDirectoryMatch({
            query: pending.query,
            entries: groups.map((entry) => ({ id: entry.id, name: entry.name })),
          });
          if (!match.best) {
            results[pending.index]!.note = "no group match";
            continue;
          }
          results[pending.index] = {
            input: results[pending.index]!.input,
            resolved: true,
            id: `group:${match.best.id}`,
            name: match.best.name,
            ...(match.ambiguous ? { note: "multiple matches; chose first" } : {}),
          };
        }
        return results;
      } catch (err) {
        runtime.error?.(`openzalo resolve failed: ${String(err)}`);
        for (const pending of unresolved) {
          results[pending.index]!.note = "lookup failed";
        }
        return results;
      }
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "openzalo",
        accountId,
        name,
      }),
    validateInput: () => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "openzalo",
        accountId,
        name: input.name,
      }) as CoreConfig;
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? (migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "openzalo",
            }) as CoreConfig)
          : namedConfig;
      const binaryPath = input.cliPath?.trim();

      if (accountId === DEFAULT_ACCOUNT_ID) {
        const existingProfile = next.channels?.openzalo?.profile?.trim();
        return {
          ...next,
          channels: {
            ...next.channels,
            openzalo: {
              ...next.channels?.openzalo,
              enabled: true,
              profile: existingProfile || accountId,
              ...(binaryPath ? { zcaBinary: binaryPath } : {}),
            },
          },
        };
      }

      const existingAccountProfile = next.channels?.openzalo?.accounts?.[accountId]?.profile?.trim();
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
                profile: existingAccountProfile || accountId,
                ...(binaryPath ? { zcaBinary: binaryPath } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getOpenzaloRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 1800,
    resolveTarget: ({ to }) => {
      try {
        const parsed = parseOpenzaloTarget(to);
        return {
          ok: true,
          to: parsed.isGroup ? `group:${parsed.threadId}` : `user:${parsed.threadId}`,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      const result = await sendTextOpenzalo({
        cfg: cfg as CoreConfig,
        account,
        to,
        text,
      });
      return {
        channel: "openzalo",
        ...result,
      };
    },
    sendMedia: async (ctx) => {
      const { cfg, to, text, mediaUrl, mediaLocalRoots, accountId } = ctx;
      const { mediaPath } = ctx as { mediaPath?: string };
      const account = resolveAccount(cfg, accountId);
      const mergedMediaLocalRoots = Array.from(
        new Set([
          ...(account.config.mediaLocalRoots ?? []),
          ...(mediaLocalRoots ?? []),
        ]),
      );
      const result = await sendMediaOpenzalo({
        cfg: cfg as CoreConfig,
        account,
        to,
        text,
        mediaUrl,
        mediaPath,
        mediaLocalRoots: mergedMediaLocalRoots.length > 0 ? mergedMediaLocalRoots : undefined,
      });
      return {
        channel: "openzalo",
        ...result,
      };
    },
  },
  auth: {
    login: async ({ cfg, accountId, runtime }) => {
      const account = resolveAccount(cfg, accountId);
      runtime.log(
        `Complete OpenZalo login in this terminal (account: ${account.accountId}, profile: ${account.profile}).`,
      );
      await runOpenzcaInteractive({
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["auth", "login"],
      });
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      profile: null,
      zcaBinary: null,
    },
    collectStatusIssues: collectOpenzaloStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      profile: snapshot.profile ?? null,
      zcaBinary: snapshot.zcaBinary ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      await probeOpenzaloAuth({ account, timeoutMs }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      profile: account.profile,
      zcaBinary: account.zcaBinary,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
    resolveAccountState: ({ enabled, configured }) =>
      resolveOpenzaloAccountState({ enabled, configured }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        profile: account.profile,
        zcaBinary: account.zcaBinary,
      });
      ctx.log?.info(
        `[${account.accountId}] starting provider (profile=${account.profile}, binary=${account.zcaBinary})`,
      );
      return await monitorOpenzaloProvider({
        account,
        cfg: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
    logoutAccount: async ({ cfg, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      const result = await probeOpenzaloAuth({ account, timeoutMs: 5_000, forceRefresh: true });
      if (!result.ok) {
        return { cleared: false, loggedOut: true };
      }

      try {
        await runOpenzcaCommand({
          binary: account.zcaBinary,
          profile: account.profile,
          args: ["auth", "logout"],
          timeoutMs: 10_000,
        });
        return { cleared: true, loggedOut: true };
      } catch {
        return { cleared: false, loggedOut: false };
      }
    },
  },
};

export { handleOpenzaloInbound };
