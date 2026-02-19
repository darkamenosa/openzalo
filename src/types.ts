import type {
  BaseProbeResult,
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk";

export type OpenzaloGroupConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  skills?: string[];
  systemPrompt?: string;
};

export type OpenzaloActionConfig = {
  reactions?: boolean;
  messages?: boolean;
  groups?: boolean;
  pins?: boolean;
  memberInfo?: boolean;
};

export type OpenzaloAccountConfig = {
  name?: string;
  enabled?: boolean;
  profile?: string;
  zcaBinary?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, OpenzaloGroupConfig>;
  markdown?: MarkdownConfig;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  mediaMaxMb?: number;
  mediaLocalRoots?: string[];
  sendTypingIndicators?: boolean;
  actions?: OpenzaloActionConfig;
};

export type OpenzaloConfig = OpenzaloAccountConfig & {
  accounts?: Record<string, OpenzaloAccountConfig>;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    openzalo?: OpenzaloConfig;
  };
};

export type ResolvedOpenzaloAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  profile: string;
  zcaBinary: string;
  configured: boolean;
  config: OpenzaloAccountConfig;
};

export type OpenzaloProbe = BaseProbeResult<string> & {
  profile: string;
  binary: string;
};

export type OpenzcaRawPayload = Record<string, unknown>;

export type OpenzaloInboundMessage = {
  messageId: string;
  msgId?: string;
  cliMsgId?: string;
  threadId: string;
  toId?: string;
  dmPeerId?: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  quoteMsgId?: string;
  quoteCliMsgId?: string;
  quoteSender?: string;
  quoteText?: string;
  mentionIds: string[];
  mediaPaths: string[];
  mediaUrls: string[];
  mediaTypes: string[];
  raw: OpenzcaRawPayload;
};
