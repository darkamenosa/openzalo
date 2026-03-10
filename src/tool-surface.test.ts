import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

test("OpenZalo agent prompt documents native group mention support", async () => {
  const channelSource = await readRepoFile("src/channel.ts");

  assert.match(channelSource, /@Name/);
  assert.match(channelSource, /@userId/);
  assert.match(channelSource, /native Zalo mention/i);
});

test("OpenZalo skill doc explains how to send native group mentions", async () => {
  const skillDoc = await readRepoFile("skills/openzalo/SKILL.md");

  assert.match(skillDoc, /@Name/);
  assert.match(skillDoc, /@userId/);
  assert.match(skillDoc, /list-group-members/);
  assert.match(skillDoc, /native Zalo mention/i);
});
