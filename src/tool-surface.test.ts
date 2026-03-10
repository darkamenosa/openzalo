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

test("OpenZalo agent prompt removes list-group-members guidance and forbids guessed mentions", async () => {
  const channelSource = await readRepoFile("src/channel.ts");

  assert.doesNotMatch(channelSource, /list-group-members/i);
  assert.match(channelSource, /do not guess/i);
  assert.match(channelSource, /already known from context|provided by the user/i);
});

test("OpenZalo skill doc explains how to send native group mentions", async () => {
  const skillDoc = await readRepoFile("skills/openzalo/SKILL.md");

  assert.match(skillDoc, /@Name/);
  assert.match(skillDoc, /@userId/);
  assert.doesNotMatch(skillDoc, /`list-group-members`/);
  assert.match(skillDoc, /native Zalo mention/i);
});

test("OpenZalo skill doc requires exact-known member identity before tagging", async () => {
  const skillDoc = await readRepoFile("skills/openzalo/SKILL.md");

  assert.doesNotMatch(skillDoc, /list-group-members/i);
  assert.match(skillDoc, /do not guess/i);
  assert.match(skillDoc, /already have an exact unique member id or name/i);
});

test("OpenZalo docs remove the openzca CLI member lookup fallback guidance", async () => {
  const channelSource = await readRepoFile("src/channel.ts");
  const skillDoc = await readRepoFile("skills/openzalo/SKILL.md");
  const openzcaSkillDoc = await readRepoFile("skills/openzca/SKILL.md");

  assert.doesNotMatch(channelSource, /group members/i);
  assert.doesNotMatch(skillDoc, /group members/i);
  assert.doesNotMatch(openzcaSkillDoc, /fallback/i);
});

test("OpenZalo action surface no longer exposes list-group-members", async () => {
  const actionsSource = await readRepoFile("src/actions.ts");

  assert.doesNotMatch(actionsSource, /actions\.add\("list-group-members"\)/);
  assert.doesNotMatch(actionsSource, /"list-group-members",\n\]/);
});
