import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);
const markdownTableModeSchema = z.enum(["off", "bullets", "code"]);
const markdownConfigSchema = z
  .object({
    tables: markdownTableModeSchema.optional(),
  })
  .strict()
  .optional();
const toolPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
      });
    }
  })
  .optional();

const openzaloAcpxSchema = z
  .object({
    enabled: z.boolean().optional(),
    command: z.string().optional(),
    agent: z.string().optional(),
    cwd: z.string().optional(),
    timeoutSeconds: z.number().positive().optional(),
    permissionMode: z.enum(["approve-all", "approve-reads", "deny-all"]).optional(),
    nonInteractivePermissions: z.enum(["deny", "fail"]).optional(),
  })
  .optional();

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
  tools: toolPolicySchema,
  toolsBySender: z.record(z.string(), toolPolicySchema).optional(),
  skills: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
});

const openzaloAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  profile: z.string().optional(),
  zcaBinary: z.string().optional(),
  acpx: openzaloAcpxSchema,
  markdown: markdownConfigSchema,
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

export function buildOpenzaloChannelSchemaJson(): Record<string, unknown> {
  return OpenzaloConfigSchema.toJSONSchema({
    target: "draft-07",
    unrepresentable: "any",
  }) as Record<string, unknown>;
}
