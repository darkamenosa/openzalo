import { defineSetupPluginEntry } from "./api.js";
import { openzaloPlugin } from "./src/channel.js";

export { openzaloPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(openzaloPlugin);
