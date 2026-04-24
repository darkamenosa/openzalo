import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseJsonOutput } from "./json-output.js";
import type { ResolvedOpenzaloAccount } from "./types.js";

type OpenzcaRunOptions = {
  binary?: string;
  profile: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type OpenzcaRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type OpenzcaStreamingOptions = {
  binary?: string;
  profile: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onJsonLine?: (payload: Record<string, unknown>) => void | Promise<void>;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

type OpenzcaSpawnInvocation = {
  command: string;
  args: string[];
  displayBinary: string;
  displayArgs: string[];
  windowsHide?: true;
  windowsVerbatimArguments?: true;
};

type OpenzcaSpawnResolveOptions = {
  binary?: string;
  profile: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execPath?: string;
  existsSync?: (target: string) => boolean;
};

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;

function getEnvValue(env: NodeJS.ProcessEnv | undefined, key: string): string {
  if (!env) {
    return "";
  }
  const direct = env[key];
  if (typeof direct === "string") {
    return direct;
  }
  const normalizedKey = key.toLowerCase();
  const found = Object.keys(env).find((entry) => entry.toLowerCase() === normalizedKey);
  const value = found ? env[found] : undefined;
  return typeof value === "string" ? value : "";
}

function isPathLikeCommand(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function commandPathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path;
}

function normalizeCommandPath(command: string, platform: NodeJS.Platform): string {
  return commandPathApi(platform).normalize(command);
}

function normalizeCommandName(command: string, platform: NodeJS.Platform): string {
  const pathApi = commandPathApi(platform);
  return pathApi.basename(command).replace(/\.(cmd|bat|exe)$/i, "").toLowerCase();
}

function isOpenzcaCommandName(command: string, platform: NodeJS.Platform): boolean {
  const name = normalizeCommandName(command, platform);
  return name === "openzca" || name === "zca";
}

function resolveCommandOnWindowsPath(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
  existsSync: (target: string) => boolean;
}): string | null {
  const command = params.command.trim();
  if (!command || isPathLikeCommand(command)) {
    return command || null;
  }

  const pathEnv = getEnvValue(params.env, "PATH");
  if (!pathEnv) {
    return null;
  }
  const pathExt = getEnvValue(params.env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD";
  const ext = path.win32.extname(command);
  const extensions = ext ? [""] : pathExt.split(";").filter(Boolean);

  for (const dir of pathEnv.split(";")) {
    const baseDir = dir.trim();
    if (!baseDir) {
      continue;
    }
    for (const candidateExt of extensions) {
      const candidate = path.win32.join(baseDir, `${command}${candidateExt}`);
      if (params.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function findOpenzcaCliScript(params: {
  command: string;
  platform: NodeJS.Platform;
  existsSync: (target: string) => boolean;
}): string | null {
  if (params.platform !== "win32" || !isOpenzcaCommandName(params.command, params.platform)) {
    return null;
  }

  const pathApi = commandPathApi(params.platform);
  const ext = pathApi.extname(params.command).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    return null;
  }

  const dir = pathApi.dirname(params.command);
  const candidates = [
    pathApi.join(dir, "node_modules", "openzca", "dist", "cli.js"),
    pathApi.join(dir, "..", "openzca", "dist", "cli.js"),
  ].map((candidate) => pathApi.normalize(candidate));

  return candidates.find((candidate) => params.existsSync(candidate)) ?? null;
}

function escapeForCmdExe(arg: string): string {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(
      `Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. ` +
        "Set channels.openzalo.zcaBinary to the openzca dist/cli.js path or reinstall openzca with npm.",
    );
  }
  if (!arg.includes(" ") && !arg.includes('"')) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

function buildCmdExeCommandLine(command: string, args: string[]): string {
  return [escapeForCmdExe(command), ...args.map(escapeForCmdExe)].join(" ");
}

export function resolveOpenzcaSpawnInvocation(
  options: OpenzcaSpawnResolveOptions,
): OpenzcaSpawnInvocation {
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? fs.existsSync;
  const binary = options.binary?.trim() || "openzca";
  const displayArgs = ["--profile", options.profile, ...options.args];
  const env = { ...process.env, ...options.env };

  let command = binary;
  if (platform === "win32") {
    command =
      resolveCommandOnWindowsPath({
        command: binary,
        env,
        existsSync,
      }) ?? binary;
  }
  command = normalizeCommandPath(command, platform);

  const ext = commandPathApi(platform).extname(command).toLowerCase();
  if (platform === "win32" && (ext === ".js" || ext === ".mjs")) {
    return {
      command: options.execPath ?? process.execPath,
      args: [command, ...displayArgs],
      displayBinary: binary,
      displayArgs,
      windowsHide: true,
    };
  }

  const cliScript = findOpenzcaCliScript({ command, platform, existsSync });
  if (cliScript) {
    return {
      command: options.execPath ?? process.execPath,
      args: [cliScript, ...displayArgs],
      displayBinary: binary,
      displayArgs,
      windowsHide: true,
    };
  }

  if (platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    return {
      command: getEnvValue(env, "ComSpec") || "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(command, displayArgs)],
      displayBinary: binary,
      displayArgs,
      windowsHide: true,
      windowsVerbatimArguments: true,
    };
  }

  return {
    command,
    args: displayArgs,
    displayBinary: binary,
    displayArgs,
  };
}

function resolveOpenzcaSpawnEnv(options: Pick<OpenzcaRunOptions, "env">): NodeJS.ProcessEnv {
  return { ...process.env, ...options.env };
}

function makeExecError(params: {
  binary: string;
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
}): Error {
  const stderr = params.stderr.trim();
  const stdout = params.stdout.trim();
  const detail = stderr || stdout || `process exited with code ${params.exitCode}`;
  return new Error(`${params.binary} ${params.args.join(" ")} failed: ${detail}`);
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === "string" ? err : String(err));
}

export function resolveOpenzcaExec(account: ResolvedOpenzaloAccount): {
  binary: string;
  profile: string;
} {
  return {
    binary: account.zcaBinary,
    profile: account.profile,
  };
}

export async function runOpenzcaCommand(options: OpenzcaRunOptions): Promise<OpenzcaRunResult> {
  const env = resolveOpenzcaSpawnEnv(options);
  const invocation = resolveOpenzcaSpawnInvocation({ ...options, env });

  return await new Promise<OpenzcaRunResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: invocation.windowsHide,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, options.timeoutMs);
    }

    if (options.signal) {
      abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
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

    child.on("error", (err) => {
      finish(() => reject(err));
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        finish(() =>
          reject(
            makeExecError({
              binary: invocation.displayBinary,
              args: invocation.displayArgs,
              exitCode,
              stderr,
              stdout,
            }),
          ),
        );
        return;
      }
      finish(() =>
        resolve({
          stdout,
          stderr,
          exitCode,
        }),
      );
    });
  });
}

