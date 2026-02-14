import { Type } from "@sinclair/typebox";
import { runOpenzca, parseJsonOutput } from "./openzca.js";
import {
  sendImageOpenzalo,
  sendLinkOpenzalo,
  sendMessageOpenzalo,
  unsendMessageOpenzalo,
} from "./send.js";

const ACTIONS = [
  "send",
  "unsend",
  "image",
  "link",
  "friends",
  "groups",
  "group-members",
  "me",
  "status",
] as const;

type AgentToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
};

function stringEnum<T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

// Tool schema - avoiding Type.Union per tool schema guardrails
export const OpenzaloToolSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, { description: `Action to perform: ${ACTIONS.join(", ")}` }),
    threadId: Type.Optional(
      Type.String({
        description:
          'Thread target for messaging. Prefer "group:<id>" or "user:<id>"; bare numeric IDs require isGroup.',
      }),
    ),
    groupId: Type.Optional(Type.String({ description: "Group ID for group-member listing" })),
    message: Type.Optional(Type.String({ description: "Message text (or caption for media send)" })),
    caption: Type.Optional(Type.String({ description: "Caption for media/file send" })),
    media: Type.Optional(
      Type.String({
        description:
          "Media/file source for action=send/image (local path or URL). Supports image/video/voice and generic files (pdf/doc/xlsx/zip...).",
      }),
    ),
    path: Type.Optional(Type.String({ description: "Alias of media for local file paths" })),
    filePath: Type.Optional(Type.String({ description: "Alias of media for local file paths" })),
    isGroup: Type.Optional(
      Type.Boolean({
        description: "Set true for group chats (required when threadId is a bare numeric group ID).",
      }),
    ),
    msgId: Type.Optional(Type.String({ description: "Message id for unsend action" })),
    messageId: Type.Optional(Type.String({ description: "Alias of msgId for unsend action" })),
    cliMsgId: Type.Optional(Type.String({ description: "Client message id for unsend action" })),
    clientMessageId: Type.Optional(
      Type.String({ description: "Alias of cliMsgId for unsend action" }),
    ),
    profile: Type.Optional(Type.String({ description: "Profile name" })),
    query: Type.Optional(Type.String({ description: "Search query" })),
    url: Type.Optional(Type.String({ description: "URL for media/link" })),
  },
  { additionalProperties: false },
);

type ToolParams = {
  action: (typeof ACTIONS)[number];
  threadId?: string;
  groupId?: string;
  message?: string;
  caption?: string;
  media?: string;
  path?: string;
  filePath?: string;
  isGroup?: boolean;
  msgId?: string;
  messageId?: string;
  cliMsgId?: string;
  clientMessageId?: string;
  profile?: string;
  query?: string;
  url?: string;
};

function normalizeThreadTarget(rawTarget: string): string {
  const cleaned = rawTarget.replace(/^(openzalo|zlu):/i, "").trim();
  if (!cleaned) {
    return "";
  }
  const lowered = cleaned.toLowerCase();
  if (lowered.startsWith("group:") || lowered.startsWith("user:")) {
    return cleaned;
  }
  const aliasMatch = cleaned.match(/^([gu])-(\d{3,})$/i);
  if (aliasMatch) {
    const kind = aliasMatch[1]?.toLowerCase() === "g" ? "group" : "user";
    const id = aliasMatch[2] ?? "";
    return `${kind}:${id}`;
  }
  const labeledIdMatch = cleaned.match(/\((\d{3,})\)\s*$/);
  if (labeledIdMatch?.[1]) {
    return labeledIdMatch[1];
  }
  return cleaned;
}

function resolveThreadTarget(params: { threadId?: string; isGroup?: boolean }): {
  threadId: string;
  isGroup: boolean;
} {
  const rawTarget = params.threadId?.trim();
  if (!rawTarget) {
    throw new Error("threadId required");
  }
  const normalized = normalizeThreadTarget(rawTarget);
  if (!normalized) {
    throw new Error("threadId required");
  }

  let threadId = normalized;
  let inferredIsGroup: boolean | undefined;
  if (normalized.toLowerCase().startsWith("group:")) {
    threadId = normalized.slice("group:".length).trim();
    inferredIsGroup = true;
  } else if (normalized.toLowerCase().startsWith("user:")) {
    threadId = normalized.slice("user:".length).trim();
    inferredIsGroup = false;
  }

  if (!threadId) {
    throw new Error("threadId required");
  }

  if (typeof params.isGroup === "boolean") {
    if (typeof inferredIsGroup === "boolean" && inferredIsGroup !== params.isGroup) {
      throw new Error(`threadId target "${rawTarget}" conflicts with isGroup=${String(params.isGroup)}`);
    }
    inferredIsGroup = params.isGroup;
  }

  return {
    threadId,
    isGroup: inferredIsGroup ?? false,
  };
}

