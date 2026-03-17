import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendMediaOpenzalo } from "./send.ts";

const account = {
  accountId: "default",
  enabled: true,
  configured: true,
  profile: "default",
  zcaBinary: "openzca",
  config: {},
};

test("sendMediaOpenzalo sends video captions with the video command and keeps the video receipt primary", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzalo-send-test-"));
  const mediaPath = path.join(tempDir, "clip.mp4");
  const scriptPath = path.join(tempDir, "mock-openzca.mjs");
  const logPath = path.join(tempDir, "calls.jsonl");

  try {
    await fs.writeFile(mediaPath, "video");
    const resolvedMediaPath = await fs.realpath(mediaPath);
    await fs.writeFile(
      scriptPath,
      `#!/usr/bin/env node
import fs from "node:fs/promises";

const args = process.argv.slice(2);
await fs.appendFile(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");

const command = args.slice(2, 4).join(" ");
if (command === "msg video") {
  process.stdout.write(JSON.stringify({ msgId: "video-1" }));
} else if (command === "msg send") {
  process.stdout.write(JSON.stringify({ msgId: "caption-1", cliMsgId: "caption-cli-1" }));
} else {
  process.stdout.write(JSON.stringify({ msgId: "other-1" }));
}
`,
      { mode: 0o755 },
    );

    const result = await sendMediaOpenzalo({
      cfg: {},
      account: {
        ...account,
        zcaBinary: scriptPath,
      },
      to: "user:123",
      text: "Video caption",
      mediaPath,
      mediaLocalRoots: [tempDir],
    });

    const rawCalls = await fs.readFile(logPath, "utf8");
    const calls = rawCalls
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    assert.deepStrictEqual(calls, [
      ["--profile", "default", "msg", "video", "123", resolvedMediaPath, "--message", "Video caption"],
    ]);
    assert.equal(result.msgId, "video-1");
    assert.equal(result.cliMsgId, undefined);
    assert.deepStrictEqual(result.receipts.map((entry) => entry.msgId), ["video-1"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
