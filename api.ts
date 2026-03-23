import type {
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginRuntime,
  ReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { WizardPrompter } from "openclaw/plugin-sdk";

export type {
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginRuntime,
  ReplyPayload,
  RuntimeEnv,
  WizardPrompter,
};

export type BaseProbeResult<TLastError = string> = {
  ok: boolean;
  status: "ok" | "error";
  lastError?: TLastError | null;
};

export type ChannelStatusIssue = {
  channel: string;
  accountId?: string;
  kind: "config" | "runtime" | string;
  message: string;
  fix?: string;
};
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
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type GroupPolicy = "open" | "disabled" | "allowlist";
export type GroupToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
};
export type GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig>;
export type ChannelSetupDmPolicy = {
  label: string;
  channel: string;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: OpenClawConfig) => DmPolicy;
  setPolicy: (cfg: OpenClawConfig, policy: DmPolicy) => OpenClawConfig;
  promptAllowFrom?: (params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    accountId?: string;
  }) => Promise<OpenClawConfig>;
};

type ZodSchemaWithToJsonSchema = {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  configSchema?: { schema: Record<string, unknown> };
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
};

type StringParamOptions = {
  required?: boolean;
  trim?: boolean;
  label?: string;
  allowEmpty?: boolean;
};

type ToolInputErrorLike = Error & { status?: number };

export const DEFAULT_ACCOUNT_ID = "default";
export const PAIRING_APPROVED_MESSAGE =
  "✅ OpenClaw access approved. Send a message to start chatting.";
const DOCS_ROOT = "https://docs.openclaw.ai";

function createToolInputError(message: string): ToolInputErrorLike {
  const error = new Error(message) as ToolInputErrorLike;
  error.name = "ToolInputError";
  error.status = 400;
  return error;
}

function toSnakeCaseKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function readParamRaw(params: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(params, key)) {
    return params[key];
  }
  const snakeKey = toSnakeCaseKey(key);
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
    return params[snakeKey];
  }
  return undefined;
}

type ChannelSectionBase = {
  name?: string;
  defaultAccount?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

type ChannelSection = {
  accounts?: Record<string, Record<string, unknown>>;
  enabled?: boolean;
};

function normalizeCanonicalAccountId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_ACCOUNT_ID;
  }
  return normalizeCanonicalAccountId(trimmed) || DEFAULT_ACCOUNT_ID;
}

function channelHasAccounts(cfg: OpenClawConfig, channelKey: string): boolean {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[channelKey] as ChannelSectionBase | undefined;
  return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}

function shouldStoreNameInAccounts(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  alwaysUseAccounts?: boolean;
}): boolean {
  if (params.alwaysUseAccounts) {
    return true;
  }
  if (params.accountId !== DEFAULT_ACCOUNT_ID) {
    return true;
  }
  return channelHasAccounts(params.cfg, params.channelKey);
}

export function buildChannelConfigSchema(schema: ZodSchemaWithToJsonSchema): {
  schema: Record<string, unknown>;
} {
  if (typeof schema?.toJSONSchema === "function") {
    return {
      schema: schema.toJSONSchema({
        target: "draft-07",
        unrepresentable: "any",
      }) as Record<string, unknown>,
    };
  }
  return {
    schema: {
      type: "object",
      additionalProperties: true,
    },
  };
}

export function defineChannelPluginEntry<TPlugin>(params: {
  id: string;
  name: string;
  description: string;
  plugin: TPlugin;
  configSchema?: { schema: Record<string, unknown> };
  setRuntime?: (runtime: PluginRuntime) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
}): OpenClawPluginDefinition {
  return {
    id: params.id,
    name: params.name,
    description: params.description,
    ...(params.configSchema ? { configSchema: params.configSchema } : {}),
    register(api) {
      params.setRuntime?.(api.runtime);
      api.registerChannel({ plugin: params.plugin as ChannelPlugin });
      if (api.registrationMode !== "full") {
        return;
      }
      params.registerFull?.(api);
    },
  };
}

export function defineSetupPluginEntry<TPlugin>(plugin: TPlugin) {
  return { plugin };
}

export function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return params.cfg;
  }
  const accountId = normalizeAccountId(params.accountId);
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const baseConfig = channels?.[params.channelKey];
  const base =
    typeof baseConfig === "object" && baseConfig ? (baseConfig as ChannelSectionBase) : undefined;
  const useAccounts = shouldStoreNameInAccounts({
    cfg: params.cfg,
    channelKey: params.channelKey,
    accountId,
    alwaysUseAccounts: params.alwaysUseAccounts,
  });
  if (!useAccounts && accountId === DEFAULT_ACCOUNT_ID) {
    const safeBase = base ?? {};
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: {
          ...safeBase,
          name: trimmed,
        },
      },
    } as OpenClawConfig;
  }
  const baseAccounts: Record<string, Record<string, unknown>> = base?.accounts ?? {};
  const existingAccount = baseAccounts[accountId] ?? {};
  const baseWithoutName =
    accountId === DEFAULT_ACCOUNT_ID
      ? (({ name: _ignored, ...rest }) => rest)(base ?? {})
      : (base ?? {});
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...baseWithoutName,
        accounts: {
          ...baseAccounts,
          [accountId]: {
            ...existingAccount,
            name: trimmed,
          },
        },
      },
    },
  } as OpenClawConfig;
}

