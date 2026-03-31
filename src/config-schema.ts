import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { OpenzaloConfigSchema } from "./config-schema-core.js";

export const OpenzaloChannelConfigSchema = buildChannelConfigSchema(OpenzaloConfigSchema);
