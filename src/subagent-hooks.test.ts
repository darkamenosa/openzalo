import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  __testing,
  resolveOpenzaloBoundOriginBySession,
  resolveOpenzaloBoundSessionByTarget,
} from "./subagent-bindings.ts";
import { registerOpenzaloSubagentHooks } from "./subagent-hooks.ts";

const tempStateDirs = new Set<string>();

type HookHandler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

function registerHandlers(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, HookHandler>();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openzalo-subagent-hooks-"));
  tempStateDirs.add(stateDir);
  registerOpenzaloSubagentHooks({
    config,
    on: (hookName: string, handler: HookHandler) => {
      handlers.set(hookName, handler);
    },
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
      logging: {
        getChildLogger: () => ({
          warn: () => undefined,
        }),
      },
    },
  } as never);
  return handlers;
}

function getHandler(handlers: Map<string, HookHandler>, name: string): HookHandler {
  const handler = handlers.get(name);
  if (!handler) {
    throw new Error(`missing ${name} hook handler`);
  }
  return handler;
}

test.beforeEach(() => {
  __testing.resetOpenzaloSubagentBindingsForTests();
});

test.afterEach(() => {
  for (const stateDir of tempStateDirs) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  tempStateDirs.clear();
});

test("registerOpenzaloSubagentHooks wires expected lifecycle handlers", () => {
  const handlers = registerHandlers();
  assert.equal(handlers.has("subagent_spawning"), true);
  assert.equal(handlers.has("subagent_delivery_target"), true);
  assert.equal(handlers.has("subagent_ended"), true);
});

test("subagent_spawning binds OpenZalo target session", async () => {
  const handlers = registerHandlers({
    channels: {
      openzalo: {
        threadBindings: {
          enabled: true,
          spawnSubagentSessions: true,
        },
      },
    },
  });

  const handler = getHandler(handlers, "subagent_spawning");
  const result = await handler({
    threadRequested: true,
    requester: {
      channel: "openzalo",
      accountId: "default",
      to: "group:123456",
      threadId: "123456",
    },
    childSessionKey: "agent:main:subagent:abc",
    agentId: "main",
    label: "worker",
  });

  assert.deepEqual(result, { status: "ok", threadBindingReady: true });
  const binding = resolveOpenzaloBoundSessionByTarget({
    accountId: "default",
    to: "group:123456",
  });
  assert.ok(binding);
  assert.equal(binding.childSessionKey, "agent:main:subagent:abc");
});

test(
  "subagent_spawning returns error when spawnSubagentSessions is disabled",
  async () => {
    const handlers = registerHandlers({
      channels: {
        openzalo: {
          threadBindings: {
            enabled: true,
            spawnSubagentSessions: false,
          },
        },
      },
    });

    const handler = getHandler(handlers, "subagent_spawning");
    const result = await handler({
      threadRequested: true,
      requester: {
        channel: "openzalo",
        accountId: "default",
        to: "user:20001",
      },
      childSessionKey: "agent:main:subagent:def",
      agentId: "main",
    });

    assert.deepEqual(result, {
      status: "error",
      error:
        "OpenZalo thread-bound subagent spawns are disabled (set channels.openzalo.threadBindings.spawnSubagentSessions=true).",
    });
    const binding = resolveOpenzaloBoundSessionByTarget({
      accountId: "default",
      to: "user:20001",
    });
    assert.equal(binding, null);
  },
);

test(
  "subagent_delivery_target returns requester origin from binding",
  async () => {
    const handlers = registerHandlers();
    const spawnHandler = getHandler(handlers, "subagent_spawning");
    await spawnHandler({
      threadRequested: true,
      requester: {
        channel: "openzalo",
        accountId: "default",
        to: "user:20002",
      },
      childSessionKey: "agent:main:subagent:xyz",
      agentId: "main",
    });

    const deliveryHandler = getHandler(handlers, "subagent_delivery_target");
    const result = deliveryHandler({
      expectsCompletionMessage: true,
      requesterOrigin: {
        channel: "openzalo",
        accountId: "default",
      },
      childSessionKey: "agent:main:subagent:xyz",
    }) as { origin?: { channel: string; accountId: string; to: string; threadId: string } } | undefined;

    assert.ok(result?.origin);
    assert.equal(result?.origin?.channel, "openzalo");
    assert.equal(result?.origin?.accountId, "default");
    assert.equal(result?.origin?.to, "user:20002");
    assert.equal(result?.origin?.threadId, "20002");
  },
);

test("subagent_ended unbinds session routes", async () => {
  const handlers = registerHandlers();
  const spawnHandler = getHandler(handlers, "subagent_spawning");
  await spawnHandler({
    threadRequested: true,
    requester: {
      channel: "openzalo",
      accountId: "default",
      to: "group:56789",
      threadId: "56789",
    },
    childSessionKey: "agent:main:subagent:gone",
    agentId: "main",
  });

  const endedHandler = getHandler(handlers, "subagent_ended");
  endedHandler({
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:gone",
    accountId: "default",
  });

  const boundByTarget = resolveOpenzaloBoundSessionByTarget({
    accountId: "default",
    to: "group:56789",
  });
  assert.equal(boundByTarget, null);
  const boundBySession = resolveOpenzaloBoundOriginBySession({
    childSessionKey: "agent:main:subagent:gone",
    accountId: "default",
  });
  assert.equal(boundBySession, null);
});
