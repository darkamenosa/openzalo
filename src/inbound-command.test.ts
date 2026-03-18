import assert from "node:assert/strict";
import test from "node:test";
import {
  doesOpenzaloCommandTargetDifferentBot,
  resolveOpenzaloCommandBody,
} from "./inbound-command.ts";

const ownMentionRegexes = [/@Thu(?:\b|$)/i];

test("resolveOpenzaloCommandBody strips own leading mention command", () => {
  assert.equal(
    resolveOpenzaloCommandBody({
      rawBody: "@Thu /new",
      mentionRegexes: ownMentionRegexes,
    }),
    "/new",
  );
});

test("resolveOpenzaloCommandBody strips attached own mention command", () => {
  assert.equal(
    resolveOpenzaloCommandBody({
      rawBody: "@Thu/new",
      mentionRegexes: ownMentionRegexes,
    }),
    "/new",
  );
});

test("resolveOpenzaloCommandBody keeps foreign leading mention command intact", () => {
  assert.equal(
    resolveOpenzaloCommandBody({
      rawBody: "@Mon /new",
      mentionRegexes: ownMentionRegexes,
    }),
    "@Mon /new",
  );
});

test("doesOpenzaloCommandTargetDifferentBot detects a foreign slash target", () => {
  assert.equal(
    doesOpenzaloCommandTargetDifferentBot({
      commandBody: "/new @Mon",
      mentionRegexes: ownMentionRegexes,
    }),
    true,
  );
});

test("doesOpenzaloCommandTargetDifferentBot allows an own slash target", () => {
  assert.equal(
    doesOpenzaloCommandTargetDifferentBot({
      commandBody: "/new @Thu",
      mentionRegexes: ownMentionRegexes,
    }),
    false,
  );
});

test("doesOpenzaloCommandTargetDifferentBot allows a bot user id target", () => {
  assert.equal(
    doesOpenzaloCommandTargetDifferentBot({
      commandBody: "/new @12345",
      mentionRegexes: ownMentionRegexes,
      botUserId: "12345",
    }),
    false,
  );
});

test("resolveOpenzaloCommandBody strips a spaced native mention from mention metadata", () => {
  assert.equal(
    resolveOpenzaloCommandBody({
      rawBody: "@Hà Thư /new",
      mentionRegexes: [],
      mentions: [{ uid: "bot-1", text: "@Hà Thư" }],
      botUserId: "bot-1",
    }),
    "/new",
  );
});

test("doesOpenzaloCommandTargetDifferentBot allows a spaced native slash target from mention metadata", () => {
  assert.equal(
    doesOpenzaloCommandTargetDifferentBot({
      commandBody: "/new @Hà Thư",
      mentionRegexes: [],
      mentions: [{ uid: "bot-1", text: "@Hà Thư" }],
      botUserId: "bot-1",
    }),
    false,
  );
});
