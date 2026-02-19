import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setOpenzaloRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getOpenzaloRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("OpenZalo runtime not initialized");
  }
  return runtime;
}
