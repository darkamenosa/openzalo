import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recoverOpenzaloMediaPayloadFromSession } from "./reply-session-recovery.ts";

function assistantSessionLine(text: string): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text,
          textSignature: JSON.stringify({
            v: 1,
            phase: "final_answer",
          }),
        },
      ],
    },
  });
}

test("recoverOpenzaloMediaPayloadFromSession restores a stripped MEDIA final answer", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzalo-recovery-"));
  try {
    const storePath = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(
      storePath,
      [
        assistantSessionLine("Older answer"),
        assistantSessionLine(
          [
            "Xong roi.",
            "",
            "MEDIA:/tmp/openzalo-image.png",
            "",
            "Neu anh muon, em lam tiep.",
          ].join("\n"),
        ),
      ].join("\n"),
    );

    const recovered = await recoverOpenzaloMediaPayloadFromSession({
      storePath,
      payload: {
        text: "Xong roi.\n\nNeu anh muon, em lam tiep.",
      },
    });

    assert.equal(recovered?.text, "Xong roi.\n\nNeu anh muon, em lam tiep.");
    assert.equal(recovered?.mediaUrl, "/tmp/openzalo-image.png");
    assert.deepEqual(recovered?.mediaUrls, ["/tmp/openzalo-image.png"]);
  } finally {
    await fs.rm(tmpDir, { force: true, recursive: true });
  }
});

test("recoverOpenzaloMediaPayloadFromSession resolves sessions.json to the active JSONL session", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzalo-recovery-"));
  try {
    const sessionKey = "agent:main:openzalo:default:direct:123";
    const indexPath = path.join(tmpDir, "sessions.json");
    const sessionPath = path.join(tmpDir, "active.jsonl");
    await fs.writeFile(
      indexPath,
      JSON.stringify({
        [sessionKey]: {
          sessionFile: sessionPath,
        },
      }),
    );
    await fs.writeFile(
      sessionPath,
      assistantSessionLine("Da, em gui lai ne.\n\nMEDIA:/tmp/current.png"),
    );

    const recovered = await recoverOpenzaloMediaPayloadFromSession({
      storePath: indexPath,
      sessionKey,
      payload: {
        text: "Da, em gui lai ne.",
      },
    });

    assert.equal(recovered?.text, "Da, em gui lai ne.");
    assert.equal(recovered?.mediaUrl, "/tmp/current.png");
    assert.deepEqual(recovered?.mediaUrls, ["/tmp/current.png"]);
  } finally {
    await fs.rm(tmpDir, { force: true, recursive: true });
  }
});

test("recoverOpenzaloMediaPayloadFromSession does not recover stale mismatched media", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzalo-recovery-"));
  try {
    const storePath = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(
      storePath,
      assistantSessionLine("Old text\n\nMEDIA:/tmp/old-image.png"),
    );

    const recovered = await recoverOpenzaloMediaPayloadFromSession({
      storePath,
      payload: {
        text: "Different current text",
      },
    });

    assert.equal(recovered, null);
  } finally {
    await fs.rm(tmpDir, { force: true, recursive: true });
  }
});

test("recoverOpenzaloMediaPayloadFromSession leaves payloads that already have media alone", async () => {
  const recovered = await recoverOpenzaloMediaPayloadFromSession({
    storePath: "/does/not/exist.jsonl",
    payload: {
      text: "Already has media",
      mediaUrl: "/tmp/current.png",
    },
  });

  assert.equal(recovered, null);
});
