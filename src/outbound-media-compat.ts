import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LoadedOutboundMediaKind = "image" | "audio" | "video" | "document";

export type LoadedOutboundMediaCompat = {
  buffer: Buffer;
  contentType?: string;
  kind?: LoadedOutboundMediaKind;
  fileName?: string;
};

export type OutboundMediaAccessCompat = {
  localRoots?: readonly string[];
  readFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
};

type LoadOutboundMediaCompatOptions = {
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccessCompat;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"]);
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

function isMissingOutboundMediaSdk(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND" &&
    error instanceof Error &&
    /openclaw(?:\/plugin-sdk\/outbound-media)?/i.test(error.message)
  );
}

function expandHomePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function normalizeLocalPath(input: string): string {
  const trimmed = input.trim();
  if (/^file:\/\//i.test(trimmed)) {
    return fileURLToPath(trimmed);
  }
  return path.resolve(expandHomePath(trimmed));
}

function normalizeMediaUrlForFallback(mediaUrl: string, workspaceDir?: string): string {
  const expanded = expandHomePath(mediaUrl);
  if (
    workspaceDir &&
    expanded &&
    !path.isAbsolute(expanded) &&
    !/^[a-zA-Z]:[\\/]/.test(expanded)
  ) {
    return path.resolve(workspaceDir, expanded);
  }
  return expanded;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  if (process.platform === "win32") {
    return normalizedCandidate.toLowerCase().startsWith(rootWithSep.toLowerCase());
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSep);
}

async function assertFallbackLocalMediaAllowed(
  source: string,
  mediaLocalRoots?: readonly string[],
): Promise<string> {
  const localPath = normalizeLocalPath(source);
  const realFilePath = await fs.realpath(localPath).catch(() => path.resolve(localPath));
  const roots = (mediaLocalRoots ?? []).map((root) => path.resolve(root));
  for (const root of roots) {
    const realRoot = await fs.realpath(root).catch(() => root);
    if (isPathInsideRoot(realFilePath, realRoot) || isPathInsideRoot(realFilePath, root)) {
      return realFilePath;
    }
  }
  throw new Error(
    "OpenZalo local media path is outside allowed roots. " +
      `Source="${source}" Existing candidates: ${realFilePath}. ` +
      'Set "channels.openzalo.mediaLocalRoots" (or per-account mediaLocalRoots) to allow more paths.',
  );
}

function inferKindFromFileName(fileName?: string): LoadedOutboundMediaKind | undefined {
  const ext = fileName ? path.extname(fileName).toLowerCase() : "";
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  return fileName ? "document" : undefined;
}

function formatMediaLimit(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

export async function loadOutboundMediaFromUrlCompat(
  mediaUrl: string,
  options: LoadOutboundMediaCompatOptions = {},
): Promise<LoadedOutboundMediaCompat> {
  try {
    const sdk = (await import("openclaw/plugin-sdk/outbound-media")) as {
      loadOutboundMediaFromUrl: (
        mediaUrl: string,
        options?: LoadOutboundMediaCompatOptions,
      ) => Promise<LoadedOutboundMediaCompat>;
    };
    return await sdk.loadOutboundMediaFromUrl(mediaUrl, {
      maxBytes: options.maxBytes,
      mediaAccess: options.mediaAccess,
      mediaLocalRoots: options.mediaLocalRoots,
      mediaReadFile: options.mediaReadFile,
    });
  } catch (error) {
    if (!isMissingOutboundMediaSdk(error)) {
      throw error;
    }
  }

  if (/^https?:\/\//i.test(mediaUrl)) {
    throw new Error(
      "openclaw/plugin-sdk/outbound-media is unavailable in standalone mode for remote media URLs.",
    );
  }

  const fallbackMediaUrl = normalizeMediaUrlForFallback(mediaUrl, options.mediaAccess?.workspaceDir);
  const readFile = options.mediaAccess?.readFile ?? options.mediaReadFile;
  const localRoots = options.mediaAccess?.localRoots ?? options.mediaLocalRoots;
  const localPath = readFile
    ? normalizeLocalPath(fallbackMediaUrl)
    : await assertFallbackLocalMediaAllowed(fallbackMediaUrl, localRoots);
  const buffer = readFile
    ? await readFile(localPath)
    : await fs.readFile(localPath);
  if (typeof options.maxBytes === "number" && buffer.byteLength > options.maxBytes) {
    throw new Error(`Media exceeds ${formatMediaLimit(options.maxBytes)} limit`);
  }
  const fileName = path.basename(localPath) || undefined;
  return {
    buffer,
    fileName,
    kind: inferKindFromFileName(fileName),
  };
}
