// openzca wrapper types
export type ZcaRunOptions = {
  profile?: string;
  cwd?: string;
  timeout?: number;
};

export type ZcaResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ZcaProfile = {
  name: string;
  label?: string;
  isDefault?: boolean;
};

export type ZcaFriend = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type ZcaGroup = {
  groupId: string;
  name: string;
  memberCount?: number;
};

export type ZcaMention = {
  uid?: string;
  pos?: number;
  len?: number;
  type?: number;
  text?: string;
};

export type ZcaQuoteContext = {
  ownerId?: string;
  senderName?: string;
  msg?: string;
  attach?: unknown;
  ts?: number;
  cliMsgId?: string;
  globalMsgId?: string;
  cliMsgType?: string;
  mediaPath?: string;
  mediaPaths?: string[];
  mediaUrl?: string;
  mediaUrls?: string[];
  mediaType?: string;
  mediaTypes?: string[];
};

export type ZcaMessageMetadata = {
  isGroup?: boolean;
  chatType?: string;
  threadId?: string;
  targetId?: string;
  threadName?: string;
  senderName?: string;
  senderDisplayName?: string;
  senderId?: string;
  fromId?: string;
  toId?: string;
  msgType?: string;
  quote?: ZcaQuoteContext;
  quoteMediaPath?: string;
  quoteMediaPaths?: string[];
  quoteMediaUrl?: string;
  quoteMediaUrls?: string[];
  quoteMediaType?: string;
  quoteMediaTypes?: string[];
  timestamp?: number;
  mediaPath?: string;
  mediaPaths?: string[];
  mediaUrl?: string;
  mediaUrls?: string[];
  mediaType?: string;
  mediaTypes?: string[];
  mediaKind?: string;
  mentions?: ZcaMention[];
  mentionIds?: string[];
  mentionCount?: number;
};

export type ZcaMessage = {
  threadId: string;
  targetId?: string;
  conversationId?: string;
  msgId?: string;
  cliMsgId?: string;
  type: number;
  chatType?: string;
  content?: string;
  timestamp: number;
  msgType?: string;
  quote?: ZcaQuoteContext;
  quoteMediaPath?: string;
  quoteMediaPaths?: string[];
  quoteMediaUrl?: string;
  quoteMediaUrls?: string[];
  quoteMediaType?: string;
  quoteMediaTypes?: string[];
  mediaPath?: string;
  mediaPaths?: string[];
  mediaUrl?: string;
  mediaUrls?: string[];
  mediaType?: string;
  mediaTypes?: string[];
  mediaKind?: string;
  mentions?: ZcaMention[];
  mentionIds?: string[];
  metadata?: ZcaMessageMetadata;
  senderId?: string;
  senderName?: string;
  senderDisplayName?: string;
  toId?: string;
  ts?: string;
};

export type ZcaUserInfo = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type CommonOptions = {
  profile?: string;
  json?: boolean;
};

export type SendOptions = CommonOptions & {
  group?: boolean;
};

export type ListenOptions = CommonOptions & {
  raw?: boolean;
  keepAlive?: boolean;
  webhook?: string;
  echo?: boolean;
  prefix?: string;
};

export type OpenzaloGroupConfig = {
  allow?: boolean;
  enabled?: boolean;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  requireMention?: boolean;
};

export type OpenzaloGroupMentionDetectionFailureMode =
  | "allow"
  | "deny"
  | "allow-with-warning";

export type OpenzaloActionsConfig = {
  messages?: boolean;
  reactions?: boolean;
};

export type OpenzaloAccountConfig = {
  enabled?: boolean;
  name?: string;
  profile?: string;
  actions?: OpenzaloActionsConfig;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, OpenzaloGroupConfig>;
  groupRequireMention?: boolean;
  groupMentionDetectionFailure?: OpenzaloGroupMentionDetectionFailureMode;
  historyLimit?: number;
  sendFailureNotice?: boolean;
  sendFailureMessage?: string;
  messagePrefix?: string;
  responsePrefix?: string;
};

export type OpenzaloConfig = {
  enabled?: boolean;
  name?: string;
  profile?: string;
  actions?: OpenzaloActionsConfig;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
  defaultAccount?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, OpenzaloGroupConfig>;
  groupRequireMention?: boolean;
  groupMentionDetectionFailure?: OpenzaloGroupMentionDetectionFailureMode;
  historyLimit?: number;
  sendFailureNotice?: boolean;
  sendFailureMessage?: string;
  messagePrefix?: string;
  responsePrefix?: string;
  accounts?: Record<string, OpenzaloAccountConfig>;
};

export type ResolvedOpenzaloAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  profile: string;
  authenticated: boolean;
  config: OpenzaloAccountConfig;
};
