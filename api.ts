export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
export {
  DEFAULT_ACCOUNT_ID,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  defineChannelPluginEntry,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type PluginRuntime,
} from "openclaw/plugin-sdk/core";
export { readNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
export type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export {
  addWildcardAllowFrom,
  formatDocsLink,
  mergeAllowFromEntries,
  promptAccountId,
  type ChannelSetupDmPolicy,
  type DmPolicy,
  type GroupPolicy,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";

export type ChannelAccountState =
  | "linked"
  | "not linked"
  | "configured"
  | "not configured"
  | "enabled"
  | "disabled";
export type BlockStreamingCoalesceConfig = {
  minChars?: number;
  maxChars?: number;
  idleMs?: number;
};
export type MarkdownTableMode = "off" | "bullets" | "code";
export type MarkdownConfig = {
  tables?: MarkdownTableMode;
};
export type DmConfig = {
  historyLimit?: number;
};
export type GroupToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
};
export type GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig>;
export const PAIRING_APPROVED_MESSAGE =
  "✅ OpenClaw access approved. Send a message to start chatting.";

export function logInboundDrop(params: {
  log: (message: string) => void;
  channel: string;
  reason: string;
  target?: string;
}): void {
  const target = params.target ? ` target=${params.target}` : "";
  params.log(`${params.channel}: drop ${params.reason}${target}`);
}

export function resolveControlCommandGate(params: {
  useAccessGroups: boolean;
  authorizers: Array<{ configured: boolean; allowed: boolean }>;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
}): { commandAuthorized: boolean; shouldBlock: boolean } {
  const mode = params.modeWhenAccessGroupsOff ?? "allow";
  const commandAuthorized = params.useAccessGroups
    ? params.authorizers.some((entry) => entry.configured && entry.allowed)
    : mode === "allow"
      ? true
      : mode === "deny"
        ? false
        : params.authorizers.some((entry) => entry.configured)
          ? params.authorizers.some((entry) => entry.configured && entry.allowed)
          : true;
  return {
    commandAuthorized,
    shouldBlock: params.allowTextCommands && params.hasControlCommand && !commandAuthorized,
  };
}

export function createChannelPairingController(params: {
  core: PluginRuntime;
  channel: string;
  accountId: string;
}) {
  const accountId = normalizeAccountId(params.accountId);
  return {
    accountId,
    readAllowFromStore: () =>
      params.core.channel.pairing.readAllowFromStore({
        channel: params.channel,
        accountId,
      }),
    readStoreForDmPolicy: (provider: string, providerAccountId: string) =>
      params.core.channel.pairing.readAllowFromStore({
        channel: provider,
        accountId: normalizeAccountId(providerAccountId),
      }),
    upsertPairingRequest: (
      input: Omit<
        Parameters<PluginRuntime["channel"]["pairing"]["upsertPairingRequest"]>[0],
        "channel" | "accountId"
      >,
    ) =>
      params.core.channel.pairing.upsertPairingRequest({
        channel: params.channel,
        accountId,
        ...input,
      }),
  };
}

type ReplyPrefixContext = {
  identityName?: string;
  provider?: string;
  model?: string;
  modelFull?: string;
  thinkingLevel?: string;
};

type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  onCleanup?: () => void;
};

export function createChannelReplyPipeline(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
  typingCallbacks?: TypingCallbacks;
}): {
  responsePrefix?: string;
  enableSlackInteractiveReplies?: boolean;
  responsePrefixContextProvider: () => ReplyPrefixContext;
  onModelSelected: (ctx: {
    provider?: string;
    model?: string;
    thinkLevel?: string;
  }) => void;
  typingCallbacks?: TypingCallbacks;
} {
  const prefixContext: ReplyPrefixContext = {};
  return {
    responsePrefix: undefined,
    enableSlackInteractiveReplies: undefined,
    responsePrefixContextProvider: () => prefixContext,
    onModelSelected: (ctx) => {
      prefixContext.provider = ctx.provider;
      prefixContext.model = ctx.model;
      prefixContext.modelFull =
        ctx.provider && ctx.model ? `${ctx.provider}/${ctx.model}` : undefined;
      prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
    },
    ...(params.typingCallbacks ? { typingCallbacks: params.typingCallbacks } : {}),
  };
}

export function createActionGate<T extends Record<string, boolean | undefined>>(
  actions: T | undefined,
): (key: keyof T, defaultValue?: boolean) => boolean {
  return (key, defaultValue = true) => {
    const value = actions?.[key];
    if (value === undefined) {
      return defaultValue;
    }
    return value !== false;
  };
}

export function jsonResult<T>(payload: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}
