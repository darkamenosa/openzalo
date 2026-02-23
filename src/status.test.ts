import assert from "node:assert/strict";
import test from "node:test";
import { collectOpenzaloStatusIssues, resolveOpenzaloAccountState } from "./status.ts";

test("resolveOpenzaloAccountState handles disabled/configured transitions", () => {
  assert.equal(resolveOpenzaloAccountState({ enabled: false, configured: false }), "disabled");
  assert.equal(resolveOpenzaloAccountState({ enabled: true, configured: false }), "not configured");
  assert.equal(resolveOpenzaloAccountState({ enabled: true, configured: true }), "configured");
});

test("collectOpenzaloStatusIssues skips disabled accounts", () => {
  const issues = collectOpenzaloStatusIssues([
    {
      accountId: "default",
      enabled: false,
      configured: false,
      lastError: "ignored",
    },
  ]);
  assert.equal(issues.length, 0);
});

test("collectOpenzaloStatusIssues reports unconfigured accounts", () => {
  const issues = collectOpenzaloStatusIssues([
    {
      accountId: "default",
      enabled: true,
      configured: false,
    },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.kind, "config");
  assert.match(issues[0]?.message ?? "", /not configured/i);
});

test("collectOpenzaloStatusIssues reports probe/runtime failures", () => {
  const issues = collectOpenzaloStatusIssues([
    {
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      probe: { ok: false, error: "auth expired" },
      lastError: "listener crashed",
    },
  ]);
  assert.equal(issues.length, 2);
  assert.equal(issues[0]?.kind, "runtime");
  assert.match(issues[0]?.message ?? "", /auth check failed/i);
  assert.equal(issues[1]?.kind, "runtime");
  assert.match(issues[1]?.message ?? "", /channel error/i);
});
