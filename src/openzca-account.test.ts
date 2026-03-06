import assert from "node:assert/strict";
import test from "node:test";
import { runOpenzcaAccountCommand } from "./openzca-account.ts";
import {
  clearOpenzaloRuntimeHealthState,
  getOpenzaloRuntimeHealthState,
  registerOpenzaloReconnectHandler,
} from "./runtime-health.ts";

const account = {
  accountId: "default",
  enabled: true,
  configured: true,
  profile: "default",
  zcaBinary: "openzca",
  config: {},
};

test("runOpenzcaAccountCommand triggers reconnect on auth failures", async () => {
  clearOpenzaloRuntimeHealthState();
  let reconnectReason = "";
  const dispose = registerOpenzaloReconnectHandler("default", (reason) => {
    reconnectReason = reason;
  });

  await assert.rejects(
    runOpenzcaAccountCommand({
      account,
      binary: "openzca",
      profile: "default",
      args: ["msg", "send", "123", "hi"],
      deps: {
        runCommand: async () => {
          throw new Error("500 auth_unavailable: no auth available");
        },
      },
    }),
    /auth_unavailable/i,
  );

  const state = getOpenzaloRuntimeHealthState("default");
  assert.equal(reconnectReason, "500 auth_unavailable: no auth available");
  assert.equal(state?.connected, false);
  assert.equal(state?.lastError, "500 auth_unavailable: no auth available");

  dispose();
  clearOpenzaloRuntimeHealthState();
});

test("runOpenzcaAccountCommand ignores non-auth failures", async () => {
  clearOpenzaloRuntimeHealthState();
  let called = false;
  const dispose = registerOpenzaloReconnectHandler("default", () => {
    called = true;
  });

  await assert.rejects(
    runOpenzcaAccountCommand({
      account,
      binary: "openzca",
      profile: "default",
      args: ["msg", "send", "123", "hi"],
      deps: {
        runCommand: async () => {
          throw new Error("rate limited");
        },
      },
    }),
    /rate limited/i,
  );

  assert.equal(called, false);
  assert.equal(getOpenzaloRuntimeHealthState("default"), undefined);

  dispose();
  clearOpenzaloRuntimeHealthState();
});
