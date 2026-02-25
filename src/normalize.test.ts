import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOpenzaloOutboundTarget,
  normalizeOpenzaloMessagingTarget,
  resolveOpenzaloDirectPeerId,
} from "./normalize.ts";

test("resolveOpenzaloDirectPeerId prefers sender when dmPeerId is group alias", () => {
  const resolved = resolveOpenzaloDirectPeerId({
    dmPeerId: "g-1471383327500481391",
    senderId: "1471383327500481391",
    toId: "self-1",
    threadId: "g-1471383327500481391",
  });

  assert.equal(resolved, "1471383327500481391");
});

test("resolveOpenzaloDirectPeerId supports user aliases", () => {
  const resolved = resolveOpenzaloDirectPeerId({
    dmPeerId: "openzalo:user:20002",
    senderId: "10001",
  });

  assert.equal(resolved, "20002");
});

test("resolveOpenzaloDirectPeerId falls back to id when only group alias is available", () => {
  const resolved = resolveOpenzaloDirectPeerId({
    dmPeerId: "openzalo:g-20002",
  });

  assert.equal(resolved, "20002");
});

test("formatOpenzaloOutboundTarget uses explicit user/group prefixes", () => {
  const direct = formatOpenzaloOutboundTarget({
    threadId: "20002",
    isGroup: false,
  });
  const group = formatOpenzaloOutboundTarget({
    threadId: "30003",
    isGroup: true,
  });

  assert.equal(direct, "user:20002");
  assert.equal(group, "group:30003");
});

test("normalizeOpenzaloMessagingTarget accepts ozl prefix", () => {
  const normalized = normalizeOpenzaloMessagingTarget("ozl:group:888");
  assert.equal(normalized, "group:888");
});
