import { spawn, type SpawnOptions } from "node:child_process";
import { stripAnsi } from "openclaw/plugin-sdk";
import type { ZcaResult, ZcaRunOptions } from "./types.js";

const PRIMARY_OPENZCA_BINARY = process.env.OPENZCA_BINARY?.trim() || "openzca";
const DEFAULT_TIMEOUT = 30000;

type ErrorWithCode = Error & { code?: string | number };
type ZcaChildProcess = ReturnType<typeof spawn>;
type OpenzcaSpawnResult = { proc: ZcaChildProcess; binary: string };

export function resolveOpenzcaProfileEnv(): string | undefined {
  const fromOpenzca = process.env.OPENZCA_PROFILE?.trim();
  if (fromOpenzca) {
    return fromOpenzca;
  }
  return process.env.ZCA_PROFILE?.trim();
}

function resolveOpenzcaBinaries(): string[] {
  const primary = PRIMARY_OPENZCA_BINARY || "openzca";
  return [primary];
}

function isNotFoundError(error: unknown): boolean {
  const code = (error as ErrorWithCode)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function createOpenzcaProcess(
  binary: string,
  args: string[],
  options: SpawnOptions,
): Promise<ZcaChildProcess> {
  return new Promise((resolve, reject) => {
    let proc: ZcaChildProcess;

    try {
      proc = spawn(binary, args, options);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const onSpawn = () => {
      proc.removeListener("error", onError);
      resolve(proc);
    };

    const onError = (error: Error) => {
      proc.removeListener("spawn", onSpawn);
      reject(error);
    };

    proc.once("spawn", onSpawn);
    proc.once("error", onError);
  });
}

async function spawnOpenzcaProcess(
  args: string[],
  options: SpawnOptions,
): Promise<OpenzcaSpawnResult> {
  const candidates = resolveOpenzcaBinaries();
  let lastError: Error | null = null;

  for (const binary of candidates) {
    try {
      const proc = await createOpenzcaProcess(binary, args, options);
      return { proc, binary };
    } catch (error) {
      if (isNotFoundError(error)) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error(`No working openzca binary found. Tried: ${candidates.join(", ")}`);
}

function buildArgs(args: string[], options?: ZcaRunOptions): string[] {
  const result: string[] = [];
  const profile = options?.profile || resolveOpenzcaProfileEnv();
  if (profile) {
    result.push("--profile", profile);
  }
  result.push(...args);
  return result;
}

export async function runOpenzca(args: string[], options?: ZcaRunOptions): Promise<ZcaResult> {
  const fullArgs = buildArgs(args, options);
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: options?.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    };

    spawnOpenzcaProcess(fullArgs, spawnOpts)
      .then(({ proc }) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
        let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
        let forceResolveTimer: ReturnType<typeof setTimeout> | null = null;
        const timeoutMessage = `Command timed out after ${timeout}ms`;

        const clearTimers = () => {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          if (sigkillTimer) {
            clearTimeout(sigkillTimer);
            sigkillTimer = null;
          }
          if (forceResolveTimer) {
            clearTimeout(forceResolveTimer);
            forceResolveTimer = null;
          }
        };

        const settle = (result: ZcaResult): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimers();
          resolve(result);
        };

        const triggerTimeout = () => {
          if (settled) {
            return;
          }
          timedOut = true;
          try {
            proc.kill("SIGTERM");
          } catch {
            // Ignore kill errors and rely on force-resolve timer below.
          }
          sigkillTimer = setTimeout(() => {
            if (settled) {
              return;
            }
            try {
              proc.kill("SIGKILL");
            } catch {
              // Ignore SIGKILL errors and rely on force-resolve timer below.
            }
          }, 5000);
          forceResolveTimer = setTimeout(() => {
            if (settled) {
              return;
            }
            const trimmedStderr = stderr.trim();
            settle({
              ok: false,
              stdout: stdout.trim(),
              stderr: trimmedStderr ? `${trimmedStderr}\n${timeoutMessage}` : timeoutMessage,
              exitCode: 124,
            });
          }, 10000);
        };

        timeoutTimer = setTimeout(triggerTimeout, timeout);

        proc.stdout?.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          const trimmedStdout = stdout.trim();
          const trimmedStderr = stderr.trim();
          if (timedOut) {
            settle({
              ok: false,
              stdout: trimmedStdout,
              stderr: trimmedStderr || timeoutMessage,
              exitCode: 124,
            });
            return;
          }
          settle({
            ok: code === 0,
            stdout: trimmedStdout,
            stderr: trimmedStderr,
            exitCode: code ?? 1,
          });
        });

        proc.on("error", (err) => {
          settle({
            ok: false,
            stdout: "",
            stderr: err.message,
            exitCode: 1,
          });
        });
      })
      .catch((err) => {
        resolve({
          ok: false,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        });
      });
  });
}

export function runOpenzcaInteractive(args: string[], options?: ZcaRunOptions): Promise<ZcaResult> {
  const fullArgs = buildArgs(args, options);

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: options?.cwd,
      env: { ...process.env },
      stdio: "inherit",
    };

    spawnOpenzcaProcess(fullArgs, spawnOpts)
      .then(({ proc }) => {
        proc.on("close", (code) => {
          resolve({
            ok: code === 0,
            stdout: "",
            stderr: "",
            exitCode: code ?? 1,
          });
        });

        proc.on("error", (err) => {
          resolve({
            ok: false,
            stdout: "",
            stderr: err.message,
            exitCode: 1,
          });
        });
      })
      .catch((err) => {
        resolve({
          ok: false,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        });
      });
  });
}

export async function checkOpenzcaInstalled(): Promise<boolean> {
  const result = await runOpenzca(["--version"], { timeout: 5000 });
  return result.ok;
}

export type OpenzcaStreamingOptions = ZcaRunOptions & {
  onData?: (data: string) => void;
  onError?: (err: Error) => void;
};

export async function runOpenzcaStreaming(
  args: string[],
  options?: OpenzcaStreamingOptions,
): Promise<{ proc: ReturnType<typeof spawn>; promise: Promise<ZcaResult> }> {
  const fullArgs = buildArgs(args, options);

  const spawnOpts: SpawnOptions = {
    cwd: options?.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  };

  let stdout = "";
  let stderr = "";
  const { proc } = await spawnOpenzcaProcess(fullArgs, spawnOpts);

  const promise = new Promise<ZcaResult>((resolve) => {
    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      options?.onData?.(text);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      options?.onError?.(err);
      resolve({
        ok: false,
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });

  return { proc, promise };
}

export function parseJsonOutput<T>(stdout: string): T | null {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    const cleaned = stripAnsi(stdout);

    try {
      return JSON.parse(cleaned) as T;
    } catch {
      const lines = cleaned.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("{") || line.startsWith("[")) {
          const jsonCandidate = lines.slice(i).join("\n").trim();
          try {
            return JSON.parse(jsonCandidate) as T;
          } catch {
            continue;
          }
        }
      }
      return null;
    }
  }
}
