import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireOpenzaloOutboundDedupeSlot,
  releaseOpenzaloOutboundDedupeSlot,
  resetOpenzaloOutboundDedupeForTests,
} from "./outbound-dedupe.ts";

test("blocks duplicate outbound while send is inflight", () => {
  resetOpenzaloOutboundDedupeForTests();

  const first = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: "hello",
    },
    1_000,
  );
  assert.equal(first.acquired, true);

  const second = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: "hello",
    },
    1_005,
  );
  assert.equal(second.acquired, false);
  if (!second.acquired) {
    assert.equal(second.reason, "inflight");
  }
});

test("keeps a short recent dedupe window after successful send", () => {
  resetOpenzaloOutboundDedupeForTests();

  const first = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "group:42",
      kind: "media",
      text: "caption",
      mediaRef: "https://example.com/a.jpg",
    },
    2_000,
  );
  assert.equal(first.acquired, true);
  if (!first.acquired) {
    return;
  }

  releaseOpenzaloOutboundDedupeSlot({
    ticket: first.ticket,
    sent: true,
    nowMs: 2_100,
  });

  const duplicate = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "group:42",
      kind: "media",
      text: "caption",
      mediaRef: "https://example.com/a.jpg",
    },
    10_000,
  );
  assert.equal(duplicate.acquired, false);
  if (!duplicate.acquired) {
    assert.equal(duplicate.reason, "recent");
  }

  const afterTtl = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "group:42",
      kind: "media",
      text: "caption",
      mediaRef: "https://example.com/a.jpg",
    },
    20_000,
  );
  assert.equal(afterTtl.acquired, true);
});

test("does not keep failed sends in recent dedupe window", () => {
  resetOpenzaloOutboundDedupeForTests();

  const first = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: "retry me",
    },
    3_000,
  );
  assert.equal(first.acquired, true);
  if (!first.acquired) {
    return;
  }

  releaseOpenzaloOutboundDedupeSlot({
    ticket: first.ticket,
    sent: false,
    nowMs: 3_100,
  });

  const retry = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: "retry me",
    },
    3_200,
  );
  assert.equal(retry.acquired, true);
});

test("treats repeated payload occurrences as distinct sequences", () => {
  resetOpenzaloOutboundDedupeForTests();

  const firstOccurrence = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: "same chunk",
      sequence: 1,
    },
    4_000,
  );
  assert.equal(firstOccurrence.acquired, true);
  if (!firstOccurrence.acquired) {
    return;
  }
  releaseOpenzaloOutboundDedupeSlot({
    ticket: firstOccurrence.ticket,
    sent: true,
    nowMs: 4_001,
  });

  const secondOccurrence = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: "same chunk",
      sequence: 2,
    },
    4_002,
  );
  assert.equal(secondOccurrence.acquired, true);
  if (!secondOccurrence.acquired) {
    return;
  }
  releaseOpenzaloOutboundDedupeSlot({
    ticket: secondOccurrence.ticket,
    sent: true,
    nowMs: 4_003,
  });

  const duplicateFirstOccurrence = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: "same chunk",
      sequence: 1,
    },
    4_004,
  );
  assert.equal(duplicateFirstOccurrence.acquired, false);
  if (!duplicateFirstOccurrence.acquired) {
    assert.equal(duplicateFirstOccurrence.reason, "recent");
  }
});

test("does not collide on long chunks with the same prefix", () => {
  resetOpenzaloOutboundDedupeForTests();
  const sharedPrefix = "a".repeat(1_500);
  const firstChunk = `${sharedPrefix}::first`;
  const secondChunk = `${sharedPrefix}::second`;

  const first = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: firstChunk,
    },
    5_000,
  );
  assert.equal(first.acquired, true);
  if (!first.acquired) {
    return;
  }
  releaseOpenzaloOutboundDedupeSlot({
    ticket: first.ticket,
    sent: true,
    nowMs: 5_001,
  });

  const second = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: secondChunk,
    },
    5_002,
  );
  assert.equal(second.acquired, true);
});

test("keeps media occurrence signatures stable across retries", () => {
  resetOpenzaloOutboundDedupeForTests();

  const firstOccurrence = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "media",
      text: "caption",
      mediaRef: "https://example.com/a.jpg",
      sequence: 1,
      idempotencyContext: "ctx:media",
    },
    5_500,
  );
  assert.equal(firstOccurrence.acquired, true);
  if (!firstOccurrence.acquired) {
    return;
  }
  releaseOpenzaloOutboundDedupeSlot({
    ticket: firstOccurrence.ticket,
    sent: true,
    nowMs: 5_501,
  });

  const secondOccurrence = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "media",
      text: undefined,
      mediaRef: "https://example.com/a.jpg",
      sequence: 2,
      idempotencyContext: "ctx:media",
    },
    5_502,
  );
  assert.equal(secondOccurrence.acquired, true);
  if (!secondOccurrence.acquired) {
    return;
  }
  releaseOpenzaloOutboundDedupeSlot({
    ticket: secondOccurrence.ticket,
    sent: true,
    nowMs: 5_503,
  });

  const duplicateFirstOccurrence = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "media",
      text: "caption",
      mediaRef: "https://example.com/a.jpg",
      sequence: 1,
      idempotencyContext: "ctx:media",
    },
    5_504,
  );
  assert.equal(duplicateFirstOccurrence.acquired, false);
  if (!duplicateFirstOccurrence.acquired) {
    assert.equal(duplicateFirstOccurrence.reason, "recent");
  }

  const duplicateSecondOccurrence = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "media",
      text: undefined,
      mediaRef: "https://example.com/a.jpg",
      sequence: 2,
      idempotencyContext: "ctx:media",
    },
    5_505,
  );
  assert.equal(duplicateSecondOccurrence.acquired, false);
  if (!duplicateSecondOccurrence.acquired) {
    assert.equal(duplicateSecondOccurrence.reason, "recent");
  }
});

test("scopes dedupe by idempotency context", () => {
  resetOpenzaloOutboundDedupeForTests();

  const first = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: "same body",
      idempotencyContext: "ctx:1",
    },
    6_000,
  );
  assert.equal(first.acquired, true);
  if (!first.acquired) {
    return;
  }
  releaseOpenzaloOutboundDedupeSlot({
    ticket: first.ticket,
    sent: true,
    nowMs: 6_010,
  });

  const duplicateSameContext = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: "same body",
      idempotencyContext: "ctx:1",
    },
    6_020,
  );
  assert.equal(duplicateSameContext.acquired, false);
  if (!duplicateSameContext.acquired) {
    assert.equal(duplicateSameContext.reason, "recent");
  }

  const samePayloadDifferentContext = acquireOpenzaloOutboundDedupeSlot(
    {
      accountId: "main",
      sessionKey: "s1",
      target: "user:123",
      kind: "text",
      text: "same body",
      idempotencyContext: "ctx:2",
    },
    6_021,
  );
  assert.equal(samePayloadDifferentContext.acquired, true);
});
