import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  bindOpenzaloSubagentSession,
  replaceOpenzaloSubagentBindings,
  resolveOpenzaloBoundOriginBySession,
  resolveOpenzaloBoundSessionByTarget,
  snapshotOpenzaloSubagentBindings,
  unbindOpenzaloSubagentSessionByKey,
} from "./subagent-bindings.ts";

test.beforeEach(() => {
  __testing.resetOpenzaloSubagentBindingsForTests();
});

test("bindOpenzaloSubagentSession resolves from conversation target", () => {
  const bound = bindOpenzaloSubagentSession({
    accountId: "default",
    to: "group:1471383327500481391",
    childSessionKey: "agent:main:subagent:abc",
    agentId: "main",
    label: "plan",
  });
  assert.ok(bound);
  assert.equal(bound.to, "group:1471383327500481391");
  assert.equal(bound.threadId, "1471383327500481391");

  const resolved = resolveOpenzaloBoundSessionByTarget({
    accountId: "default",
    to: "group:1471383327500481391",
  });
  assert.ok(resolved);
  assert.equal(resolved.childSessionKey, "agent:main:subagent:abc");
  assert.equal(resolved.agentId, "main");
});

test("resolveOpenzaloBoundOriginBySession returns delivery origin metadata", () => {
  bindOpenzaloSubagentSession({
    accountId: "default",
    to: "user:20002",
    childSessionKey: "agent:main:subagent:def",
    agentId: "main",
  });

  const resolved = resolveOpenzaloBoundOriginBySession({
    childSessionKey: "agent:main:subagent:def",
    accountId: "default",
  });
  assert.ok(resolved);
  assert.equal(resolved.to, "user:20002");
  assert.equal(resolved.threadId, "20002");
  assert.equal(resolved.isGroup, false);
});

test("unbindOpenzaloSubagentSessionByKey removes conversation binding", () => {
  bindOpenzaloSubagentSession({
    accountId: "default",
    to: "group:999",
    childSessionKey: "agent:main:subagent:ghi",
    agentId: "main",
  });

  const removed = unbindOpenzaloSubagentSessionByKey({
    childSessionKey: "agent:main:subagent:ghi",
  });
  assert.equal(removed.length, 1);
  assert.equal(removed[0]?.to, "group:999");

  const resolved = resolveOpenzaloBoundSessionByTarget({
    accountId: "default",
    to: "group:999",
  });
  assert.equal(resolved, null);
});

test("binding TTL expires when ttlMs is set", async () => {
  bindOpenzaloSubagentSession({
    accountId: "default",
    to: "user:30003",
    childSessionKey: "agent:main:subagent:jkl",
    agentId: "main",
    ttlMs: 5,
  });
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 10);
  });

  const resolved = resolveOpenzaloBoundSessionByTarget({
    accountId: "default",
    to: "user:30003",
  });
  assert.equal(resolved, null);
});

test("bindOpenzaloSubagentSession rejects invalid target text", () => {
  const bound = bindOpenzaloSubagentSession({
    accountId: "default",
    to: "  ",
    childSessionKey: "agent:main:subagent:bad",
    agentId: "main",
  });
  assert.equal(bound, null);
});

test("replaceOpenzaloSubagentBindings restores valid records and skips invalid rows", () => {
  const now = Date.now();
  const restored = replaceOpenzaloSubagentBindings(
    [
      {
        accountId: "default",
        to: "group:123",
        childSessionKey: "agent:main:subagent:one",
        agentId: "main",
        boundAt: now - 1000,
        lastTouchedAt: now - 500,
      },
      {
        accountId: "default",
        to: "  ",
        childSessionKey: "agent:main:subagent:two",
        agentId: "main",
      },
      {
        accountId: "default",
        to: "user:456",
        childSessionKey: "agent:main:subagent:three",
        agentId: "main",
        expiresAt: now - 1,
      },
    ],
    now,
  );

  assert.equal(restored, 1);
  const snapshot = snapshotOpenzaloSubagentBindings(now);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.to, "group:123");
});