function json(payload: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export async function executeOpenzaloTool(
  _toolCallId: string,
  params: ToolParams,
  _signal?: AbortSignal,
  _onUpdate?: unknown,
): Promise<AgentToolResult> {
  try {
    switch (params.action) {
      case "send": {
        const target = resolveThreadTarget({
          threadId: params.threadId,
          isGroup: params.isGroup,
        });
        const media =
          params.media?.trim() ||
          params.path?.trim() ||
          params.filePath?.trim() ||
          undefined;
        const message = params.message ?? "";
        const caption = params.caption;
        if (!media && !message.trim()) {
          throw new Error("message required for send action when no media/path/filePath is provided");
        }
        const result = await sendMessageOpenzalo(target.threadId, message || (caption ?? ""), {
          profile: params.profile,
          isGroup: target.isGroup,
          mediaUrl: media,
          caption: caption ?? undefined,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to send message");
        }
        return json({
          success: true,
          threadId: target.threadId,
          isGroup: target.isGroup,
          messageId: result.messageId ?? result.msgId ?? null,
          msgId: result.msgId ?? result.messageId ?? null,
          cliMsgId: result.cliMsgId ?? null,
        });
      }

      case "unsend": {
        const target = resolveThreadTarget({
          threadId: params.threadId,
          isGroup: params.isGroup,
        });
        const msgId = params.msgId?.trim() || params.messageId?.trim();
        const cliMsgId = params.cliMsgId?.trim() || params.clientMessageId?.trim();
        if (!msgId || !cliMsgId) {
          throw new Error("msgId/messageId and cliMsgId/clientMessageId are required for unsend action");
        }
        const result = await unsendMessageOpenzalo(
          {
            threadId: target.threadId,
            msgId,
            cliMsgId,
          },
          {
            profile: params.profile,
            isGroup: target.isGroup,
          },
        );
        if (!result.ok) {
          throw new Error(result.error || "Failed to unsend message");
        }
        return json({
          success: true,
          threadId: target.threadId,
          isGroup: target.isGroup,
          msgId,
          cliMsgId,
          data: result.output ?? null,
        });
      }

      case "image": {
        const target = resolveThreadTarget({
          threadId: params.threadId,
          isGroup: params.isGroup,
        });
        const imageSource =
          params.url?.trim() ||
          params.media?.trim() ||
          params.path?.trim() ||
          params.filePath?.trim() ||
          undefined;
        if (!imageSource) {
          throw new Error("url/media/path/filePath required for image action");
        }
        const result = await sendImageOpenzalo(target.threadId, imageSource, {
          profile: params.profile,
          isGroup: target.isGroup,
          caption: params.message ?? params.caption,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to send image");
        }
        return json({
          success: true,
          threadId: target.threadId,
          isGroup: target.isGroup,
          messageId: result.messageId ?? result.msgId ?? null,
          msgId: result.msgId ?? result.messageId ?? null,
          cliMsgId: result.cliMsgId ?? null,
        });
      }

      case "link": {
        const target = resolveThreadTarget({
          threadId: params.threadId,
          isGroup: params.isGroup,
        });
        if (!params.url?.trim()) {
          throw new Error("url required for link action");
        }
        const result = await sendLinkOpenzalo(target.threadId, params.url, {
          profile: params.profile,
          isGroup: target.isGroup,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to send link");
        }
        return json({
          success: true,
          threadId: target.threadId,
          isGroup: target.isGroup,
          messageId: result.messageId ?? result.msgId ?? null,
          msgId: result.msgId ?? result.messageId ?? null,
          cliMsgId: result.cliMsgId ?? null,
        });
      }

      case "friends": {
        const args = params.query ? ["friend", "find", params.query] : ["friend", "list", "-j"];
        const result = await runOpenzca(args, { profile: params.profile });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to get friends");
        }
        const parsed = parseJsonOutput(result.stdout);
        return json(parsed ?? { raw: result.stdout });
      }

      case "groups": {
        const result = await runOpenzca(["group", "list", "-j"], {
          profile: params.profile,
        });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to get groups");
        }
        const parsed = parseJsonOutput(result.stdout);
        return json(parsed ?? { raw: result.stdout });
      }

      case "group-members": {
        const groupTarget = params.groupId?.trim() || params.threadId?.trim();
        if (!groupTarget) {
          throw new Error("groupId (or threadId) required for group-members action");
        }
        const target = resolveThreadTarget({ threadId: groupTarget, isGroup: true });
        const result = await runOpenzca(["group", "members", target.threadId, "-j"], {
          profile: params.profile,
        });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to get group members");
        }
        const parsed = parseJsonOutput(result.stdout);
        return json(parsed ?? { raw: result.stdout });
      }

      case "me": {
        const result = await runOpenzca(["me", "info", "-j"], {
          profile: params.profile,
        });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to get profile");
        }
        const parsed = parseJsonOutput(result.stdout);
        return json(parsed ?? { raw: result.stdout });
      }

      case "status": {
        const result = await runOpenzca(["auth", "status"], {
          profile: params.profile,
        });
        return json({
          authenticated: result.ok,
          output: result.stdout || result.stderr,
        });
      }

      default: {
        params.action satisfies never;
        throw new Error(
          `Unknown action: ${String(params.action)}. Valid actions: send, unsend, image, link, friends, groups, group-members, me, status`,
        );
      }
    }
  } catch (err) {
    return json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
