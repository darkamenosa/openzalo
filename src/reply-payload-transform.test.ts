import assert from "node:assert/strict";
import test from "node:test";
import { hasOpenzaloMediaDirectives, parseOpenzaloMediaDirectives } from "./reply-payload-transform.ts";

test("hasOpenzaloMediaDirectives detects MEDIA lines only", () => {
  assert.equal(hasOpenzaloMediaDirectives("caption\nMEDIA:./out/image.png"), true);
  assert.equal(hasOpenzaloMediaDirectives("  MEDIA:https://example.com/a.png"), true);
  assert.equal(hasOpenzaloMediaDirectives("This mentions MEDIA: in prose"), false);
});

test("parseOpenzaloMediaDirectives extracts MEDIA lines into reply media fields", () => {
  const result = parseOpenzaloMediaDirectives({
    text: [
      "Em chạy bằng skill codex-imagen cho anh rồi.",
      "",
      "MEDIA:/Users/tuyenhx/.openclaw/workspace/codex-imagen-output/out.png",
      "",
      "Nếu anh muốn, em chỉnh prompt tiếp.",
    ].join("\n"),
  });

  assert.equal(
    result.text,
    "Em chạy bằng skill codex-imagen cho anh rồi.\n\nNếu anh muốn, em chỉnh prompt tiếp.",
  );
  assert.deepEqual(result.mediaUrls, [
    "/Users/tuyenhx/.openclaw/workspace/codex-imagen-output/out.png",
  ]);
  assert.equal(result.mediaUrl, "/Users/tuyenhx/.openclaw/workspace/codex-imagen-output/out.png");
});

test("parseOpenzaloMediaDirectives preserves existing media and ignores fenced MEDIA text", () => {
  const result = parseOpenzaloMediaDirectives({
    text: [
      "Before",
      "```text",
      "MEDIA:https://example.com/ignored.png",
      "```",
      "MEDIA:https://example.com/a.png",
    ].join("\n"),
    mediaUrls: ["https://example.com/existing.png"],
  });

  assert.equal(result.text, "Before\n```text\nMEDIA:https://example.com/ignored.png\n```");
  assert.deepEqual(result.mediaUrls, [
    "https://example.com/existing.png",
    "https://example.com/a.png",
  ]);
  assert.equal(result.mediaUrl, "https://example.com/existing.png");
});

test("parseOpenzaloMediaDirectives rejects traversal and home directory media paths", () => {
  const result = parseOpenzaloMediaDirectives({
    text: "caption\nMEDIA:../../../etc/passwd\nMEDIA:~/Pictures/a.png",
  });

  assert.equal(result.text, "caption");
  assert.equal(result.mediaUrl, undefined);
  assert.equal(result.mediaUrls, undefined);
});
