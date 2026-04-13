import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePreferredOpenClawTmpDirCompat } from "./preferred-tmp-dir.ts";
import { setOpenzaloRuntime } from "./runtime.ts";
import { sendMediaOpenzalo } from "./send.ts";

const account = {
  accountId: "default",
  enabled: true,
  configured: true,
  profile: "default",
  zcaBinary: "openzca",
  config: {},
};

function installRuntime(stageDir: string) {
  setOpenzaloRuntime({
    logging: {
      getChildLogger: () => ({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    },
    channel: {
      media: {
        saveMediaBuffer: async (
          buffer: Buffer,
          contentType?: string,
          _subdir?: string,
          _maxBytes?: number,
          originalFilename?: string,
        ) => {
          const fileName = originalFilename?.trim() || "upload.bin";
          const filePath = path.join(stageDir, fileName);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, buffer);
          return {
            path: filePath,
            contentType,
          };
        },
      },
    },
  } as never);
}

test("sendMediaOpenzalo sends video captions with the video command and keeps the video receipt primary", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzalo-send-test-"));
  const stagedDir = path.join(tempDir, "staged");
  const mediaPath = path.join(tempDir, "clip.mp4");
  const scriptPath = path.join(tempDir, "mock-openzca.mjs");
  const logPath = path.join(tempDir, "calls.jsonl");

  try {
    installRuntime(stagedDir);
    await fs.writeFile(mediaPath, "video");
    const stagedMediaPath = path.join(stagedDir, "clip.mp4");
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
      ["--profile", "default", "msg", "video", "123", stagedMediaPath, "--message", "Video caption"],
    ]);
    assert.equal(result.msgId, "video-1");
    assert.equal(result.cliMsgId, undefined);
    assert.deepStrictEqual(result.receipts.map((entry) => entry.msgId), ["video-1"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("sendMediaOpenzalo allows OpenClaw temp tts media by default", async () => {
  const openclawTmpDir = await resolvePreferredOpenClawTmpDirCompat();
  await fs.mkdir(openclawTmpDir, { recursive: true });
  const ttsDir = await fs.mkdtemp(path.join(openclawTmpDir, "tts-"));
  const stagedDir = path.join(ttsDir, "staged");
  const mediaPath = path.join(ttsDir, `voice-${Date.now()}.mp3`);
  const scriptPath = path.join(ttsDir, "mock-openzca.mjs");
  const logPath = path.join(ttsDir, "calls.jsonl");

  try {
    installRuntime(stagedDir);
    await fs.writeFile(mediaPath, "voice");
    const stagedMediaPath = path.join(stagedDir, path.basename(mediaPath));
    await fs.writeFile(
      scriptPath,
      `#!/usr/bin/env node
import fs from "node:fs/promises";

const args = process.argv.slice(2);
await fs.appendFile(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
process.stdout.write(JSON.stringify({ msgId: "voice-1" }));
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
      mediaPath,
    });

    const rawCalls = await fs.readFile(logPath, "utf8");
    const calls = rawCalls
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    assert.deepStrictEqual(calls, [["--profile", "default", "msg", "voice", "123", stagedMediaPath]]);
    assert.equal(result.msgId, "voice-1");
  } finally {
    await fs.rm(ttsDir, { recursive: true, force: true });
  }
});

test("sendMediaOpenzalo keeps voice replies voice-only even when text is present", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzalo-send-voice-only-test-"));
  const stagedDir = path.join(tempDir, "staged");
  const mediaPath = path.join(tempDir, "voice.mp3");
  const scriptPath = path.join(tempDir, "mock-openzca.mjs");
  const logPath = path.join(tempDir, "calls.jsonl");

  try {
    installRuntime(stagedDir);
    await fs.writeFile(mediaPath, "voice");
    const stagedMediaPath = path.join(stagedDir, "voice.mp3");
    await fs.writeFile(
      scriptPath,
      `#!/usr/bin/env node
import fs from "node:fs/promises";

const args = process.argv.slice(2);
await fs.appendFile(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");

const command = args.slice(2, 4).join(" ");
if (command === "msg voice") {
  process.stdout.write(JSON.stringify({ msgId: "voice-1" }));
} else if (command === "msg send") {
  process.stdout.write(JSON.stringify({ msgId: "caption-1" }));
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
      text: "This text should stay inside the voice content only",
      mediaPath,
      mediaLocalRoots: [tempDir],
    });

    const rawCalls = await fs.readFile(logPath, "utf8");
    const calls = rawCalls
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    assert.deepStrictEqual(calls, [["--profile", "default", "msg", "voice", "123", stagedMediaPath]]);
    assert.equal(result.msgId, "voice-1");
    assert.deepStrictEqual(result.receipts.map((entry) => entry.msgId), ["voice-1"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("sendMediaOpenzalo does not fall back to upload when msg voice fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzalo-send-voice-fail-test-"));
  const stagedDir = path.join(tempDir, "staged");
  const mediaPath = path.join(tempDir, "voice.mp3");
  const scriptPath = path.join(tempDir, "mock-openzca.mjs");
  const logPath = path.join(tempDir, "calls.jsonl");

  try {
    installRuntime(stagedDir);
    await fs.writeFile(mediaPath, "voice");
    const stagedMediaPath = path.join(stagedDir, "voice.mp3");
    await fs.writeFile(
      scriptPath,
      `#!/usr/bin/env node
import fs from "node:fs/promises";

const args = process.argv.slice(2);
await fs.appendFile(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");

const command = args.slice(2, 4).join(" ");
if (command === "msg voice") {
  process.stderr.write("voice failed");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ msgId: "upload-1" }));
`,
      { mode: 0o755 },
    );

    await assert.rejects(
      sendMediaOpenzalo({
        cfg: {},
        account: {
          ...account,
          zcaBinary: scriptPath,
        },
        to: "user:123",
        mediaPath,
        mediaLocalRoots: [tempDir],
      }),
      /msg voice .*voice failed/,
    );

    const rawCalls = await fs.readFile(logPath, "utf8");
    const calls = rawCalls
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    assert.deepStrictEqual(calls, [["--profile", "default", "msg", "voice", "123", stagedMediaPath]]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("sendMediaOpenzalo does not fall back to upload when msg video fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzalo-send-video-fail-test-"));
  const stagedDir = path.join(tempDir, "staged");
  const mediaPath = path.join(tempDir, "clip.mp4");
  const scriptPath = path.join(tempDir, "mock-openzca.mjs");
  const logPath = path.join(tempDir, "calls.jsonl");

  try {
    installRuntime(stagedDir);
    await fs.writeFile(mediaPath, "video");
    const stagedMediaPath = path.join(stagedDir, "clip.mp4");
    await fs.writeFile(
      scriptPath,
      `#!/usr/bin/env node
import fs from "node:fs/promises";

const args = process.argv.slice(2);
await fs.appendFile(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");

const command = args.slice(2, 4).join(" ");
if (command === "msg video") {
  process.stderr.write("video failed");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ msgId: "upload-1" }));
`,
      { mode: 0o755 },
    );

    await assert.rejects(
      sendMediaOpenzalo({
        cfg: {},
        account: {
          ...account,
          zcaBinary: scriptPath,
        },
        to: "user:123",
        mediaPath,
        mediaLocalRoots: [tempDir],
      }),
      /msg video .*video failed/,
    );

    const rawCalls = await fs.readFile(logPath, "utf8");
    const calls = rawCalls
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    assert.deepStrictEqual(calls, [["--profile", "default", "msg", "video", "123", stagedMediaPath]]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("sendMediaOpenzalo forwards mediaReadFile into staged outbound media loading", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzalo-send-readfile-test-"));
  const stagedDir = path.join(tempDir, "staged");
  const mediaPath = path.join(tempDir, "outside-roots", "voice.mp3");
  const scriptPath = path.join(tempDir, "mock-openzca.mjs");
  const logPath = path.join(tempDir, "calls.jsonl");
  let readFilePath = "";

  try {
    installRuntime(stagedDir);
    await fs.writeFile(
      scriptPath,
      `#!/usr/bin/env node
import fs from "node:fs/promises";

const args = process.argv.slice(2);
await fs.appendFile(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
process.stdout.write(JSON.stringify({ msgId: "voice-1" }));
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
      mediaPath,
      mediaLocalRoots: [path.join(tempDir, "allowed-only")],
      mediaReadFile: async (filePath) => {
        readFilePath = filePath;
        return Buffer.from("voice");
      },
    });

    const rawCalls = await fs.readFile(logPath, "utf8");
    const calls = rawCalls
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    assert.equal(readFilePath, mediaPath);
    assert.deepStrictEqual(calls, [["--profile", "default", "msg", "voice", "123", path.join(stagedDir, "voice.mp3")]]);
    assert.equal(result.msgId, "voice-1");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("sendMediaOpenzalo resolves relative mediaPath against allowed roots before staging", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzalo-send-relative-test-"));
  const stagedDir = path.join(tempDir, "staged");
  const allowedRoot = path.join(tempDir, "allowed-root");
  const mediaPath = path.join(allowedRoot, "clip.mp4");
  const scriptPath = path.join(tempDir, "mock-openzca.mjs");
  const logPath = path.join(tempDir, "calls.jsonl");

  try {
    installRuntime(stagedDir);
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.writeFile(mediaPath, "video");
    await fs.writeFile(
      scriptPath,
      `#!/usr/bin/env node
import fs from "node:fs/promises";

const args = process.argv.slice(2);
await fs.appendFile(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
process.stdout.write(JSON.stringify({ msgId: "video-1" }));
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
      mediaPath: "clip.mp4",
      mediaLocalRoots: [allowedRoot],
    });

    const rawCalls = await fs.readFile(logPath, "utf8");
    const calls = rawCalls
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    assert.deepStrictEqual(calls, [["--profile", "default", "msg", "video", "123", path.join(stagedDir, "clip.mp4")]]);
    assert.equal(result.msgId, "video-1");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
