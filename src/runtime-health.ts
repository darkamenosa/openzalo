import { clearOpenzaloProbeCacheForAccount } from "./probe.js";

export type OpenzaloRuntimeHealthState = {
  connected?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
};

type OpenzaloReconnectHandler = (reason: string) => void;

const runtimeHealthByAccount = new Map<string, OpenzaloRuntimeHealthState>();
const reconnectHandlers = new Map<string, Set<OpenzaloReconnectHandler>>();

function normalizeAccountId(accountId: string): string {
  return accountId.trim();
}

export function clearOpenzaloRuntimeHealthState(accountId?: string): void {
  const normalized = accountId ? normalizeAccountId(accountId) : "";
  if (!normalized) {
    runtimeHealthByAccount.clear();
    reconnectHandlers.clear();
    return;
  }
  runtimeHealthByAccount.delete(normalized);
  reconnectHandlers.delete(normalized);
}

export function getOpenzaloRuntimeHealthState(
  accountId: string,
): OpenzaloRuntimeHealthState | undefined {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return undefined;
  }
  const state = runtimeHealthByAccount.get(normalized);
  return state ? { ...state } : undefined;
}

export function patchOpenzaloRuntimeHealthState(
  accountId: string,
  patch: OpenzaloRuntimeHealthState,
): OpenzaloRuntimeHealthState | undefined {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return undefined;
  }
  const current = runtimeHealthByAccount.get(normalized) ?? {};
  const next = {
    ...current,
    ...patch,
  };
  runtimeHealthByAccount.set(normalized, next);
  return { ...next };
}

export function recordOpenzaloStreamActivity(accountId: string, at = Date.now()): void {
  patchOpenzaloRuntimeHealthState(accountId, {
    lastEventAt: at,
  });
}

export function markOpenzaloConnected(params: {
  accountId: string;
  at?: number;
  reconnectAttempts?: number | null;
}): void {
  const at = params.at ?? Date.now();
  clearOpenzaloProbeCacheForAccount(params.accountId);
  patchOpenzaloRuntimeHealthState(params.accountId, {
    connected: true,
    reconnectAttempts: params.reconnectAttempts ?? 0,
    lastConnectedAt: at,
    lastEventAt: at,
    lastError: null,
  });
}

export function markOpenzaloDisconnected(params: {
  accountId: string;
  reason?: string | null;
  reconnectAttempts?: number | null;
}): void {
  patchOpenzaloRuntimeHealthState(params.accountId, {
    connected: false,
    reconnectAttempts: params.reconnectAttempts,
    ...(params.reason !== undefined ? { lastError: params.reason } : {}),
  });
}

export function registerOpenzaloReconnectHandler(
  accountId: string,
  handler: OpenzaloReconnectHandler,
): () => void {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return () => {};
  }
  const handlers = reconnectHandlers.get(normalized) ?? new Set<OpenzaloReconnectHandler>();
  handlers.add(handler);
  reconnectHandlers.set(normalized, handlers);
  return () => {
    const current = reconnectHandlers.get(normalized);
    if (!current) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      reconnectHandlers.delete(normalized);
    }
  };
}

export function requestOpenzaloReconnect(params: { accountId: string; reason: string }): boolean {
  const normalized = normalizeAccountId(params.accountId);
  if (!normalized) {
    return false;
  }
  clearOpenzaloProbeCacheForAccount(normalized);
  markOpenzaloDisconnected({
    accountId: normalized,
    reason: params.reason,
  });
  const handlers = reconnectHandlers.get(normalized);
  if (!handlers || handlers.size === 0) {
    return false;
  }
  for (const handler of handlers) {
    try {
      handler(params.reason);
    } catch {
      // Ignore reconnect hook failures; the caller already has the original error.
    }
  }
  return true;
}
