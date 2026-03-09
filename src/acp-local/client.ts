import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  OpenzaloAcpEnsureResult,
  OpenzaloAcpPromptResult,
  OpenzaloAcpStatusResult,
  ResolvedOpenzaloAcpxConfig,
} from "./types.js";

type AcpxRunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type AcpxRunOptions = {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type AcpxStreamingOptions = {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
  onJsonLine?: (payload: Record<string, unknown>) => void | Promise<void>;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

type ClientDeps = {
  runCommand?: (options: AcpxRunOptions) => Promise<AcpxRunCommandResult>;
  runStreaming?: (options: AcpxStreamingOptions) => Promise<{ exitCode: number; stderr: string }>;
};

type ParsedPromptEvent =
  | { type: "text"; text: string; stream: "output" | "thought" }
  | { type: "status"; text: string }
  | { type: "done" }
  | { type: "error"; message: string; code?: string };

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseJsonLines(value: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return events;
}

function buildPermissionArgs(config: ResolvedOpenzaloAcpxConfig): string[] {
  const permissionArg =
    config.permissionMode === "approve-all"
      ? "--approve-all"
      : config.permissionMode === "deny-all"
        ? "--deny-all"
        : "--approve-reads";
  return [permissionArg, "--non-interactive-permissions", config.nonInteractivePermissions];
}

function buildVerbArgs(params: {
  config: ResolvedOpenzaloAcpxConfig;
  agent: string;
  cwd: string;
  command: string[];
  includePermissions?: boolean;
}): string[] {
  const prefix = ["--format", "json", "--json-strict", "--cwd", params.cwd];
  if (params.includePermissions) {
    prefix.push(...buildPermissionArgs(params.config));
    if (params.config.timeoutSeconds) {
      prefix.push("--timeout", String(params.config.timeoutSeconds));
    }
  }
  return [...prefix, params.agent, ...params.command];
}

function toControlErrorMessage(params: {
  command: string;
  args: string[];
  stderr: string;
  exitCode: number;
}): string {
  const stderr = params.stderr.trim();
  if (stderr) {
    return stderr;
  }
  return `${params.command} ${params.args.join(" ")} exited with code ${params.exitCode}`;
}

function normalizeSpawnError(params: { command: string; cwd: string; error: unknown }): Error {
  const { command, cwd, error } = params;
  const err = error instanceof Error ? error : new Error(String(error));
  const code = (err as { code?: string }).code;
  if (code === "ENOENT") {
    if (cwd.trim() && !existsSync(cwd)) {
      return new Error(`acpx working directory not found: ${cwd}`);
    }
    return new Error(`acpx command not found: ${command}`);
  }
  return err;
}

function hasSessionIdentifiers(events: Array<Record<string, unknown>>): boolean {
  return events.some((event) => {
    const acpxSessionId = normalizeText(event.acpxSessionId);
    const agentSessionId = normalizeText(event.agentSessionId);
    const acpxRecordId = normalizeText(event.acpxRecordId);
    return Boolean(acpxSessionId || agentSessionId || acpxRecordId);
  });
}

function resolveStructuredPromptPayload(parsed: Record<string, unknown>): {
  type: string;
  payload: Record<string, unknown>;
} {
  const method = normalizeText(parsed.method);
  if (method === "session/update") {
    const params = parsed.params;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const update = (params as Record<string, unknown>).update;
      if (update && typeof update === "object" && !Array.isArray(update)) {
        const updateRecord = update as Record<string, unknown>;
        return {
          type: normalizeText(updateRecord.sessionUpdate) || normalizeText(updateRecord.type),
          payload: updateRecord,
        };
      }
    }
  }
  return {
    type: normalizeText(parsed.sessionUpdate) || normalizeText(parsed.type),
    payload: parsed,
  };
}

function parsePromptJsonEvent(parsed: Record<string, unknown>): ParsedPromptEvent | null {
  const structured = resolveStructuredPromptPayload(parsed);
  const type = structured.type;
  const payload = structured.payload;
  if (!type) {
    return null;
  }

  const content =
    typeof payload.content === "string"
      ? payload.content
      : payload.content && typeof payload.content === "object" && !Array.isArray(payload.content)
        ? String((payload.content as { text?: unknown }).text ?? "")
        : typeof payload.text === "string"
          ? payload.text
          : "";

  switch (type) {
    case "text":
    case "agent_message_chunk":
      return content ? { type: "text", text: content, stream: "output" } : null;
    case "thought":
    case "agent_thought_chunk":
      return content ? { type: "text", text: content, stream: "thought" } : null;
    case "tool_call":
    case "tool_call_update": {
      const title = normalizeText(payload.title) || "tool call";
      const status = normalizeText(payload.status);
      return { type: "status", text: status ? `${title} (${status})` : title };
    }
    case "usage_update":
      return { type: "status", text: "usage updated" };
    case "current_mode_update":
      return {
        type: "status",
        text: normalizeText(payload.currentModeId) || "mode updated",
      };
    case "session_info_update":
      return {
        type: "status",
        text: normalizeText(payload.summary) || normalizeText(payload.message) || "session updated",
      };
    case "done":
      return { type: "done" };
    case "error":
      return {
        type: "error",
        message: normalizeText(payload.message) || "acpx runtime error",
        code: normalizeText(payload.code) || undefined,
      };
    default:
      return null;
  }
}

export async function runAcpxCommand(options: AcpxRunOptions): Promise<AcpxRunCommandResult> {
  return await new Promise<AcpxRunCommandResult>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timeout: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;

    const finish = (fn: () => void) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      fn();
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, options.timeoutMs);
    }

    if (options.signal) {
      abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      if (options.signal.aborted) {
        abortHandler();
      }
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      finish(() =>
        reject(
          normalizeSpawnError({
            command: options.command,
            cwd: options.cwd,
            error,
          }),
        ),
      );
    });

    child.on("close", (code) => {
      finish(() =>
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        }),
      );
    });

    if (options.stdin) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export async function runAcpxStreaming(
  options: AcpxStreamingOptions,
): Promise<{ exitCode: number; stderr: string }> {
  return await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });

    let stdoutRemainder = "";
    let stderrRemainder = "";
    let stderr = "";
    let abortHandler: (() => void) | undefined;
    let handlerError: unknown;

    const flushStdoutLine = async (line: string) => {
      options.onStdoutLine?.(line);
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        await options.onJsonLine?.(parsed as Record<string, unknown>);
      }
    };

    if (options.signal) {
      abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      if (options.signal.aborted) {
        abortHandler();
      }
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutRemainder += String(chunk);
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      void Promise.all(lines.map((line) => flushStdoutLine(line))).catch((error) => {
        handlerError = error;
        child.kill("SIGTERM");
      });
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr += text;
      stderrRemainder += text;
      const lines = stderrRemainder.split(/\r?\n/);
      stderrRemainder = lines.pop() ?? "";
      for (const line of lines) {
        options.onStderrLine?.(line);
      }
    });

    child.on("error", (error) => {
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      reject(
        normalizeSpawnError({
          command: options.command,
          cwd: options.cwd,
          error,
        }),
      );
    });

    child.on("close", async (code) => {
      try {
        if (stdoutRemainder.trim()) {
          await flushStdoutLine(stdoutRemainder);
        }
        if (stderrRemainder.trim()) {
          options.onStderrLine?.(stderrRemainder);
        }
      } catch (error) {
        handlerError = error;
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      if (handlerError) {
        reject(handlerError);
        return;
      }
      resolve({ exitCode: code ?? 0, stderr });
    });

    if (options.stdin) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export async function ensureOpenzaloAcpxSession(
  params: {
    config: ResolvedOpenzaloAcpxConfig;
    sessionName: string;
    agent: string;
    cwd: string;
    signal?: AbortSignal;
  },
  deps: ClientDeps = {},
): Promise<OpenzaloAcpEnsureResult> {
  const run = deps.runCommand ?? runAcpxCommand;
  const timeoutMs = params.config.timeoutSeconds ? params.config.timeoutSeconds * 1_000 : undefined;
  const ensureArgs = buildVerbArgs({
    config: params.config,
    agent: params.agent,
    cwd: params.cwd,
    command: ["sessions", "ensure", "--name", params.sessionName],
  });

  const ensureResult = await run({
    command: params.config.command,
    args: ensureArgs,
    cwd: params.cwd,
    timeoutMs,
    signal: params.signal,
  });
  if (ensureResult.exitCode !== 0) {
    throw new Error(
      toControlErrorMessage({
        command: params.config.command,
        args: ensureArgs,
        stderr: ensureResult.stderr,
        exitCode: ensureResult.exitCode,
      }),
    );
  }
  if (!hasSessionIdentifiers(parseJsonLines(ensureResult.stdout))) {
    const newArgs = buildVerbArgs({
      config: params.config,
      agent: params.agent,
      cwd: params.cwd,
      command: ["sessions", "new", "--name", params.sessionName],
    });
    const newResult = await run({
      command: params.config.command,
      args: newArgs,
      cwd: params.cwd,
      timeoutMs,
      signal: params.signal,
    });
    if (newResult.exitCode !== 0) {
      throw new Error(
        toControlErrorMessage({
          command: params.config.command,
          args: newArgs,
          stderr: newResult.stderr,
          exitCode: newResult.exitCode,
        }),
      );
    }
  }
  return {
    sessionName: params.sessionName,
    agent: params.agent,
    cwd: params.cwd,
  };
}

export async function promptOpenzaloAcpxSession(
  params: {
    config: ResolvedOpenzaloAcpxConfig;
    sessionName: string;
    agent: string;
    cwd: string;
    text: string;
    signal?: AbortSignal;
  },
  deps: ClientDeps = {},
): Promise<OpenzaloAcpPromptResult> {
  const runStreaming = deps.runStreaming ?? runAcpxStreaming;
  const args = buildVerbArgs({
    config: params.config,
    agent: params.agent,
    cwd: params.cwd,
    command: ["prompt", "--session", params.sessionName, "--file", "-"],
    includePermissions: true,
  });
  let outputText = "";
  const statusLines: string[] = [];
  let parsedError: { message: string; code?: string } | null = null;

  const result = await runStreaming({
    command: params.config.command,
    args,
    cwd: params.cwd,
    stdin: params.text,
    signal: params.signal,
    onJsonLine: async (payload) => {
      const event = parsePromptJsonEvent(payload);
      if (!event) {
        return;
      }
      if (event.type === "text" && event.stream === "output") {
        outputText += event.text;
        return;
      }
      if (event.type === "status") {
        statusLines.push(event.text);
        return;
      }
      if (event.type === "error") {
        parsedError = {
          message: event.message,
          ...(event.code ? { code: event.code } : {}),
        };
      }
    },
  });

  if (parsedError) {
    throw new Error(
      parsedError.code ? `${parsedError.code}: ${parsedError.message}` : parsedError.message,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      toControlErrorMessage({
        command: params.config.command,
        args,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }),
    );
  }

  return {
    text: outputText.trim(),
    ...(statusLines.length > 0 ? { statusText: statusLines.join("\n") } : {}),
  };
}

export async function getOpenzaloAcpxStatus(
  params: {
    config: ResolvedOpenzaloAcpxConfig;
    sessionName: string;
    agent: string;
    cwd: string;
    signal?: AbortSignal;
  },
  deps: ClientDeps = {},
): Promise<OpenzaloAcpStatusResult> {
  const run = deps.runCommand ?? runAcpxCommand;
  const timeoutMs = params.config.timeoutSeconds ? params.config.timeoutSeconds * 1_000 : undefined;
  const args = buildVerbArgs({
    config: params.config,
    agent: params.agent,
    cwd: params.cwd,
    command: ["status", "--session", params.sessionName],
  });
  const result = await run({
    command: params.config.command,
    args,
    cwd: params.cwd,
    timeoutMs,
    signal: params.signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      toControlErrorMessage({
        command: params.config.command,
        args,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }),
    );
  }
  const events = parseJsonLines(result.stdout);
  const detail = events.find((entry) => normalizeText(entry.type) !== "error") ?? events[0] ?? {};
  const status = normalizeText(detail.status) || "unknown";
  const acpxSessionId = normalizeText(detail.acpxSessionId);
  const acpxRecordId = normalizeText(detail.acpxRecordId);
  const pid =
    typeof detail.pid === "number" && Number.isFinite(detail.pid) ? Math.floor(detail.pid) : null;
  const summary = [
    `status=${status}`,
    acpxSessionId ? `acpxSessionId=${acpxSessionId}` : null,
    acpxRecordId ? `acpxRecordId=${acpxRecordId}` : null,
    pid != null ? `pid=${pid}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    summary: summary || "status unavailable",
    details: detail,
  };
}

export async function closeOpenzaloAcpxSession(
  params: {
    config: ResolvedOpenzaloAcpxConfig;
    sessionName: string;
    agent: string;
    cwd: string;
    signal?: AbortSignal;
  },
  deps: ClientDeps = {},
): Promise<void> {
  const run = deps.runCommand ?? runAcpxCommand;
  const timeoutMs = params.config.timeoutSeconds ? params.config.timeoutSeconds * 1_000 : undefined;
  const args = buildVerbArgs({
    config: params.config,
    agent: params.agent,
    cwd: params.cwd,
    command: ["sessions", "close", params.sessionName],
  });
  const result = await run({
    command: params.config.command,
    args,
    cwd: params.cwd,
    timeoutMs,
    signal: params.signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      toControlErrorMessage({
        command: params.config.command,
        args,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }),
    );
  }
}
