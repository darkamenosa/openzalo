import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureOpenzaloAcpxSession,
  getOpenzaloAcpxStatus,
  promptOpenzaloAcpxSession,
} from "./client.ts";
import type { ResolvedOpenzaloAcpxConfig } from "./types.ts";

const baseConfig: ResolvedOpenzaloAcpxConfig = {
  enabled: true,
  command: "acpx",
  agent: "codex",
  cwd: "/workspace",
  permissionMode: "approve-all",
  nonInteractivePermissions: "fail",
};

test("ensureOpenzaloAcpxSession falls back to sessions new when ensure returns no ids", async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

  const result = await ensureOpenzaloAcpxSession(
    {
      config: baseConfig,
      sessionName: "openzalo:default:abc123",
      agent: "codex",
      cwd: "/workspace",
    },
    {
      runCommand: async (options) => {
        calls.push({
          command: options.command,
          args: options.args,
          cwd: options.cwd,
        });
        return calls.length === 1
          ? { stdout: "{\"type\":\"noop\"}\n", stderr: "", exitCode: 0 }
          : { stdout: "{\"acpxSessionId\":\"sess-1\"}\n", stderr: "", exitCode: 0 };
      },
    },
  );

  assert.equal(result.sessionName, "openzalo:default:abc123");
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.args.includes("sessions"));
  assert.ok(calls[0]?.args.includes("ensure"));
  assert.ok(calls[1]?.args.includes("new"));
});

test("promptOpenzaloAcpxSession uses acpx permission flags and aggregates output", async () => {
  let seenArgs: string[] = [];

  const result = await promptOpenzaloAcpxSession(
    {
      config: baseConfig,
      sessionName: "openzalo:default:abc123",
      agent: "codex",
      cwd: "/workspace",
      text: "hello",
    },
    {
      runStreaming: async (options) => {
        seenArgs = options.args;
        await options.onJsonLine?.({
          type: "agent_message_chunk",
          content: "Hello ",
        });
        await options.onJsonLine?.({
          type: "agent_message_chunk",
          content: "world",
        });
        await options.onJsonLine?.({
          type: "tool_call",
          title: "shell",
          status: "running",
        });
        return { exitCode: 0, stderr: "" };
      },
    },
  );

  assert.equal(result.text, "Hello world");
  assert.equal(result.statusText, "shell (running)");
  assert.ok(seenArgs.includes("--approve-all"));
  assert.ok(!seenArgs.includes("--permission-mode"));
  assert.ok(seenArgs.includes("--non-interactive-permissions"));
  assert.ok(seenArgs.includes("fail"));
});

test("getOpenzaloAcpxStatus summarizes structured status output", async () => {
  const result = await getOpenzaloAcpxStatus(
    {
      config: baseConfig,
      sessionName: "openzalo:default:abc123",
      agent: "codex",
      cwd: "/workspace",
    },
    {
      runCommand: async () => ({
        stdout:
          "{\"status\":\"running\",\"acpxSessionId\":\"sess-1\",\"acpxRecordId\":\"rec-1\",\"pid\":123}\n",
        stderr: "",
        exitCode: 0,
      }),
    },
  );

  assert.equal(result.summary, "status=running acpxSessionId=sess-1 acpxRecordId=rec-1 pid=123");
});
