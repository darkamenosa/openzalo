import { runOpenzcaCommand, runOpenzcaJson } from "./openzca.js";
import { requestOpenzaloReconnect } from "./runtime-health.js";
import type { ResolvedOpenzaloAccount } from "./types.js";

type OpenzcaCommandDeps = {
  runCommand?: typeof runOpenzcaCommand;
};

type OpenzcaJsonDeps = {
  runJson?: typeof runOpenzcaJson;
};

const OPENZCA_AUTH_FAILURE_PATTERNS = [
  /\bauth_unavailable\b/i,
  /\bno auth available\b/i,
  /\bnot logged in\b/i,
  /\blogin required\b/i,
  /\bauth expired\b/i,
  /\bsession expired\b/i,
];

function toErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}

export function isOpenzcaAuthFailureError(error: unknown): boolean {
  const text = toErrorText(error);
  return OPENZCA_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

function handleOpenzcaAccountCommandFailure(params: {
  account: ResolvedOpenzaloAccount;
  error: unknown;
}): void {
  if (!isOpenzcaAuthFailureError(params.error)) {
    return;
  }
  requestOpenzaloReconnect({
    accountId: params.account.accountId,
    reason: toErrorText(params.error),
  });
}

export async function runOpenzcaAccountCommand(
  params: Parameters<typeof runOpenzcaCommand>[0] & {
    account: ResolvedOpenzaloAccount;
    deps?: OpenzcaCommandDeps;
  },
) {
  const runCommand = params.deps?.runCommand ?? runOpenzcaCommand;
  try {
    return await runCommand({
      binary: params.binary,
      profile: params.profile,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
  } catch (error) {
    handleOpenzcaAccountCommandFailure({
      account: params.account,
      error,
    });
    throw error;
  }
}

export async function runOpenzcaAccountJson<T>(
  params: Parameters<typeof runOpenzcaJson>[0] & {
    account: ResolvedOpenzaloAccount;
    deps?: OpenzcaJsonDeps;
  },
): Promise<T> {
  const runJson = params.deps?.runJson ?? runOpenzcaJson;
  try {
    return await runJson<T>({
      binary: params.binary,
      profile: params.profile,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
  } catch (error) {
    handleOpenzcaAccountCommandFailure({
      account: params.account,
      error,
    });
    throw error;
  }
}
