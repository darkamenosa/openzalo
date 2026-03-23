import type { ReplyPayload, RuntimeEnv } from "../../api.js";
import type { CoreConfig, ResolvedOpenzaloAccount } from "../types.js";
import { resolveOpenzaloStateDir } from "../state-dir.js";
import {
  closeOpenzaloAcpxSession,
  ensureOpenzaloAcpxSession,
  getOpenzaloAcpxStatus,
} from "./client.js";
import {
  createOpenzaloAcpBindingRecord,
  removeOpenzaloAcpBinding,
  resolveOpenzaloAcpBinding,
  upsertOpenzaloAcpBinding,
} from "./bindings.js";
import { resolveOpenzaloAcpxConfig } from "./config.js";
import type { OpenzaloAcpCommandResult } from "./types.js";

type ParsedOpenzaloAcpCommand = {
  action: "help" | "on" | "off" | "status" | "reset";
  agent?: string;
  cwd?: string;
};

function parseAcpCommandToken(token: string): { key?: string; value: string } {
  const separatorIndex = token.indexOf("=");
  if (separatorIndex <= 0) {
    return { value: token };
  }
  return {
    key: token.slice(0, separatorIndex).trim().toLowerCase(),
    value: token.slice(separatorIndex + 1).trim(),
  };
}

