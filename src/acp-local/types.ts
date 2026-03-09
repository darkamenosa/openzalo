import type { ReplyPayload } from "openclaw/plugin-sdk";

export const OPENZALO_ACPX_PERMISSION_MODES = [
  "approve-all",
  "approve-reads",
  "deny-all",
] as const;
export type OpenzaloAcpxPermissionMode = (typeof OPENZALO_ACPX_PERMISSION_MODES)[number];

export const OPENZALO_ACPX_NON_INTERACTIVE_POLICIES = ["deny", "fail"] as const;
export type OpenzaloAcpxNonInteractivePermissions =
  (typeof OPENZALO_ACPX_NON_INTERACTIVE_POLICIES)[number];

export type OpenzaloAcpxConfig = {
  enabled?: boolean;
  command?: string;
  agent?: string;
  cwd?: string;
  timeoutSeconds?: number;
  permissionMode?: OpenzaloAcpxPermissionMode;
  nonInteractivePermissions?: OpenzaloAcpxNonInteractivePermissions;
};

export type ResolvedOpenzaloAcpxConfig = {
  enabled: boolean;
  command: string;
  agent: string;
  cwd: string;
  timeoutSeconds?: number;
  permissionMode: OpenzaloAcpxPermissionMode;
  nonInteractivePermissions: OpenzaloAcpxNonInteractivePermissions;
};

export type OpenzaloAcpBindingRecord = {
  accountId: string;
  conversationId: string;
  sessionName: string;
  sessionKey: string;
  agent: string;
  cwd: string;
  boundAt: number;
  updatedAt: number;
};

export type OpenzaloAcpEnsureResult = {
  sessionName: string;
  agent: string;
  cwd: string;
};

export type OpenzaloAcpPromptResult = {
  text: string;
  statusText?: string;
};

export type OpenzaloAcpStatusResult = {
  summary: string;
  details?: Record<string, unknown>;
};

export type OpenzaloAcpCommandResult =
  | { handled: false }
  | {
      handled: true;
      payload: ReplyPayload;
      binding?: OpenzaloAcpBindingRecord | null;
    };
