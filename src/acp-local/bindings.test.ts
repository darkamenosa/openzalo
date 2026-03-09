import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createOpenzaloAcpBindingRecord,
  listOpenzaloAcpBindings,
  removeOpenzaloAcpBinding,
  resolveOpenzaloAcpBinding,
  upsertOpenzaloAcpBinding,
} from "./bindings.ts";

async function makeStateDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("createOpenzaloAcpBindingRecord derives stable session identifiers", () => {
  const first = createOpenzaloAcpBindingRecord({
    accountId: "default",
    conversationId: "group:123",
    agent: "Codex Main",
    cwd: "/workspace",
    now: 100,
  });
  const second = createOpenzaloAcpBindingRecord({
    accountId: "default",
    conversationId: "group:123",
    agent: "Other Agent",
    cwd: "/workspace",
    now: 200,
  });

  assert.equal(first.sessionName, second.sessionName);
  assert.match(first.sessionName, /^openzalo:default:[a-f0-9]{16}$/);
  assert.match(first.sessionKey, /^agent:codex-main:openzalo-acp:[a-f0-9]{16}$/);
  assert.match(second.sessionKey, /^agent:other-agent:openzalo-acp:[a-f0-9]{16}$/);
});

test("binding store round-trips records through stateDir", async (t) => {
  const stateDir = await makeStateDir("openzalo-acp-bindings-");
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

  const resolved = await resolveOpenzaloAcpBinding({
    stateDir,
    accountId: "default",
    conversationId: "user:42",
  });
  assert.deepEqual(resolved, record);

  const listed = await listOpenzaloAcpBindings({ stateDir });
  assert.deepEqual(listed, [record]);

  const removed = await removeOpenzaloAcpBinding({
    stateDir,
    accountId: "default",
    conversationId: "user:42",
  });
  assert.deepEqual(removed, record);

  const afterRemove = await resolveOpenzaloAcpBinding({
    stateDir,
    accountId: "default",
    conversationId: "user:42",
  });
  assert.equal(afterRemove, null);
});
