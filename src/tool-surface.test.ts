import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { openzaloMessageActions } from "./actions.ts";

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

test("OpenZalo agent prompt removes list-group-members guidance, forbids guessed mentions, and points to openzca skill lookup", async () => {
  const channelSource = await readRepoFile("src/channel.ts");

  assert.doesNotMatch(channelSource, /list-group-members/i);
  assert.match(channelSource, /do not guess/i);
  assert.match(channelSource, /already known from context|provided by the user/i);
  assert.match(channelSource, /openzca/i);
  assert.match(channelSource, /skill/i);
});

test("OpenZalo skill doc prefers DB reads for summaries and history work", async () => {
  const skillDoc = await readRepoFile("skills/openzca/SKILL.md");

  assert.match(skillDoc, /Prefer DB reads/i);
  assert.match(skillDoc, /summarize/i);
  assert.match(skillDoc, /db status --json/i);
  assert.match(skillDoc, /db sync all --json/i);
  assert.match(skillDoc, /db chat messages <chatId> --json/i);
  assert.match(skillDoc, /--since 24h/i);
  assert.match(skillDoc, /--from 2026-03-20/i);
  assert.match(skillDoc, /--to 2026-03-22/i);
  assert.match(skillDoc, /--oldest-first/i);
  assert.match(skillDoc, /--all/i);
});

test("OpenZalo docs point native mention member lookup to the openzca skill", async () => {
  const channelSource = await readRepoFile("src/channel.ts");
  const openzcaSkillDoc = await readRepoFile("skills/openzca/SKILL.md");

  assert.match(channelSource, /openzca/i);
  assert.match(openzcaSkillDoc, /group members/i);
  assert.match(openzcaSkillDoc, /@Name/i);
  assert.match(openzcaSkillDoc, /@userId/i);
});

test("OpenZalo skill docs describe DB-backed reads and media CLI behavior", async () => {
  const skillDoc = await readRepoFile("skills/openzca/SKILL.md");

  assert.match(skillDoc, /db group messages <groupId> --json/i);
  assert.match(skillDoc, /db message get <msgIdOrCliMsgId> --json/i);
  assert.match(skillDoc, /db friend messages <userId> --since 7d --json/i);
  assert.match(skillDoc, /db chat <chatId> --limit 50 --json/i);
  assert.match(skillDoc, /Do not mix:/i);
  assert.match(skillDoc, /--since.*--from/i);
  assert.match(skillDoc, /\.mp4/i);
  assert.match(skillDoc, /db/i);
  assert.match(skillDoc, /msg video/i);
  assert.match(skillDoc, /--message/i);
});

test("OpenZalo no longer ships a separate openzalo skill doc", async () => {
  await assert.rejects(readRepoFile("skills/openzalo/SKILL.md"));
});

test("OpenZalo action surface no longer exposes list-group-members", async () => {
  const actionsSource = await readRepoFile("src/actions.ts");

  assert.doesNotMatch(actionsSource, /actions\.add\("list-group-members"\)/);
  assert.doesNotMatch(actionsSource, /"list-group-members",\n\]/);
});

test("OpenZalo actions export describeMessageTool for shared message discovery", () => {
  assert.equal(typeof openzaloMessageActions.describeMessageTool, "function");
  assert.equal("listActions" in openzaloMessageActions, false);
});
