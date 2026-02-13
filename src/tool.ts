import { Type } from "@sinclair/typebox";
import { runOpenzca, parseJsonOutput } from "./openzca.js";

const ACTIONS = [
  "send",
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
    threadId: Type.Optional(Type.String({ description: "Thread ID for messaging" })),
    groupId: Type.Optional(Type.String({ description: "Group ID for group-member listing" })),
    message: Type.Optional(Type.String({ description: "Message text" })),
    isGroup: Type.Optional(Type.Boolean({ description: "Is group chat" })),
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
  isGroup?: boolean;
  profile?: string;
  query?: string;
  url?: string;
};

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
        if (!params.threadId || !params.message) {
          throw new Error("threadId and message required for send action");
        }
        const args = ["msg", "send", params.threadId, params.message];
        if (params.isGroup) {
          args.push("-g");
        }
        const result = await runOpenzca(args, { profile: params.profile });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to send message");
        }
        return json({ success: true, output: result.stdout });
      }

      case "image": {
        if (!params.threadId) {
          throw new Error("threadId required for image action");
        }
        if (!params.url) {
          throw new Error("url required for image action");
        }
        const args = ["msg", "image", params.threadId, "-u", params.url];
        if (params.message) {
          args.push("-m", params.message);
        }
        if (params.isGroup) {
          args.push("-g");
        }
        const result = await runOpenzca(args, { profile: params.profile });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to send image");
        }
        return json({ success: true, output: result.stdout });
      }

      case "link": {
        if (!params.threadId || !params.url) {
          throw new Error("threadId and url required for link action");
        }
        const args = ["msg", "link", params.threadId, params.url];
        if (params.isGroup) {
          args.push("-g");
        }
        const result = await runOpenzca(args, { profile: params.profile });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to send link");
        }
        return json({ success: true, output: result.stdout });
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
        const groupId = params.groupId?.trim() || params.threadId?.trim();
        if (!groupId) {
          throw new Error("groupId (or threadId) required for group-members action");
        }
        const result = await runOpenzca(["group", "members", groupId, "-j"], {
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
          `Unknown action: ${String(params.action)}. Valid actions: send, image, link, friends, groups, group-members, me, status`,
        );
      }
    }
  } catch (err) {
    return json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
