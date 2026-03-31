import fs from "node:fs";
import path from "node:path";
import { buildOpenzaloChannelSchemaJson } from "../src/config-schema-core.ts";

type PackageJson = {
  openclaw?: {
    channel?: {
      id?: string;
      label?: string;
      blurb?: string;
    };
  };
};

type Manifest = {
  channelConfigs?: Record<
    string,
    {
      label?: string;
      description?: string;
      schema?: Record<string, unknown>;
    }
  >;
};

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const packageJsonPath = path.join(rootDir, "package.json");
const manifestPath = path.join(rootDir, "openclaw.plugin.json");
const checkMode = process.argv.includes("--check");

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageJson;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;

const channelMeta = packageJson.openclaw?.channel;
const channelId = channelMeta?.id?.trim() || "openzalo";
const nextManifest = {
  ...manifest,
  channelConfigs: {
    ...(manifest.channelConfigs ?? {}),
    [channelId]: {
      ...(manifest.channelConfigs?.[channelId] ?? {}),
      ...(channelMeta?.label ? { label: channelMeta.label } : {}),
      ...(channelMeta?.blurb ? { description: channelMeta.blurb } : {}),
      schema: buildOpenzaloChannelSchemaJson(),
    },
  },
};

const currentJson = `${JSON.stringify(manifest, null, 2)}\n`;
const nextJson = `${JSON.stringify(nextManifest, null, 2)}\n`;

if (checkMode) {
  if (currentJson !== nextJson) {
    console.error("openclaw.plugin.json channelConfigs.openzalo is out of sync");
    process.exit(1);
  }
  console.log("openclaw.plugin.json channel config is in sync");
  process.exit(0);
}

fs.writeFileSync(manifestPath, nextJson, "utf8");
console.log(`updated ${path.relative(process.cwd(), manifestPath)}`);
