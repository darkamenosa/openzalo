import { MarkdownConfigSchema, ToolPolicySchema } from "openclaw/plugin-sdk";
import { z } from "zod";
import { OPENZALO_TEXT_LIMIT } from "./constants.js";

const allowFromEntry = z.union([z.string(), z.number()]);

const groupConfigSchema = z.object({
  allow: z.boolean().optional(),
  enabled: z.boolean().optional(),
  tools: ToolPolicySchema,
  requireMention: z.boolean().optional(),
});

const actionsConfigSchema = z.object({
  messages: z.boolean().optional(),
  reactions: z.boolean().optional(),
});

const openzaloAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  actions: actionsConfigSchema.optional(),
  profile: z.string().optional(),
  textChunkLimit: z.number().int().positive().max(OPENZALO_TEXT_LIMIT).optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  mediaMaxMb: z.number().positive().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  groupPolicy: z.enum(["disabled", "allowlist", "open"]).optional(),
  groups: z.object({}).catchall(groupConfigSchema).optional(),
  groupRequireMention: z.boolean().optional(),
  groupMentionDetectionFailure: z
    .enum(["allow", "deny", "allow-with-warning"])
    .optional(),
  historyLimit: z.number().int().min(0).optional(),
  sendFailureNotice: z.boolean().optional(),
  sendFailureMessage: z.string().optional(),
  messagePrefix: z.string().optional(),
  responsePrefix: z.string().optional(),
});

export const OpenzaloConfigSchema = openzaloAccountSchema.extend({
  accounts: z.object({}).catchall(openzaloAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});
