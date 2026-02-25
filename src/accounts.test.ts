import assert from "node:assert/strict";
import test from "node:test";

const accountsModule = await import("./accounts.ts").catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Cannot find package 'openclaw'")) {
    return null;
  }
  throw err;
});
const skipReason = accountsModule ? false : "requires OpenClaw plugin-sdk runtime";

test("resolveDefaultOpenzaloAccountId uses configured defaultAccount", { skip: skipReason }, () => {
  assert.ok(accountsModule);
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
  assert.equal(accountsModule.resolveDefaultOpenzaloAccountId(cfg), "work");
});

test(
  "resolveOpenzaloAccount ignores defaultAccount marker while merging config",
  { skip: skipReason },
  () => {
    assert.ok(accountsModule);
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
    const account = accountsModule.resolveOpenzaloAccount({
      cfg,
      accountId: "work",
    });
    assert.deepEqual(account.config.allowFrom, ["10001"]);
    assert.equal(account.profile, "work");
  },
);