export function parseOpenzaloAcpCommand(commandBody: string): ParsedOpenzaloAcpCommand | null {
  const trimmed = commandBody.trim();
  const match = trimmed.match(/^[/!]acp(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  const rawArgs = (match[1] ?? "").trim();
  if (!rawArgs) {
    return { action: "status" };
  }
  const tokens = rawArgs.split(/\s+/).filter(Boolean);
  const actionToken = tokens.shift()?.toLowerCase() ?? "status";
  const action =
    actionToken === "on" ||
    actionToken === "off" ||
    actionToken === "status" ||
    actionToken === "reset" ||
    actionToken === "help"
      ? actionToken
      : "help";

  let agent: string | undefined;
  let cwd: string | undefined;
  for (const token of tokens) {
    const parsed = parseAcpCommandToken(token);
    if (parsed.key === "agent" && parsed.value) {
      agent = parsed.value;
      continue;
    }
    if (parsed.key === "cwd" && parsed.value) {
      cwd = parsed.value;
      continue;
    }
    if (!parsed.key && !agent) {
      agent = parsed.value;
    }
  }

  return {
    action,
    ...(agent ? { agent } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function buildUsagePayload(): ReplyPayload {
  return {
    text: [
      "OpenZalo ACPX commands:",
      "/acp status",
      "/acp on [agent] [cwd=/abs/path]",
      "/acp reset [agent] [cwd=/abs/path]",
      "/acp off",
    ].join("\n"),
  };
}

function buildDisabledPayload(): ReplyPayload {
  return {
    text:
      "OpenZalo ACPX is disabled for this account. Set channels.openzalo.acpx.enabled=true to enable it.",
    isError: true,
  };
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}

export async function handleOpenzaloAcpCommand(params: {
  commandBody: string;
  account: ResolvedOpenzaloAccount;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  conversationId: string;
  hasSubagentBinding: boolean;
}): Promise<OpenzaloAcpCommandResult> {
  const parsed = parseOpenzaloAcpCommand(params.commandBody);
  if (!parsed) {
    return { handled: false };
  }

  const stateDir = resolveOpenzaloStateDir(process.env);
  const acpxConfig = resolveOpenzaloAcpxConfig({
    cfg: params.cfg,
    accountId: params.account.accountId,
  });
  const existingBinding = await resolveOpenzaloAcpBinding({
    stateDir,
    accountId: params.account.accountId,
    conversationId: params.conversationId,
  });

  if (parsed.action === "help") {
    return {
      handled: true,
      payload: buildUsagePayload(),
      ...(existingBinding ? { binding: existingBinding } : {}),
    };
  }

  if (!acpxConfig.enabled && parsed.action !== "off" && parsed.action !== "status") {
    return {
      handled: true,
      payload: buildDisabledPayload(),
      ...(existingBinding ? { binding: existingBinding } : { binding: null }),
    };
  }

  if (parsed.action === "status") {
    if (!existingBinding) {
      return {
        handled: true,
        payload: {
          text: acpxConfig.enabled
            ? `ACP is off for this conversation. Default agent=${acpxConfig.agent} cwd=${acpxConfig.cwd}`
            : "ACP is off for this conversation. ACPX is currently disabled for this account.",
        },
        binding: null,
      };
    }
    if (!acpxConfig.enabled) {
      return {
        handled: true,
        payload: {
          text: [
            "ACP is bound for this conversation, but ACPX is currently disabled for this account.",
            `agent=${existingBinding.agent}`,
            `cwd=${existingBinding.cwd}`,
            `session=${existingBinding.sessionName}`,
          ].join("\n"),
        },
        binding: existingBinding,
      };
    }
    try {
      const status = await getOpenzaloAcpxStatus({
        config: acpxConfig,
        sessionName: existingBinding.sessionName,
        agent: existingBinding.agent,
        cwd: existingBinding.cwd,
      });
      return {
        handled: true,
        payload: {
          text: [
            `ACP is on for this conversation.`,
            `agent=${existingBinding.agent}`,
            `cwd=${existingBinding.cwd}`,
            `session=${existingBinding.sessionName}`,
            status.summary,
          ].join("\n"),
        },
        binding: existingBinding,
      };
    } catch (error) {
      return {
        handled: true,
        payload: {
          text: `ACP status failed: ${summarizeError(error)}`,
          isError: true,
        },
        binding: existingBinding,
      };
    }
  }

  if (parsed.action === "off") {
    if (!existingBinding) {
      return {
        handled: true,
        payload: { text: "ACP is already off for this conversation." },
        binding: null,
      };
    }
    let warning: string | null = null;
    if (acpxConfig.enabled) {
      try {
        await closeOpenzaloAcpxSession({
          config: acpxConfig,
          sessionName: existingBinding.sessionName,
          agent: existingBinding.agent,
          cwd: existingBinding.cwd,
        });
      } catch (error) {
        warning = summarizeError(error);
      }
    }
    await removeOpenzaloAcpBinding({
      stateDir,
      accountId: params.account.accountId,
      conversationId: params.conversationId,
    });
    return {
      handled: true,
      payload: {
        text: warning
          ? `ACP unbound, but session close reported: ${warning}`
          : "ACP is now off for this conversation.",
      },
      binding: null,
    };
  }

  const desiredAgent = parsed.agent?.trim() || existingBinding?.agent || acpxConfig.agent;
  const desiredCwd = parsed.cwd?.trim() || existingBinding?.cwd || acpxConfig.cwd;
  const nextBinding = createOpenzaloAcpBindingRecord({
    accountId: params.account.accountId,
    conversationId: params.conversationId,
    agent: desiredAgent,
    cwd: desiredCwd,
  });

  if (params.hasSubagentBinding && !existingBinding) {
    return {
      handled: true,
      payload: {
        text:
          "This conversation is already bound to a subagent session. End that binding before enabling ACP here.",
        isError: true,
      },
      binding: null,
    };
  }

  if (parsed.action === "reset" && existingBinding) {
    try {
      await closeOpenzaloAcpxSession({
        config: acpxConfig,
        sessionName: existingBinding.sessionName,
        agent: existingBinding.agent,
        cwd: existingBinding.cwd,
      });
    } catch {
      // Best effort: reset should still continue with a fresh ensure.
    }
  }

  try {
    await ensureOpenzaloAcpxSession({
      config: acpxConfig,
      sessionName: nextBinding.sessionName,
      agent: nextBinding.agent,
      cwd: nextBinding.cwd,
    });
    await upsertOpenzaloAcpBinding({
      stateDir,
      record: nextBinding,
    });

    if (
      existingBinding &&
      (existingBinding.agent !== nextBinding.agent || existingBinding.cwd !== nextBinding.cwd)
    ) {
      try {
        await closeOpenzaloAcpxSession({
          config: acpxConfig,
          sessionName: existingBinding.sessionName,
          agent: existingBinding.agent,
          cwd: existingBinding.cwd,
        });
      } catch {
        // Best effort cleanup for the previous binding.
      }
    }

    return {
      handled: true,
      payload: {
        text:
          parsed.action === "reset"
            ? `ACP session reset for this conversation.\nagent=${nextBinding.agent}\ncwd=${nextBinding.cwd}`
            : `ACP enabled for this conversation.\nagent=${nextBinding.agent}\ncwd=${nextBinding.cwd}`,
      },
      binding: nextBinding,
    };
  } catch (error) {
    return {
      handled: true,
      payload: {
        text: `ACP setup failed: ${summarizeError(error)}`,
        isError: true,
      },
      ...(existingBinding ? { binding: existingBinding } : { binding: null }),
    };
  }
}
