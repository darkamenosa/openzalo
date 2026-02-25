import assert from "node:assert/strict";
import test from "node:test";
import { resolveDefaultOpenzaloAccountId, resolveOpenzaloAccount } from "./accounts.ts";

test("resolveDefaultOpenzaloAccountId uses configured defaultAccount", () => {
  const cfg = {
    channels: {
      openzalo: {
        defaultAccount: "work",
        accounts: {
          default: { profile: "default" },
          work: { profile: "work" },
        },
      },
    },
  };
  assert.equal(resolveDefaultOpenzaloAccountId(cfg), "work");
});

test("resolveOpenzaloAccount ignores defaultAccount marker while merging config", () => {
  const cfg = {
    channels: {
      openzalo: {
        defaultAccount: "work",
        allowFrom: ["10001"],
        accounts: {
          work: { profile: "work" },
        },
      },
    },
  };
  const account = resolveOpenzaloAccount({
    cfg,
    accountId: "work",
  });
  assert.deepEqual(account.config.allowFrom, ["10001"]);
  assert.equal(account.profile, "work");
});
