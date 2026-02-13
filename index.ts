import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { openzaloDock, openzaloPlugin } from "./src/channel.js";
import { setOpenzaloRuntime } from "./src/runtime.js";
import { OpenzaloToolSchema, executeOpenzaloTool } from "./src/tool.js";

const plugin = {
  id: "openzalo",
  name: "Zalo Personal",
  description: "Zalo personal account messaging via openzca",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setOpenzaloRuntime(api.runtime);
    // Register channel plugin (for onboarding & gateway)
    api.registerChannel({ plugin: openzaloPlugin, dock: openzaloDock });

    // Register agent tool
    api.registerTool({
      name: "openzalo",
      label: "Zalo Personal",
      description:
        "Send messages and access data via Zalo personal account. " +
        "Actions: send (text message), image (send image URL), link (send link), " +
        "friends (list/search friends), groups (list groups), group-members (list members in a group), " +
        "me (profile info), status (auth check).",
      parameters: OpenzaloToolSchema,
      execute: executeOpenzaloTool,
    } as AnyAgentTool);
  },
};

export default plugin;
