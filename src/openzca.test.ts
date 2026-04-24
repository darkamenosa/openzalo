import assert from "node:assert/strict";
import test from "node:test";
import { resolveOpenzcaSpawnInvocation } from "./openzca.ts";

test("resolveOpenzcaSpawnInvocation resolves Windows npm openzca.cmd shim to Node CLI script", () => {
  const binary = "C:\\Users\\PC\\AppData\\Roaming\\npm\\openzca.cmd";
  const cliScript = "C:\\Users\\PC\\AppData\\Roaming\\npm\\node_modules\\openzca\\dist\\cli.js";
  const nodeExe = "C:\\Program Files\\nodejs\\node.exe";

  const invocation = resolveOpenzcaSpawnInvocation({
    binary,
    profile: "default",
    args: ["msg", "send", "1543478002790642374", "hello with spaces"],
    platform: "win32",
    execPath: nodeExe,
    existsSync: (target) => target === cliScript,
  });

  assert.equal(invocation.command, nodeExe);
  assert.deepEqual(invocation.args, [
    cliScript,
    "--profile",
    "default",
    "msg",
    "send",
    "1543478002790642374",
    "hello with spaces",
  ]);
  assert.equal(invocation.windowsHide, true);
  assert.equal(invocation.windowsVerbatimArguments, undefined);
});

test("resolveOpenzcaSpawnInvocation resolves local node_modules .bin openzca.cmd shim", () => {
  const binary = "C:\\repo\\node_modules\\.bin\\openzca.cmd";
  const cliScript = "C:\\repo\\node_modules\\openzca\\dist\\cli.js";
  const nodeExe = "C:\\Program Files\\nodejs\\node.exe";

  const invocation = resolveOpenzcaSpawnInvocation({
    binary,
    profile: "default",
    args: ["auth", "status"],
    platform: "win32",
    execPath: nodeExe,
    existsSync: (target) => target === cliScript,
  });

  assert.equal(invocation.command, nodeExe);
  assert.deepEqual(invocation.args, [cliScript, "--profile", "default", "auth", "status"]);
});

test("resolveOpenzcaSpawnInvocation resolves bare Windows openzca command through PATH", () => {
  const shim = "C:\\Users\\PC\\AppData\\Roaming\\npm\\openzca.CMD";
  const cliScript = "C:\\Users\\PC\\AppData\\Roaming\\npm\\node_modules\\openzca\\dist\\cli.js";
  const nodeExe = "C:\\Program Files\\nodejs\\node.exe";

  const invocation = resolveOpenzcaSpawnInvocation({
    binary: "openzca",
    profile: "default",
    args: ["msg", "send", "1543478002790642374", "hello with spaces"],
    platform: "win32",
    execPath: nodeExe,
    env: {
      PATH: "C:\\Windows\\System32;C:\\Users\\PC\\AppData\\Roaming\\npm",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    },
    existsSync: (target) => target.toLowerCase() === shim.toLowerCase() || target === cliScript,
  });

  assert.equal(invocation.command, nodeExe);
  assert.deepEqual(invocation.args, [
    cliScript,
    "--profile",
    "default",
    "msg",
    "send",
    "1543478002790642374",
    "hello with spaces",
  ]);
});

test("resolveOpenzcaSpawnInvocation falls back to a quoted cmd.exe wrapper for unresolved .cmd", () => {
  const binary = "C:\\tools\\openzca.cmd";

  const invocation = resolveOpenzcaSpawnInvocation({
    binary,
    profile: "default",
    args: ["msg", "send", "1543478002790642374", "hello with spaces"],
    platform: "win32",
    existsSync: () => false,
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });

  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args, [
    "/d",
    "/s",
    "/c",
    'C:\\tools\\openzca.cmd --profile default msg send 1543478002790642374 "hello with spaces"',
  ]);
  assert.equal(invocation.windowsHide, true);
  assert.equal(invocation.windowsVerbatimArguments, true);
});

test("resolveOpenzcaSpawnInvocation rejects unsafe fallback cmd.exe arguments", () => {
  assert.throws(
    () =>
      resolveOpenzcaSpawnInvocation({
        binary: "C:\\tools\\openzca.cmd",
        profile: "default",
        args: ["msg", "send", "1543478002790642374", "hello & goodbye"],
        platform: "win32",
        existsSync: () => false,
      }),
    /Unsafe Windows cmd\.exe argument/,
  );
});
