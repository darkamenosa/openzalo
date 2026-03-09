import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  handleOpenzaloAcpCommand,
  parseOpenzaloAcpCommand,
} from "./commands.ts";
import {
  createOpenzaloAcpBindingRecord,
  resolveOpenzaloAcpBinding,
  upsertOpenzaloAcpBinding,
} from "./bindings.ts";

async function makeStateDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRuntime(stateDir: string) {
  return {
    state: {
      resolveStateDir: () => stateDir,
    },
  } as const;
}

function bindStateDirForTest(t: test.TestContext, stateDir: string): void {
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => {
    if (previous == null) {
      delete process.env.OPENCLAW_STATE_DIR;
      return;
    }
    process.env.OPENCLAW_STATE_DIR = previous;
  });
}

function textOf(result: Awaited<ReturnType<typeof handleOpenzaloAcpCommand>>): string {
  if (!result.handled) {
    return "";
  }
  return result.payload.text ?? "";
}

test("parseOpenzaloAcpCommand supports positional agent and cwd tokens", () => {
  assert.deepEqual(parseOpenzaloAcpCommand("/acp on codex cwd=/workspace"), {
    action: "on",
    agent: "codex",
    cwd: "/workspace",
  });
  assert.deepEqual(parseOpenzaloAcpCommand("/acp"), {
    action: "status",
  });
});

test("handleOpenzaloAcpCommand rejects enabling ACP when disabled in config", async (t) => {
  const stateDir = await makeStateDir("openzalo-acp-commands-");
  bindStateDirForTest(t, stateDir);
  t.after(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  const result = await handleOpenzaloAcpCommand({
    commandBody: "/acp on",
    account: {
      accountId: "default",
      config: {},
    } as never,
    cfg: {
      channels: {
        openzalo: {
          acpx: {
            enabled: false,
          },
        },
      },
    },
    runtime: makeRuntime(stateDir) as never,
    conversationId: "user:42",
    hasSubagentBinding: false,
  });

  assert.equal(result.handled, true);
  assert.match(textOf(result), /disabled/i);
});

test("handleOpenzaloAcpCommand status reports disabled bound session metadata", async (t) => {
  const stateDir = await makeStateDir("openzalo-acp-commands-");
  bindStateDirForTest(t, stateDir);
  t.after(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  const record = createOpenzaloAcpBindingRecord({
    accountId: "default",
    conversationId: "group:123",
    agent: "codex",
    cwd: "/workspace",
  });
  await upsertOpenzaloAcpBinding({ stateDir, record });

  const result = await handleOpenzaloAcpCommand({
    commandBody: "/acp status",
    account: {
      accountId: "default",
      config: {},
    } as never,
    cfg: {
      channels: {
        openzalo: {
          acpx: {
            enabled: false,
          },
        },
      },
    },
    runtime: makeRuntime(stateDir) as never,
    conversationId: "group:123",
    hasSubagentBinding: false,
  });

  assert.equal(result.handled, true);
  assert.match(textOf(result), /currently disabled/i);
  assert.match(textOf(result), /session=/i);
});

test("handleOpenzaloAcpCommand off removes bindings even when ACPX is disabled", async (t) => {
  const stateDir = await makeStateDir("openzalo-acp-commands-");
  bindStateDirForTest(t, stateDir);
  t.after(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  const record = createOpenzaloAcpBindingRecord({
    accountId: "default",
    conversationId: "user:42",
    agent: "codex",
    cwd: "/workspace",
  });
  await upsertOpenzaloAcpBinding({ stateDir, record });

  const result = await handleOpenzaloAcpCommand({
    commandBody: "/acp off",
    account: {
      accountId: "default",
      config: {},
    } as never,
    cfg: {
      channels: {
        openzalo: {
          acpx: {
            enabled: false,
          },
        },
      },
    },
    runtime: makeRuntime(stateDir) as never,
    conversationId: "user:42",
    hasSubagentBinding: false,
  });

  assert.equal(result.handled, true);
  assert.match(textOf(result), /now off/i);

  const resolved = await resolveOpenzaloAcpBinding({
    stateDir,
    accountId: "default",
    conversationId: "user:42",
  });
  assert.equal(resolved, null);
});
