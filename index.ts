import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { openzaloPlugin } from "./src/channel.js";
import { setOpenzaloRuntime } from "./src/runtime.js";
import { registerOpenzaloSubagentHooks } from "./src/subagent-hooks.js";

export default defineChannelPluginEntry({
  id: "openzalo",
  name: "OpenZalo",
  description: "OpenZalo channel plugin (personal account via openzca CLI)",
  plugin: openzaloPlugin,
  setRuntime: setOpenzaloRuntime,
  registerFull(api) {
    registerOpenzaloSubagentHooks(api);
  },
});
