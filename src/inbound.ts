import {
  createReplyPrefixOptions,
  logInboundDrop,
  resolveControlCommandGate,
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import {
  appendOpenzaloPendingGroupHistoryEntry,
  buildOpenzaloPendingGroupHistoryKey,
  buildOpenzaloPendingHistoryContext,
  clearOpenzaloPendingGroupHistory,
  DEFAULT_OPENZALO_PENDING_GROUP_HISTORY_LIMIT,
  readOpenzaloPendingGroupHistoryEntries,
  type OpenzaloPendingGroupHistoryEntry,
} from "./pending-history.js";
import {
  formatOpenzaloMessageSidFull,
  rememberOpenzaloMessage,
  resolveOpenzaloMessageRef,
} from "./message-refs.js";
import { resolveOpenzaloBoundSessionByTarget } from "./subagent-bindings.js";
import {
  formatOpenzaloOutboundTarget,
  normalizeOpenzaloAllowEntry,
  parseOpenzaloTarget,
  resolveOpenzaloDirectPeerId,
} from "./normalize.js";
import { getOpenzaloRuntime } from "./runtime.js";
import { sendMediaOpenzalo, sendTextOpenzalo, sendTypingOpenzalo, type OpenzaloSendReceipt } from "./send.js";
import {
  allowlistHasEntry,
  normalizeAllowlist,
  resolveOpenzaloGroupAccessGate,
  resolveOpenzaloGroupCommandAuthorizers,
  resolveOpenzaloGroupMatch,
  resolveOpenzaloGroupSenderAllowed,
  resolveOpenzaloRequireMention,
} from "./policy.js";
import {
  acquireOpenzaloOutboundDedupeSlot,
  releaseOpenzaloOutboundDedupeSlot,
} from "./outbound-dedupe.js";
import type { CoreConfig, OpenzaloInboundMessage, ResolvedOpenzaloAccount } from "./types.js";

const CHANNEL_ID = "openzalo" as const;
const DEFAULT_GROUP_SYSTEM_PROMPT =
  "When sending media/files in this same group, never claim success unless media is actually attached. " +
  "Prefer MEDIA:./relative-path or MEDIA:https://... in your reply text. " +
  "If the source file is outside workspace, copy it into workspace first and then use a relative MEDIA path.";

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function nextOpenzaloOutboundSequence(map: Map<string, number>, key: string): number {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}

function resolveAgentIdFromSessionKey(sessionKey: string): string | null {
  const match = sessionKey.trim().match(/^agent:([^:]+):/i);
  const agentId = match?.[1]?.trim();
  if (!agentId) {
    return null;
  }
  return agentId;
}

function resolveOpenzaloPendingGroupHistoryLimit(params: {
  accountHistoryLimit?: number;
  globalHistoryLimit?: number;
}): number {
  const configuredLimit =
    typeof params.accountHistoryLimit === "number"
      ? params.accountHistoryLimit
      : typeof params.globalHistoryLimit === "number"
        ? params.globalHistoryLimit
        : DEFAULT_OPENZALO_PENDING_GROUP_HISTORY_LIMIT;
  return Math.max(0, Math.floor(configuredLimit));
}

function buildOpenzaloGroupSenderLabel(message: OpenzaloInboundMessage): string {
  if (message.senderName) {
    return `${message.senderName} (${message.senderId})`;
  }
  return message.senderId;
}

function buildOpenzaloPendingGroupHistoryEntry(params: {
  message: OpenzaloInboundMessage;
  rawBody: string;
}): OpenzaloPendingGroupHistoryEntry {
  return {
    sender: buildOpenzaloGroupSenderLabel(params.message),
    body: params.rawBody || "[media attached]",
    timestamp: params.message.timestamp,
    messageId: params.message.messageId,
    mediaPaths: params.message.mediaPaths.slice(),
    mediaUrls: params.message.mediaUrls.slice(),
    mediaTypes: params.message.mediaTypes.slice(),
  };
}

function resolveOpenzaloCommandBody(params: {
  rawBody: string;
  mentionRegexes: RegExp[];
}): string {
  const trimmed = params.rawBody.trim();
  if (!trimmed) {
    return "";
  }
  if (/^[/!]/.test(trimmed)) {
    return trimmed;
  }

  let rest = trimmed;
  let strippedMention = false;

  for (let i = 0; i < 3; i += 1) {
    let matched = false;
    for (const mentionRegex of params.mentionRegexes) {
      try {
        const flags = mentionRegex.flags.includes("i") ? "i" : "";
        const anchored = new RegExp(`^(?:${mentionRegex.source})(?:[\\s,:;|.-]+|$)`, flags);
        if (!anchored.test(rest)) {
          continue;
        }
        rest = rest.replace(anchored, "").trimStart();
        strippedMention = true;
        matched = true;
        break;
      } catch {
        continue;
      }
    }
    if (!matched) {
      break;
    }
  }

  if (!strippedMention) {
    const genericMentionPrefix = rest.match(/^@\S+(?:[,:;|.-]+|\s+)/);
    if (genericMentionPrefix) {
      rest = rest.slice(genericMentionPrefix[0].length).trimStart();
      strippedMention = true;
    } else {
      // Support attached mention commands like "@Bot/new" in group chats.
      const attachedCommand = rest.match(/^@\S*([/!].*)$/);
      if (attachedCommand?.[1]) {
        rest = attachedCommand[1].trimStart();
        strippedMention = true;
      }
    }
  }

  if (strippedMention && /^[/!]/.test(rest)) {
    return rest;
  }
  return trimmed;
}

function buildOutboundMessageEventText(params: {
  shortId: string;
  preview?: string;
  msgId?: string;
  cliMsgId?: string;
}): string {
  const refs = [
    `[message_id:${params.shortId}]`,
    params.msgId ? `[msg_id:${params.msgId}]` : "",
    params.cliMsgId ? `[cli_msg_id:${params.cliMsgId}]` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const preview = (params.preview ?? "").replace(/\s+/g, " ").trim();
  if (!preview) {
    return `Assistant sent ${refs}`;
  }
  const clipped = preview.length > 80 ? `${preview.slice(0, 80)}...` : preview;
  return `Assistant sent "${clipped}" ${refs}`;
}

function logOpenzaloGroupAllowlistHint(params: {
  runtime: RuntimeEnv;
  reason: string;
  threadId: string;
  accountId: string;
}): void {
  const log = params.runtime.log;
  log?.(
    `[openzalo] group message blocked (${params.reason}) for ${params.threadId}. ` +
      `Allow this group with channels.openzalo.groups.${params.threadId} or channels.openzalo.groupAllowFrom=["${params.threadId}"].`,
  );
  log?.(
    `[openzalo] account override path: channels.openzalo.accounts.${params.accountId}.groups.${params.threadId} ` +
      `or channels.openzalo.accounts.${params.accountId}.groupAllowFrom=["${params.threadId}"].`,
  );
}

function logOpenzaloGroupSenderAllowHint(params: {
  runtime: RuntimeEnv;
  threadId: string;
  senderId: string;
  accountId: string;
}): void {
  const log = params.runtime.log;
  log?.(
    `[openzalo] sender ${params.senderId} blocked in group ${params.threadId}. ` +
      `Allow sender with channels.openzalo.groups.${params.threadId}.allowFrom=["${params.senderId}"].`,
  );
  log?.(
    `[openzalo] account override path: channels.openzalo.accounts.${params.accountId}.groups.${params.threadId}.allowFrom=["${params.senderId}"].`,
  );
}

function logOpenzaloCommandAllowHint(params: {
  runtime: RuntimeEnv;
  threadId: string;
  senderId: string;
  accountId: string;
}): void {
  const log = params.runtime.log;
  log?.(
    `[openzalo] control command blocked in group ${params.threadId} from ${params.senderId}. ` +
      `Authorize command senders via channels.openzalo.allowFrom or channels.openzalo.groups.${params.threadId}.allowFrom.`,
  );
  log?.(
    `[openzalo] account override path: channels.openzalo.accounts.${params.accountId}.allowFrom ` +
      `or channels.openzalo.accounts.${params.accountId}.groups.${params.threadId}.allowFrom.`,
  );
}

async function deliverOpenzaloReply(params: {
  payload: ReplyPayload;
  target: string;
  sessionKey: string;
  account: ResolvedOpenzaloAccount;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<OpenzaloSendReceipt[]> {
  const { payload, target, sessionKey, account, cfg, runtime, statusSink } = params;
  const receipts: OpenzaloSendReceipt[] = [];
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  const text = payload.text?.trim() ?? "";

  if (!text && mediaList.length === 0) {
    return receipts;
  }

  if (mediaList.length > 0) {
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? text : undefined;
      const dedupe = acquireOpenzaloOutboundDedupeSlot({
        accountId: account.accountId,
        sessionKey,
        target,
        kind: "media",
        text: caption,
        mediaRef: mediaUrl,
      });
      if (!dedupe.acquired) {
        runtime.log?.(
          `[${account.accountId}] openzalo skip duplicate media send (${dedupe.reason}) target=${target}`,
        );
        continue;
      }

      let sent = false;
      try {
        const result = await sendMediaOpenzalo({
          cfg,
          account,
          to: target,
          mediaUrl,
          text: caption,
          mediaLocalRoots: account.config.mediaLocalRoots,
        });
        receipts.push(...(result.receipts.length > 0 ? result.receipts : [result]));
        sent = true;
        first = false;
        statusSink?.({ lastOutboundAt: Date.now() });
      } finally {
        releaseOpenzaloOutboundDedupeSlot({
          ticket: dedupe.ticket,
          sent,
        });
      }
    }
    return receipts;
  }

  if (text) {
    const limit = account.config.textChunkLimit && account.config.textChunkLimit > 0
      ? account.config.textChunkLimit
      : 1800;
    const chunkMode = account.config.chunkMode ?? "length";
    const core = getOpenzaloRuntime();
    const chunks =
      chunkMode === "newline"
        ? core.channel.text.chunkTextWithMode(text, limit, chunkMode)
        : core.channel.text.chunkMarkdownText(text, limit);
    const finalChunks = chunks.length > 0 ? chunks : [text];
    const textSequenceByChunk = new Map<string, number>();

    for (const chunk of finalChunks) {
      const sequence = nextOpenzaloOutboundSequence(textSequenceByChunk, chunk);
      const dedupe = acquireOpenzaloOutboundDedupeSlot({
        accountId: account.accountId,
        sessionKey,
        target,
        kind: "text",
        text: chunk,
        sequence,
      });
      if (!dedupe.acquired) {
        runtime.log?.(
          `[${account.accountId}] openzalo skip duplicate text send (${dedupe.reason}) target=${target}`,
        );
        continue;
      }

      let sent = false;
      try {
        const receipt = await sendTextOpenzalo({
          cfg,
          account,
          to: target,
          text: chunk,
        });
        receipts.push(receipt);
        sent = true;
        statusSink?.({ lastOutboundAt: Date.now() });
      } finally {
        releaseOpenzaloOutboundDedupeSlot({
          ticket: dedupe.ticket,
          sent,
        });
      }
    }
  }

  return receipts;
}

export async function handleOpenzaloInbound(params: {
  message: OpenzaloInboundMessage;
  account: ResolvedOpenzaloAccount;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  botUserId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, cfg, runtime, botUserId, statusSink } = params;
  const core = getOpenzaloRuntime();
  const directPeerId = message.isGroup
    ? ""
    : resolveOpenzaloDirectPeerId({
        dmPeerId: message.dmPeerId,
        senderId: message.senderId,
        toId: message.toId,
        threadId: message.threadId,
      }) || message.senderId;
  const targetThreadId = message.isGroup ? message.threadId : directPeerId;
  const outboundTarget = formatOpenzaloOutboundTarget({
    threadId: targetThreadId,
    isGroup: message.isGroup,
  });

  const rawBody = message.text.trim();
  const hasMedia = message.mediaUrls.length > 0 || message.mediaPaths.length > 0;
  if (!rawBody && !hasMedia) {
    return;
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const groupHistoryLimit = message.isGroup
    ? resolveOpenzaloPendingGroupHistoryLimit({
        accountHistoryLimit: account.config.historyLimit,
        globalHistoryLimit: cfg.messages?.groupChat?.historyLimit,
      })
    : 0;
  const groupHistoryKey =
    message.isGroup && groupHistoryLimit > 0
      ? buildOpenzaloPendingGroupHistoryKey({
          accountId: account.accountId,
          threadId: message.threadId,
        })
      : "";

  const configAllowFrom = normalizeAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch(() => []);
  const storeAllowlist = normalizeAllowlist(storeAllowFrom);

  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowlist].filter(Boolean);
  const effectiveGroupAllowFrom = [...configGroupAllowFrom, ...storeAllowlist].filter(Boolean);

  const groupMatch = resolveOpenzaloGroupMatch({
    groups: account.config.groups,
    target: message.threadId,
  });

  const senderAllowedDm = allowlistHasEntry(effectiveAllowFrom, message.senderId);

  if (message.isGroup) {
    const groupGate = resolveOpenzaloGroupAccessGate({
      groupPolicy,
      groupAllowFrom: effectiveGroupAllowFrom,
      groupMatch,
      target: message.threadId,
    });
    if (!groupGate.allowed) {
      runtime.log?.(`openzalo: drop group ${message.threadId} (${groupGate.reason})`);
      logOpenzaloGroupAllowlistHint({
        runtime,
        reason: groupGate.reason,
        threadId: message.threadId,
        accountId: account.accountId,
      });
      return;
    }

    const senderAllowed = resolveOpenzaloGroupSenderAllowed({
      groupPolicy,
      senderId: message.senderId,
      groupConfig: groupMatch.groupConfig,
      wildcardConfig: groupMatch.wildcardConfig,
    });
    if (!senderAllowed) {
      runtime.log?.(`openzalo: drop group sender ${message.senderId} (not allowlisted)`);
      logOpenzaloGroupSenderAllowHint({
        runtime,
        threadId: message.threadId,
        senderId: message.senderId,
        accountId: account.accountId,
      });
      return;
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`openzalo: drop DM sender=${message.senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open" && !senderAllowedDm) {
      if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: CHANNEL_ID,
          id: message.senderId,
          meta: { name: message.senderName },
        });
        if (created) {
          try {
            const pairingReply = core.channel.pairing.buildPairingReply({
              channel: CHANNEL_ID,
              idLine: `Your OpenZalo sender id: ${message.senderId}`,
              code,
            });
            await sendTextOpenzalo({
              cfg,
              account,
              to: message.senderId,
              text: pairingReply,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            runtime.error?.(`openzalo pairing reply failed for ${message.senderId}: ${String(err)}`);
          }
        }
      }
      return;
    }
  }

  const defaultRoute = core.channel.routing.resolveAgentRoute({
    cfg: cfg as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: targetThreadId,
    },
  });
  const boundSession = resolveOpenzaloBoundSessionByTarget({
    accountId: account.accountId,
    to: outboundTarget,
  });
  const boundAgentId = boundSession
    ? resolveAgentIdFromSessionKey(boundSession.childSessionKey) ?? boundSession.agentId
    : null;
  const route = boundSession && boundAgentId
    ? {
        ...defaultRoute,
        agentId: boundAgentId,
        sessionKey: boundSession.childSessionKey,
        mainSessionKey: `agent:${boundAgentId}:main`,
      }
    : defaultRoute;
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg as OpenClawConfig, route.agentId);
  const commandBody = message.isGroup
    ? resolveOpenzaloCommandBody({
        rawBody,
        mentionRegexes,
      })
    : rawBody;

  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: cfg as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(commandBody, cfg as OpenClawConfig);
  const commandAuthorizers = message.isGroup
    ? (() => {
        const resolved = resolveOpenzaloGroupCommandAuthorizers({
          senderId: message.senderId,
          ownerAllowFrom: effectiveAllowFrom,
          groupConfig: groupMatch.groupConfig,
          wildcardConfig: groupMatch.wildcardConfig,
        });
        return [resolved.owner, resolved.group];
      })()
    : [
        {
          configured: effectiveAllowFrom.length > 0,
          allowed: senderAllowedDm,
        },
      ];

  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: commandAuthorizers,
    allowTextCommands,
    hasControlCommand,
  });

  if (message.isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: message.senderId,
    });
    logOpenzaloCommandAllowHint({
      runtime,
      threadId: message.threadId,
      senderId: message.senderId,
      accountId: account.accountId,
    });
    return;
  }

  const wasMentionedByPattern =
    message.isGroup && mentionRegexes.length > 0
      ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
      : false;
  const normalizedBotUserId = botUserId ? normalizeOpenzaloAllowEntry(botUserId) : "";
  const mentionedIds = message.mentionIds.map((entry) => normalizeOpenzaloAllowEntry(entry));
  const wasMentionedById =
    message.isGroup && Boolean(normalizedBotUserId)
      ? mentionedIds.includes(normalizedBotUserId)
      : false;
  const wasMentioned = message.isGroup ? wasMentionedByPattern || wasMentionedById : true;
  const canDetectMention = mentionRegexes.length > 0 || Boolean(normalizedBotUserId);
  const requireMention = message.isGroup
    ? resolveOpenzaloRequireMention({
        groupConfig: groupMatch.groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : false;

  if (message.isGroup && requireMention && !wasMentioned) {
    const bypassForCommand = hasControlCommand && allowTextCommands && commandGate.commandAuthorized;
    if (!bypassForCommand) {
      if (groupHistoryKey && groupHistoryLimit > 0) {
        const historyEntry = buildOpenzaloPendingGroupHistoryEntry({
          message,
          rawBody,
        });
        const history = appendOpenzaloPendingGroupHistoryEntry({
          historyKey: groupHistoryKey,
          entry: historyEntry,
          limit: groupHistoryLimit,
        });
        runtime.log?.(
          `openzalo: stored pending group history thread=${message.threadId} ` +
            `entries=${history.length} textLen=${historyEntry.body.length} ` +
            `media=${historyEntry.mediaPaths.length + historyEntry.mediaUrls.length}`,
        );
      }
      if (!canDetectMention) {
        runtime.error?.(
          "openzalo: mention required but detection unavailable " +
            "(missing mention regexes and bot user id); dropping group message",
        );
      } else {
        runtime.log?.(`openzalo: drop group ${message.threadId} (missing mention)`);
      }
      return;
    }
  }

  const peerLabel = message.isGroup
    ? `group:${message.threadId}`
    : message.senderName
      ? `${message.senderName} id:${message.senderId}`
      : message.senderId;

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  let body = core.channel.reply.formatAgentEnvelope({
    channel: "OpenZalo",
    from: peerLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody || "[media attached]",
  });
  const pendingGroupHistory =
    message.isGroup && groupHistoryKey
      ? readOpenzaloPendingGroupHistoryEntries({
          historyKey: groupHistoryKey,
        })
      : [];
  if (message.isGroup && pendingGroupHistory.length > 0) {
    body = buildOpenzaloPendingHistoryContext({
      entries: pendingGroupHistory,
      currentMessage: body,
      formatEntry: (entry) =>
        core.channel.reply.formatAgentEnvelope({
          channel: "OpenZalo",
          from: peerLabel,
          timestamp: entry.timestamp,
          body: entry.body,
          chatType: "group",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
    runtime.log?.(
      `openzalo: injecting pending group history thread=${message.threadId} entries=${pendingGroupHistory.length}`,
    );
  }

  const outboundParsedTarget = parseOpenzaloTarget(outboundTarget);

  const mergedMediaPaths = dedupeStrings([
    ...pendingGroupHistory.flatMap((entry) => entry.mediaPaths),
    ...message.mediaPaths,
  ]);
  const mergedMediaUrls = dedupeStrings([
    ...pendingGroupHistory.flatMap((entry) => entry.mediaUrls),
    ...message.mediaUrls,
  ]);
  const mergedMediaTypes = dedupeStrings([
    ...pendingGroupHistory.flatMap((entry) => entry.mediaTypes),
    ...message.mediaTypes,
  ]);
  const inboundHistory =
    message.isGroup && pendingGroupHistory.length > 0
      ? pendingGroupHistory.map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const rememberedInbound = rememberOpenzaloMessage({
    accountId: account.accountId,
    threadId: targetThreadId,
    isGroup: message.isGroup,
    msgId: message.msgId,
    cliMsgId: message.cliMsgId,
    timestamp: message.timestamp,
    preview: rawBody || undefined,
  });

  let replyToId = formatOpenzaloMessageSidFull({
    msgId: message.quoteMsgId,
    cliMsgId: message.quoteCliMsgId,
  });
  let replyToIdFull = replyToId;
  if (replyToId) {
    const resolvedReply = resolveOpenzaloMessageRef({
      accountId: account.accountId,
      rawId: replyToId,
    });
    const rememberedReply = rememberOpenzaloMessage({
      accountId: account.accountId,
      threadId: targetThreadId,
      isGroup: message.isGroup,
      msgId: resolvedReply.msgId || message.quoteMsgId,
      cliMsgId: resolvedReply.cliMsgId || message.quoteCliMsgId,
      timestamp: message.timestamp - 1,
      preview: message.quoteText,
    });
    if (rememberedReply?.shortId) {
      replyToId = rememberedReply.shortId;
      replyToIdFull = formatOpenzaloMessageSidFull({
        msgId: rememberedReply.msgId,
        cliMsgId: rememberedReply.cliMsgId,
        fallback: replyToIdFull,
      });
    }
  }

  const messageSids = [message.msgId, message.cliMsgId].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const messageSidFull = formatOpenzaloMessageSidFull({
    msgId: message.msgId,
    cliMsgId: message.cliMsgId,
    fallback: message.messageId,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    BodyForCommands: commandBody,
    MediaUrl: mergedMediaUrls[0],
    MediaUrls: mergedMediaUrls.length > 0 ? mergedMediaUrls : undefined,
    MediaPath: mergedMediaPaths[0],
    MediaPaths: mergedMediaPaths.length > 0 ? mergedMediaPaths : undefined,
    MediaType: mergedMediaTypes[0],
    MediaTypes: mergedMediaTypes.length > 0 ? mergedMediaTypes : undefined,
    From: message.isGroup ? `openzalo:group:${message.threadId}` : `openzalo:${message.senderId}`,
    To: outboundTarget,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: peerLabel,
    SenderName: message.senderName,
    SenderId: message.senderId,
    GroupSubject: message.isGroup ? message.threadId : undefined,
    GroupSystemPrompt: message.isGroup
      ? groupMatch.groupConfig?.systemPrompt?.trim() || DEFAULT_GROUP_SYSTEM_PROMPT
      : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.isGroup ? wasMentioned : undefined,
    MessageSid: rememberedInbound?.shortId || message.messageId,
    MessageSidFull: messageSidFull,
    MessageSids: messageSids.length > 0 ? messageSids : undefined,
    ReplyToId: replyToId || undefined,
    ReplyToIdFull: replyToIdFull || undefined,
    ReplyToSender: message.quoteSender,
    ReplyToBody: message.quoteText,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: outboundTarget,
    CommandAuthorized:
      message.isGroup ? commandGate.commandAuthorized : dmPolicy === "open" || senderAllowedDm,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`openzalo: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: cfg as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });
  const onReplyStartTyping =
    account.config.sendTypingIndicators === false
      ? undefined
      : async () => {
          try {
            await sendTypingOpenzalo({
              account,
              to: outboundTarget,
            });
          } catch (err) {
            runtime.error?.(`openzalo typing start failed: ${String(err)}`);
          }
        };

  const dispatchResult = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: cfg as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      onReplyStart: onReplyStartTyping,
      deliver: async (payload) => {
        const receipts = await deliverOpenzaloReply({
          payload,
          target: outboundTarget,
          sessionKey: route.sessionKey,
          account,
          cfg,
          runtime,
          statusSink,
        });

        for (const receipt of receipts) {
          const remembered = rememberOpenzaloMessage({
            accountId: account.accountId,
            threadId: outboundParsedTarget.threadId,
            isGroup: outboundParsedTarget.isGroup,
            msgId: receipt.msgId,
            cliMsgId: receipt.cliMsgId,
            timestamp: Date.now(),
            preview: receipt.textPreview,
          });
          if (!remembered?.shortId) {
            continue;
          }
          core.system.enqueueSystemEvent(
            buildOutboundMessageEventText({
              shortId: remembered.shortId,
              preview: remembered.preview,
              msgId: remembered.msgId,
              cliMsgId: remembered.cliMsgId,
            }),
            {
              sessionKey: route.sessionKey,
              contextKey: `openzalo:outbound:${outboundTarget}:${remembered.msgId || remembered.cliMsgId || remembered.shortId}`,
            },
          );
        }
      },
      onError: (err, info) => {
        runtime.error?.(`openzalo ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      skillFilter: message.isGroup ? groupMatch.groupConfig?.skills : undefined,
      onModelSelected,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
  if (groupHistoryKey && pendingGroupHistory.length > 0) {
    clearOpenzaloPendingGroupHistory(groupHistoryKey);
    runtime.log?.(
      `openzalo: cleared pending group history thread=${message.threadId} ` +
        `consumed=${pendingGroupHistory.length} queuedFinal=${dispatchResult.queuedFinal}`,
    );
  }
}
