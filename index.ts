import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { openzaloPlugin } from "./src/channel.js";
import { setOpenzaloRuntime } from "./src/runtime.js";
import { registerOpenzaloSubagentHooks } from "./src/subagent-hooks.js";

const plugin = {
  id: "openzalo",
  name: "OpenZalo",
  description: "OpenZalo channel plugin (personal account via openzca CLI)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setOpenzaloRuntime(api.runtime);
    api.registerChannel({ plugin: openzaloPlugin as ChannelPlugin });
    registerOpenzaloSubagentHooks(api);
  },
};

export default plugin;
