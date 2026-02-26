import assert from "node:assert/strict";
import test from "node:test";
import { resolveListGroupMembersFallbackTarget } from "./actions-target.ts";

test("resolveListGroupMembersFallbackTarget uses normalized groupId aliases", () => {
  const resolved = resolveListGroupMembersFallbackTarget({
    groupId: "g-4495129751473230693",
  });
  assert.equal(resolved, "group:4495129751473230693");
});

test("resolveListGroupMembersFallbackTarget accepts raw group id in threadId", () => {
  const resolved = resolveListGroupMembersFallbackTarget({
    threadId: "4495129751473230693",
  });
  assert.equal(resolved, "group:4495129751473230693");
});

test("resolveListGroupMembersFallbackTarget falls back to context target", () => {
  const resolved = resolveListGroupMembersFallbackTarget(
    {
      groupId: "user:123",
    },
    "group:4495129751473230693",
  );
  assert.equal(resolved, "group:4495129751473230693");
});
