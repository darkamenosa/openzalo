import { runOpenzcaCommand } from "./openzca.js";
import type { OpenzaloProbe, ResolvedOpenzaloAccount } from "./types.js";

function toErrorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

export async function probeOpenzaloAuth(params: {
  account: ResolvedOpenzaloAccount;
  timeoutMs?: number;
}): Promise<OpenzaloProbe> {
  const { account, timeoutMs } = params;
  const base: OpenzaloProbe = {
    ok: false,
    profile: account.profile,
    binary: account.zcaBinary,
  };

  try {
    await runOpenzcaCommand({
      binary: account.zcaBinary,
      profile: account.profile,
      args: ["auth", "status"],
      timeoutMs: timeoutMs ?? 8_000,
    });
    return {
      ...base,
      ok: true,
    };
  } catch (err) {
    return {
      ...base,
      error: toErrorText(err),
    };
  }
}
