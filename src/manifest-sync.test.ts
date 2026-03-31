import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildOpenzaloChannelSchemaJson } from "./config-schema-core.js";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("manifest channel config schema stays in sync with source schema", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(rootDir, "openclaw.plugin.json"), "utf8"),
  ) as {
    channelConfigs?: Record<string, { schema?: Record<string, unknown> }>;
  };

  assert.deepEqual(manifest.channelConfigs?.openzalo?.schema, buildOpenzaloChannelSchemaJson());
});
