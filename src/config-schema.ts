import { MarkdownConfigSchema, ToolPolicySchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const openzaloThreadBindingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    spawnSubagentSessions: z.boolean().optional(),
    ttlHours: z.number().nonnegative().optional(),
  })
  .optional();

const openzaloActionSchema = z
  .object({
    reactions: z.boolean().default(true),
    messages: z.boolean().default(true),
    groups: z.boolean().default(true),
    pins: z.boolean().default(true),
    memberInfo: z.boolean().default(true),
    groupMembers: z.boolean().default(true),
  })
  .optional();

const openzaloGroupConfigSchema = z.object({
  enabled: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  tools: ToolPolicySchema,
  toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
  skills: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
});

const openzaloAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  profile: z.string().optional(),
  zcaBinary: z.string().optional(),
  markdown: MarkdownConfigSchema,
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  groupPolicy: z.enum(["open", "disabled", "allowlist"]).optional(),
  groupAllowFrom: z.array(allowFromEntry).optional(),
  groups: z.object({}).catchall(openzaloGroupConfigSchema).optional(),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  blockStreaming: z.boolean().optional(),
  mediaMaxMb: z.number().int().positive().optional(),
  mediaLocalRoots: z.array(z.string()).optional(),
  sendTypingIndicators: z.boolean().optional(),
  threadBindings: openzaloThreadBindingsSchema,
  actions: openzaloActionSchema,
});

export const OpenzaloConfigSchema = openzaloAccountSchema.extend({
  accounts: z.object({}).catchall(openzaloAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});
