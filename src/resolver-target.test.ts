import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResolvedGroupTarget, normalizeResolvedUserTarget } from "./resolver-target.ts";

test("normalizeResolvedUserTarget accepts direct aliases", () => {
  assert.equal(normalizeResolvedUserTarget("user:20002"), "20002");
  assert.equal(normalizeResolvedUserTarget("dm:20002"), "20002");
  assert.equal(normalizeResolvedUserTarget("ozl:u:20002"), "20002");
});

test("normalizeResolvedUserTarget rejects group targets", () => {
  assert.equal(normalizeResolvedUserTarget("group:20002"), "");
  assert.equal(normalizeResolvedUserTarget("g-20002"), "");
});

test("normalizeResolvedGroupTarget accepts explicit group aliases and raw ids", () => {
  assert.equal(normalizeResolvedGroupTarget("group:30003"), "group:30003");
  assert.equal(normalizeResolvedGroupTarget("g-30003"), "group:30003");
  assert.equal(normalizeResolvedGroupTarget("30003"), "group:30003");
});

test("normalizeResolvedGroupTarget does not rewrite explicit direct targets", () => {
  assert.equal(normalizeResolvedGroupTarget("user:20002"), "");
  assert.equal(normalizeResolvedGroupTarget("dm:20002"), "");
  assert.equal(normalizeResolvedGroupTarget("u:20002"), "");
  assert.equal(normalizeResolvedGroupTarget("u-20002"), "");
});