export async function runOpenzcaInteractive(
  options: Omit<OpenzcaRunOptions, "timeoutMs" | "signal">,
): Promise<OpenzcaRunResult> {
  const env = resolveOpenzcaSpawnEnv(options);
  const invocation = resolveOpenzcaSpawnInvocation({ ...options, env });

  return await new Promise<OpenzcaRunResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      stdio: ["inherit", "inherit", "pipe"],
      shell: false,
      windowsHide: invocation.windowsHide,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    let stderr = "";

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      // Keep stderr visible in interactive mode while still capturing for errors.
      process.stderr.write(chunk);
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        reject(
          makeExecError({
            binary: invocation.displayBinary,
            args: invocation.displayArgs,
            exitCode,
            stderr,
            stdout: "",
          }),
        );
        return;
      }
      resolve({
        stdout: "",
        stderr,
        exitCode,
      });
    });
  });
}

export async function runOpenzcaJson<T = unknown>(options: OpenzcaRunOptions): Promise<T> {
  const result = await runOpenzcaCommand(options);
  return parseJsonOutput(result.stdout, { strict: true }) as T;
}

export async function runOpenzcaStreaming(options: OpenzcaStreamingOptions): Promise<{ exitCode: number }> {
  const env = resolveOpenzcaSpawnEnv(options);
  const invocation = resolveOpenzcaSpawnInvocation({ ...options, env });

  return await new Promise<{ exitCode: number }>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: invocation.windowsHide,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    let stdoutRemainder = "";
    let stderrRemainder = "";
    let abortHandler: (() => void) | undefined;
    let streamHandlerError: unknown;

    const emitStdoutLine = async (line: string) => {
      options.onStdoutLine?.(line);
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Non-JSON line from child output; ignore.
        return;
      }
      await options.onJsonLine?.(parsed);
    };

    const flushRemainder = async () => {
      if (stdoutRemainder.trim()) {
        await emitStdoutLine(stdoutRemainder);
      }
      if (stderrRemainder.trim()) {
        options.onStderrLine?.(stderrRemainder);
      }
      stdoutRemainder = "";
      stderrRemainder = "";
    };

    if (options.signal) {
      abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
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
      void Promise.all(lines.map((line) => emitStdoutLine(line))).catch((err) => {
        if (streamHandlerError) {
          return;
        }
        streamHandlerError = err;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      });
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrRemainder += String(chunk);
      const lines = stderrRemainder.split(/\r?\n/);
      stderrRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        options.onStderrLine?.(line);
      }
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", async (code) => {
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      try {
        await flushRemainder();
      } catch (err) {
        if (!streamHandlerError) {
          streamHandlerError = err;
        }
      }
      const exitCode = code ?? 0;
      if (streamHandlerError && !options.signal?.aborted) {
        reject(normalizeError(streamHandlerError));
        return;
      }
      if (exitCode !== 0 && !options.signal?.aborted) {
        reject(
          new Error(
            `${invocation.displayBinary} ${invocation.displayArgs.join(" ")} exited with code ${exitCode}`,
          ),
        );
        return;
      }
      resolve({ exitCode });
    });
  });
}
