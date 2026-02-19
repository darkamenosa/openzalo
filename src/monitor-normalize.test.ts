import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOpenzcaInboundPayload } from "./monitor-normalize.ts";

test("normalizes direct message and resolves dmPeerId", () => {
  const payload = {
    threadId: "20002",
    senderId: "10001",
    toId: "self-1",
    content: "hello",
    timestamp: 1_735_000_000,
    chatType: "user",
  };

  const normalized = normalizeOpenzcaInboundPayload(payload, "self-1");

  assert.ok(normalized);
  assert.equal(normalized?.isGroup, false);
  assert.equal(normalized?.senderId, "10001");
  assert.equal(normalized?.dmPeerId, "10001");
  assert.equal(normalized?.text, "hello");
});

test("drops inbound payload when senderId matches self id", () => {
  const payload = {
    threadId: "20002",
    senderId: "self-1",
    content: "echo",
    chatType: "user",
  };

  const normalized = normalizeOpenzcaInboundPayload(payload, "self-1");
  assert.equal(normalized, null);
});

test("drops inbound payload when senderId is self sentinel 0", () => {
  const payload = {
    threadId: "20002",
    senderId: "0",
    content: "echo",
    chatType: "user",
  };

  const normalized = normalizeOpenzcaInboundPayload(payload, "self-1");
  assert.equal(normalized, null);
});

test("extracts mention ids from payload and metadata variants", () => {
  const payload = {
    threadId: "1426870657825641161",
    senderId: "1471383327500481391",
    chatType: "group",
    content: "@bot hi",
    mentionIds: ["555", 666],
    mentions: [{ uid: "777" }, { userId: 888 }],
    metadata: {
      mentions: [{ uid: "999" }],
      mentionList: [{ user_id: "111" }],
    },
  };

  const normalized = normalizeOpenzcaInboundPayload(payload, "self-1");
  assert.ok(normalized);
  assert.equal(normalized?.isGroup, true);
  assert.deepEqual(
    normalized?.mentionIds.slice().sort(),
    ["111", "555", "666", "777", "888", "999"].sort(),
  );
});
