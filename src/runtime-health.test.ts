import assert from "node:assert/strict";
import test from "node:test";
import {
  clearOpenzaloRuntimeHealthState,
  getOpenzaloRuntimeHealthState,
  markOpenzaloConnected,
  registerOpenzaloReconnectHandler,
  requestOpenzaloReconnect,
} from "./runtime-health.ts";

test("requestOpenzaloReconnect records degraded state and notifies handlers", () => {
  clearOpenzaloRuntimeHealthState();
  let reconnectReason = "";
  const dispose = registerOpenzaloReconnectHandler("default", (reason) => {
    reconnectReason = reason;
  });

  const requested = requestOpenzaloReconnect({
    accountId: "default",
    reason: "500 auth_unavailable: no auth available",
  });

  const state = getOpenzaloRuntimeHealthState("default");
  assert.equal(requested, true);
  assert.equal(reconnectReason, "500 auth_unavailable: no auth available");
  assert.equal(state?.connected, false);
  assert.equal(state?.lastError, "500 auth_unavailable: no auth available");

  dispose();
  clearOpenzaloRuntimeHealthState();
});

test("markOpenzaloConnected clears prior degraded state", () => {
  clearOpenzaloRuntimeHealthState();
  requestOpenzaloReconnect({
    accountId: "default",
    reason: "500 auth_unavailable: no auth available",
  });

  markOpenzaloConnected({
    accountId: "default",
    at: 42,
    reconnectAttempts: 0,
  });

  const state = getOpenzaloRuntimeHealthState("default");
  assert.equal(state?.connected, true);
  assert.equal(state?.lastConnectedAt, 42);
  assert.equal(state?.lastEventAt, 42);
  assert.equal(state?.lastError, null);
  assert.equal(state?.reconnectAttempts, 0);

  clearOpenzaloRuntimeHealthState();
});
