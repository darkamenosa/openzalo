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

test("OpenZalo agent prompt forbids target on list-group-members and forbids guessed mentions", async () => {
  const channelSource = await readRepoFile("src/channel.ts");

  assert.match(channelSource, /never pass `target`\/`to` to `list-group-members`/i);
  assert.match(channelSource, /current group context/i);
  assert.match(channelSource, /do not guess/i);
  assert.match(channelSource, /fetch group members/i);
});

test("OpenZalo skill doc explains how to send native group mentions", async () => {
  const skillDoc = await readRepoFile("skills/openzalo/SKILL.md");

  assert.match(skillDoc, /@Name/);
  assert.match(skillDoc, /@userId/);
  assert.match(skillDoc, /list-group-members/);
  assert.match(skillDoc, /native Zalo mention/i);
});

test("OpenZalo skill doc requires current-group member lookup before tagging", async () => {
  const skillDoc = await readRepoFile("skills/openzalo/SKILL.md");

  assert.match(skillDoc, /never pass `target`\/`to` to `list-group-members`/i);
  assert.match(skillDoc, /current group context/i);
  assert.match(skillDoc, /do not guess/i);
  assert.match(skillDoc, /fetch group members/i);
});

test("OpenZalo docs describe the openzca CLI fallback when group member lookup fails", async () => {
  const channelSource = await readRepoFile("src/channel.ts");
  const skillDoc = await readRepoFile("skills/openzalo/SKILL.md");
  const openzcaSkillDoc = await readRepoFile("skills/openzca/SKILL.md");

  assert.match(channelSource, /openzca/i);
  assert.match(channelSource, /group members/i);
  assert.match(skillDoc, /openzca/i);
  assert.match(skillDoc, /group members/i);
  assert.match(openzcaSkillDoc, /fallback/i);
  assert.match(openzcaSkillDoc, /group members/i);
});
