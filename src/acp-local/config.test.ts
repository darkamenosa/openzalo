import assert from "node:assert/strict";
import test from "node:test";
import { resolveOpenzaloAcpxConfig } from "./config.ts";

test("resolveOpenzaloAcpxConfig merges root and account overrides", () => {
  const resolved = resolveOpenzaloAcpxConfig({
    cfg: {
      channels: {
        openzalo: {
          acpx: {
            command: "root-acpx",
            agent: "root-agent",
            cwd: "/root",
            timeoutSeconds: 45,
            permissionMode: "approve-reads",
            nonInteractivePermissions: "deny",
          },
          accounts: {
            work: {
              acpx: {
                enabled: false,
                agent: "work-agent",
                cwd: "/work",
              },
            },
          },
        },
      },
    },
    accountId: "work",
  });

  assert.deepEqual(resolved, {
    enabled: false,
    command: "root-acpx",
    agent: "work-agent",
    cwd: "/work",
    timeoutSeconds: 45,
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
  });
});

test("resolveOpenzaloAcpxConfig provides defaults when no config is set", () => {
  const resolved = resolveOpenzaloAcpxConfig({
    cfg: {},
    accountId: "default",
  });

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.command, "acpx");
  assert.equal(resolved.agent, "codex");
  assert.equal(resolved.cwd, process.cwd());
  assert.equal(resolved.permissionMode, "approve-all");
  assert.equal(resolved.nonInteractivePermissions, "fail");
  assert.equal(resolved.timeoutSeconds, undefined);
});
