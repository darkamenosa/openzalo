import { spawn } from "node:child_process";
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
  const binary = options.binary?.trim() || "openzca";
  const args = ["--profile", options.profile, ...options.args];

  return await new Promise<OpenzcaRunResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
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
              binary,
              args,
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
  const binary = options.binary?.trim() || "openzca";
  const args = ["--profile", options.profile, ...options.args];

  return await new Promise<OpenzcaRunResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["inherit", "inherit", "pipe"],
      shell: false,
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
            binary,
            args,
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
  const binary = options.binary?.trim() || "openzca";
  const args = ["--profile", options.profile, ...options.args];

  return await new Promise<{ exitCode: number }>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
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
        reject(new Error(`${binary} ${args.join(" ")} exited with code ${exitCode}`));
        return;
      }
      resolve({ exitCode });
    });
  });
}
