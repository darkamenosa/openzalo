import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { handleOpenzaloInbound } from "./inbound.js";
import { getOpenzaloRuntime } from "./runtime.js";
import { runOpenzcaCommand, runOpenzcaStreaming } from "./openzca.js";
import { normalizeOpenzcaInboundPayload } from "./monitor-normalize.js";
import type { CoreConfig, OpenzaloInboundMessage, ResolvedOpenzaloAccount } from "./types.js";

type OpenzaloMonitorOptions = {
  account: ResolvedOpenzaloAccount;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type OpenzaloDebounceEntry = {
  message: OpenzaloInboundMessage;
};

const DEFAULT_INBOUND_DEBOUNCE_MS = 1200;
const OPENZALO_READY_TIMEOUT_MS = 30_000;
const OPENZALO_READY_POLL_MS = 500;
const OPENZALO_READY_LOG_AFTER_MS = 10_000;
const OPENZALO_READY_LOG_INTERVAL_MS = 10_000;

function toErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal.aborted) {
    throw new Error("aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForOpenzcaReady(options: {
  account: ResolvedOpenzaloAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
}): Promise<boolean> {
  const { account, runtime, abortSignal } = options;
  const startedAt = Date.now();
  const deadlineAt = startedAt + OPENZALO_READY_TIMEOUT_MS;
  let nextLogAt = startedAt + OPENZALO_READY_LOG_AFTER_MS;
  let lastError = "unknown error";

  while (!abortSignal.aborted) {
    try {
      await runOpenzcaCommand({
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["auth", "status"],
        timeoutMs: 8_000,
        signal: abortSignal,
      });
      return true;
    } catch (error) {
      if (abortSignal.aborted) {
        return false;
      }
      lastError = toErrorText(error);
    }

    const now = Date.now();
    if (now >= deadlineAt) {
      break;
    }
    if (now >= nextLogAt) {
      runtime.error?.(
        `[${account.accountId}] openzca not ready after ${now - startedAt}ms (${lastError})`,
      );
      nextLogAt = now + OPENZALO_READY_LOG_INTERVAL_MS;
    }
    try {
      await sleepWithAbort(OPENZALO_READY_POLL_MS, abortSignal);
    } catch {
      return false;
    }
  }

  if (abortSignal.aborted) {
    return false;
  }
  throw new Error(`openzca not ready after ${OPENZALO_READY_TIMEOUT_MS}ms (${lastError})`);
}

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function resolveCombinedText(texts: string[]): string {
  if (texts.length === 0) {
    return "";
  }
  if (texts.length === 1) {
    return texts[0] ?? "";
  }
  const last = texts[texts.length - 1] ?? "";
  // Preserve command semantics when the latest message is a command/mention command.
  if (/^([/!]|@\S)/.test(last.trim())) {
    return last;
  }
  return texts.join("\n");
}

function combineDebouncedInbound(entries: OpenzaloDebounceEntry[]): OpenzaloInboundMessage {
  if (entries.length === 0) {
    throw new Error("Cannot combine empty OpenZalo debounce entries");
  }
  if (entries.length === 1) {
    return entries[0].message;
  }

  const first = entries[0].message;
  const messages = entries.map((entry) => entry.message);
  const text = resolveCombinedText(
    dedupeStrings(messages.map((msg) => msg.text)),
  );
  const mediaPaths = dedupeStrings(messages.flatMap((msg) => msg.mediaPaths));
  const mediaUrls = dedupeStrings(messages.flatMap((msg) => msg.mediaUrls));
  const mediaTypes = dedupeStrings(messages.flatMap((msg) => msg.mediaTypes));
  const mentionIds = dedupeStrings(messages.flatMap((msg) => msg.mentionIds));
  const maxTimestamp = Math.max(
    ...messages.map((msg) => msg.timestamp).filter((value) => Number.isFinite(value)),
  );
  const latest = messages[messages.length - 1] ?? first;

  const preferredMsgId = messages.find((msg) => Boolean(msg.msgId))?.msgId;
  const preferredCliMsgId = messages.find((msg) => Boolean(msg.cliMsgId))?.cliMsgId;
  const messageId = preferredMsgId || preferredCliMsgId || first.messageId;

  const quoteMsgId = messages.find((msg) => Boolean(msg.quoteMsgId))?.quoteMsgId;
  const quoteCliMsgId = messages.find((msg) => Boolean(msg.quoteCliMsgId))?.quoteCliMsgId;
  const quoteSender = messages.find((msg) => Boolean(msg.quoteSender))?.quoteSender;
  const quoteText = messages.find((msg) => Boolean(msg.quoteText))?.quoteText;

  return {
    ...first,
    messageId,
    msgId: preferredMsgId || undefined,
    cliMsgId: preferredCliMsgId || undefined,
    text,
    timestamp: Number.isFinite(maxTimestamp) ? maxTimestamp : first.timestamp,
    quoteMsgId: quoteMsgId || undefined,
    quoteCliMsgId: quoteCliMsgId || undefined,
    quoteSender: quoteSender || undefined,
    quoteText: quoteText || undefined,
    mentionIds,
    mediaPaths,
    mediaUrls,
    mediaTypes,
    // Preserve the latest raw payload for troubleshooting while keeping first IDs/route info.
    raw: latest.raw,
  };
}

