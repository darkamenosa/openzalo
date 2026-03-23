export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
export {
  MarkdownConfigSchema,
  ToolPolicySchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
export { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
export { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
export { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
export {
  DEFAULT_ACCOUNT_ID,
  applyAccountNameToChannelSection,
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
