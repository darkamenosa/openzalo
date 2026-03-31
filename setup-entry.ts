import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { openzaloPlugin } from "./src/channel.js";
export { OpenzaloChannelConfigSchema } from "./src/config-schema.js";

export { openzaloPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(openzaloPlugin);