function resolveOpenzaloDebounceMs(cfg: CoreConfig): number {
  const inbound = cfg.messages?.inbound;
  const hasExplicitDebounce =
    typeof inbound?.debounceMs === "number" || typeof inbound?.byChannel?.openzalo === "number";
  if (!hasExplicitDebounce) {
    return DEFAULT_INBOUND_DEBOUNCE_MS;
  }
  const core = getOpenzaloRuntime();
  return core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "openzalo",
  });
}

function buildOpenzaloDebounceKey(params: {
  accountId: string;
  message: OpenzaloInboundMessage;
}): string {
  const chatType = params.message.isGroup ? "group" : "direct";
  return [
    "openzalo",
    params.accountId,
    chatType,
    params.message.threadId.trim(),
    params.message.senderId.trim(),
  ].join(":");
}

export async function monitorOpenzaloProvider(options: OpenzaloMonitorOptions): Promise<void> {
  const { account, cfg, runtime, abortSignal, statusSink } = options;
  const core = getOpenzaloRuntime();

  runtime.log?.(
    `[${account.accountId}] starting openzca listener (profile=${account.profile}, binary=${account.zcaBinary})`,
  );

  const ready = await waitForOpenzcaReady({
    account,
    runtime,
    abortSignal,
  });
  if (!ready) {
    return;
  }

  let selfId: string | undefined;
  try {
    const me = await runOpenzcaCommand({
      binary: account.zcaBinary,
      profile: account.profile,
      args: ["me", "id"],
      timeoutMs: 10_000,
    });
    const resolved = me.stdout.trim().split(/\s+/g)[0]?.trim();
    if (resolved) {
      selfId = resolved;
      runtime.log?.(`[${account.accountId}] resolved self id ${selfId}`);
    }
  } catch (error) {
    runtime.error?.(`[${account.accountId}] failed to resolve self id: ${String(error)}`);
  }

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<OpenzaloDebounceEntry>({
    debounceMs: resolveOpenzaloDebounceMs(cfg),
    buildKey: (entry) =>
      buildOpenzaloDebounceKey({
        accountId: account.accountId,
        message: entry.message,
      }),
    shouldDebounce: () => true,
    onFlush: async (entries) => {
      if (entries.length === 0) {
        return;
      }
      const message =
        entries.length === 1 ? entries[0].message : combineDebouncedInbound(entries);

      if (entries.length > 1 && core.logging.shouldLogVerbose()) {
        runtime.log?.(
          `[${account.accountId}] openzalo coalesced ${entries.length} inbound events ` +
            `thread=${message.threadId} sender=${message.senderId} ` +
            `textLen=${message.text.length} media=${message.mediaPaths.length + message.mediaUrls.length}`,
        );
      }

      core.channel.activity.record({
        channel: "openzalo",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });

      statusSink?.({ lastInboundAt: message.timestamp });

      await handleOpenzaloInbound({
        message,
        account,
        cfg,
        runtime,
        botUserId: selfId,
        statusSink,
      });
    },
    onError: (error) => {
      runtime.error?.(`[${account.accountId}] openzalo debounce flush failed: ${String(error)}`);
    },
  });

  await runOpenzcaStreaming({
    binary: account.zcaBinary,
    profile: account.profile,
    args: ["listen", "--raw", "--keep-alive"],
    signal: abortSignal,
    onStderrLine: (line) => {
      if (!line.trim()) {
        return;
      }
      runtime.error?.(`[${account.accountId}] openzca stderr: ${line}`);
    },
    onJsonLine: async (payload) => {
      const message = normalizeOpenzcaInboundPayload(payload, selfId);
      if (!message) {
        if (payload.kind === "lifecycle" && payload.event === "connected") {
          runtime.log?.(`[${account.accountId}] openzca connected`);
        }
        return;
      }
      await inboundDebouncer.enqueue({ message });
    },
  });
}