export function migrateBaseNameToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  if (params.alwaysUseAccounts) {
    return params.cfg;
  }
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.channelKey] as ChannelSectionBase | undefined;
  const baseName = base?.name?.trim();
  if (!baseName) {
    return params.cfg;
  }
  const accounts: Record<string, Record<string, unknown>> = {
    ...base?.accounts,
  };
  const defaultAccount = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  if (!defaultAccount.name) {
    accounts[DEFAULT_ACCOUNT_ID] = { ...defaultAccount, name: baseName };
  }
  const { name: _ignored, ...rest } = base ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...rest,
        accounts,
      },
    },
  } as OpenClawConfig;
}

export function setAccountEnabledInConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): OpenClawConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.sectionKey] as ChannelSection | undefined;
  const hasAccounts = Boolean(base?.accounts);
  if (params.allowTopLevel && accountKey === DEFAULT_ACCOUNT_ID && !hasAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...base,
          enabled: params.enabled,
        },
      },
    } as OpenClawConfig;
  }

  const baseAccounts = base?.accounts ?? {};
  const existing = baseAccounts[accountKey] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.sectionKey]: {
        ...base,
        accounts: {
          ...baseAccounts,
          [accountKey]: {
            ...existing,
            enabled: params.enabled,
          },
        },
      },
    },
  } as OpenClawConfig;
}

export function deleteAccountFromConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): OpenClawConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.sectionKey] as ChannelSection | undefined;
  if (!base) {
    return params.cfg;
  }

  const baseAccounts =
    base.accounts && typeof base.accounts === "object" ? { ...base.accounts } : undefined;

  if (accountKey !== DEFAULT_ACCOUNT_ID) {
    const accounts = baseAccounts ? { ...baseAccounts } : {};
    delete accounts[accountKey];
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...base,
          accounts: Object.keys(accounts).length ? accounts : undefined,
        },
      },
    } as OpenClawConfig;
  }

  if (baseAccounts && Object.keys(baseAccounts).length > 0) {
    delete baseAccounts[accountKey];
    const baseRecord = { ...(base as Record<string, unknown>) };
    for (const field of params.clearBaseFields ?? []) {
      if (field in baseRecord) {
        baseRecord[field] = undefined;
      }
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...baseRecord,
          accounts: Object.keys(baseAccounts).length ? baseAccounts : undefined,
        },
      },
    } as OpenClawConfig;
  }

  const nextChannels = { ...params.cfg.channels } as Record<string, unknown>;
  delete nextChannels[params.sectionKey];
  const nextCfg = { ...params.cfg } as OpenClawConfig;
  if (Object.keys(nextChannels).length > 0) {
    nextCfg.channels = nextChannels as OpenClawConfig["channels"];
  } else {
    delete nextCfg.channels;
  }
  return nextCfg;
}

export function formatPairingApproveHint(channelId: string): string {
  return `Approve via: openclaw pairing list ${channelId} / openclaw pairing approve ${channelId} <code>`;
}

export function addWildcardAllowFrom(allowFrom?: Array<string | number> | null): string[] {
  const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (!next.includes("*")) {
    next.push("*");
  }
  return next;
}

export function mergeAllowFromEntries(
  current: Array<string | number> | null | undefined,
  additions: Array<string | number>,
): string[] {
  const merged = [...(current ?? []), ...additions].map((v) => String(v).trim()).filter(Boolean);
  return [...new Set(merged)];
}

export function formatDocsLink(path: string, label?: string): string {
  const trimmed = path.trim();
  const url = trimmed.startsWith("http")
    ? trimmed
    : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  return label ? `${label}: ${url}` : url;
}

export async function promptAccountId(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  label: string;
  currentId?: string;
  listAccountIds: (cfg: OpenClawConfig) => string[];
  defaultAccountId?: string;
}): Promise<string> {
  const existingIds = params.listAccountIds(params.cfg);
  const initial = params.currentId?.trim() || params.defaultAccountId || DEFAULT_ACCOUNT_ID;
  const choice = await params.prompter.select({
    message: `${params.label} account`,
    options: [
      ...existingIds.map((id) => ({
        value: id,
        label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
      })),
      { value: "__new__", label: "Add a new account" },
    ],
    initialValue: initial,
  });

  if (choice !== "__new__") {
    return normalizeAccountId(choice);
  }

  const entered = await params.prompter.text({
    message: `New ${params.label} account id`,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const normalized = normalizeAccountId(String(entered));
  if (String(entered).trim() !== normalized) {
    await params.prompter.note(
      `Normalized account id to "${normalized}".`,
      `${params.label} account`,
    );
  }
  return normalized;
}

export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions & { required: true },
): string;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: StringParamOptions,
): string | undefined;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions = {},
) {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = readParamRaw(params, key);
  if (typeof raw !== "string") {
    if (required) {
      throw createToolInputError(`${label} required`);
    }
    return undefined;
  }
  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) {
      throw createToolInputError(`${label} required`);
    }
    return undefined;
  }
  return value;
}

export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string; integer?: boolean; strict?: boolean } = {},
): number | undefined {
  const { required = false, label = key, integer = false, strict = false } = options;
  const raw = readParamRaw(params, key);
  let value: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      const parsed = strict ? Number(trimmed) : Number.parseFloat(trimmed);
      if (Number.isFinite(parsed)) {
        value = parsed;
      }
    }
  }
  if (value === undefined) {
    if (required) {
      throw createToolInputError(`${label} required`);
    }
    return undefined;
  }
  return integer ? Math.trunc(value) : value;
}

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

export function createChannelReplyPipeline(_params: {
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
    ...(_params.typingCallbacks ? { typingCallbacks: _params.typingCallbacks } : {}),
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
