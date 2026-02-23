import assert from "node:assert/strict";
import test from "node:test";
import { clearOpenzaloProbeCache, probeOpenzaloAuth } from "./probe.ts";

test("probeOpenzaloAuth caches successful probes", async () => {
  clearOpenzaloProbeCache();
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const account = {
    accountId: "default",
    profile: "default",
    zcaBinary: "openzca",
  };

  const first = await probeOpenzaloAuth({
    account,
    cacheTtlMs: 5_000,
    deps: { now: () => 1_000, runCommand: runCommand as never },
  });
  const second = await probeOpenzaloAuth({
    account,
    cacheTtlMs: 5_000,
    deps: { now: () => 2_000, runCommand: runCommand as never },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 1);
});

test("probeOpenzaloAuth forceRefresh bypasses cache", async () => {
  clearOpenzaloProbeCache();
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const account = {
    accountId: "default",
    profile: "default",
    zcaBinary: "openzca",
  };

  await probeOpenzaloAuth({
    account,
    cacheTtlMs: 5_000,
    deps: { now: () => 1_000, runCommand: runCommand as never },
  });
  await probeOpenzaloAuth({
    account,
    forceRefresh: true,
    cacheTtlMs: 5_000,
    deps: { now: () => 2_000, runCommand: runCommand as never },
  });

  assert.equal(calls, 2);
});

test("probeOpenzaloAuth refreshes after cache expiration", async () => {
  clearOpenzaloProbeCache();
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const account = {
    accountId: "default",
    profile: "default",
    zcaBinary: "openzca",
  };

  await probeOpenzaloAuth({
    account,
    cacheTtlMs: 500,
    deps: { now: () => 1_000, runCommand: runCommand as never },
  });
  await probeOpenzaloAuth({
    account,
    cacheTtlMs: 500,
    deps: { now: () => 2_000, runCommand: runCommand as never },
  });

  assert.equal(calls, 2);
});

test("probeOpenzaloAuth caches failures", async () => {
  clearOpenzaloProbeCache();
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    throw new Error("not logged in");
  };
  const account = {
    accountId: "default",
    profile: "default",
    zcaBinary: "openzca",
  };

  const first = await probeOpenzaloAuth({
    account,
    cacheTtlMs: 5_000,
    deps: { now: () => 1_000, runCommand: runCommand as never },
  });
  const second = await probeOpenzaloAuth({
    account,
    cacheTtlMs: 5_000,
    deps: { now: () => 2_000, runCommand: runCommand as never },
  });

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(calls, 1);
});
