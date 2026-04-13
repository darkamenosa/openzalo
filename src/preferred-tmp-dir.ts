import os from "node:os";
import path from "node:path";

let preferredTmpDirPromise: Promise<string> | null = null;

function resolveFallbackPreferredTmpDir(): string {
  let uid: number | undefined;
  try {
    uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  } catch {
    uid = undefined;
  }
  const suffix = uid === undefined ? "openclaw" : `openclaw-${uid}`;
  return path.join(os.tmpdir(), suffix);
}

export async function resolvePreferredOpenClawTmpDirCompat(): Promise<string> {
  preferredTmpDirPromise ??= (async () => {
    try {
      const mod = (await import("openclaw/plugin-sdk/temp-path")) as {
        resolvePreferredOpenClawTmpDir?: () => string;
      };
      if (typeof mod.resolvePreferredOpenClawTmpDir === "function") {
        return path.resolve(mod.resolvePreferredOpenClawTmpDir());
      }
    } catch {
      // Standalone extension tests do not install the host package.
    }
    return path.resolve(resolveFallbackPreferredTmpDir());
  })();
  return await preferredTmpDirPromise;
}
