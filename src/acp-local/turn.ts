import type { ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import { ensureOpenzaloAcpxSession, promptOpenzaloAcpxSession } from "./client.js";
import { resolveOpenzaloAcpxConfig } from "./config.js";
import type { OpenzaloAcpBindingRecord } from "./types.js";
import type { CoreConfig } from "../types.js";

const conversationQueues = new Map<string, Promise<void>>();

function resolvePromptBaseText(ctx: Record<string, unknown>): string {
  const candidates = [
    ctx.BodyForAgent,
    ctx.BodyForCommands,
    ctx.CommandBody,
    ctx.RawBody,
    ctx.Body,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function buildOpenzaloAcpPromptText(ctx: Record<string, unknown>): string {
  const lines: string[] = [];
  const base = resolvePromptBaseText(ctx);
  lines.push(base || "[media attached]");

  const mediaPaths = asStringList(ctx.MediaPaths);
  const mediaUrls = asStringList(ctx.MediaUrls);
  if (mediaPaths.length > 0) {
    lines.push("", "Media paths:", ...mediaPaths.map((entry) => `- ${entry}`));
  }
  if (mediaUrls.length > 0) {
    lines.push("", "Media URLs:", ...mediaUrls.map((entry) => `- ${entry}`));
  }
  if (typeof ctx.ReplyToBody === "string" && ctx.ReplyToBody.trim()) {
    lines.push("", `Quoted message: ${ctx.ReplyToBody.trim()}`);
  }
  return lines.join("\n").trim();
}

function enqueueConversationTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = conversationQueues.get(key) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  conversationQueues.set(key, next);

  return previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      releaseCurrent?.();
      if (conversationQueues.get(key) === next) {
        conversationQueues.delete(key);
      }
    });
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}

export async function runOpenzaloAcpBoundTurn(params: {
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  accountId: string;
  binding: OpenzaloAcpBindingRecord;
  ctxPayload: Record<string, unknown>;
}): Promise<ReplyPayload> {
  const key = `${params.binding.accountId}:${params.binding.conversationId}`;
  return await enqueueConversationTurn(key, async () => {
    const config = resolveOpenzaloAcpxConfig({
      cfg: params.cfg,
      accountId: params.accountId,
    });
    if (!config.enabled) {
      return {
        text: "ACP is disabled for this account.",
        isError: true,
      };
    }
    try {
      await ensureOpenzaloAcpxSession({
        config,
        sessionName: params.binding.sessionName,
        agent: params.binding.agent,
        cwd: params.binding.cwd,
      });
      const result = await promptOpenzaloAcpxSession({
        config,
        sessionName: params.binding.sessionName,
        agent: params.binding.agent,
        cwd: params.binding.cwd,
        text: buildOpenzaloAcpPromptText(params.ctxPayload),
      });
      if (result.text.trim()) {
        return { text: result.text.trim() };
      }
      if (result.statusText?.trim()) {
        return { text: result.statusText.trim() };
      }
      return { text: "ACP completed with no text output." };
    } catch (error) {
      params.runtime.error?.(`openzalo acp-local turn failed: ${summarizeError(error)}`);
      return {
        text: `ACP turn failed: ${summarizeError(error)}`,
        isError: true,
      };
    }
  });
}
