// index.ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";

// api.ts
var DEFAULT_ACCOUNT_ID = "default";
var PAIRING_APPROVED_MESSAGE = "\u2705 OpenClaw access approved. Send a message to start chatting.";
var DOCS_ROOT = "https://docs.openclaw.ai";
function createToolInputError(message) {
  const error = new Error(message);
  error.name = "ToolInputError";
  error.status = 400;
  return error;
}
function toSnakeCaseKey(key) {
  return key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function readParamRaw(params, key) {
  if (Object.hasOwn(params, key)) {
    return params[key];
  }
  const snakeKey = toSnakeCaseKey(key);
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
    return params[snakeKey];
  }
  return void 0;
}
function normalizeCanonicalAccountId(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
function normalizeAccountId(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_ACCOUNT_ID;
  }
  return normalizeCanonicalAccountId(trimmed) || DEFAULT_ACCOUNT_ID;
}
function channelHasAccounts(cfg, channelKey) {
  const channels = cfg.channels;
  const base = channels?.[channelKey];
  return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}
function shouldStoreNameInAccounts(params) {
  if (params.alwaysUseAccounts) {
    return true;
  }
  if (params.accountId !== DEFAULT_ACCOUNT_ID) {
    return true;
  }
  return channelHasAccounts(params.cfg, params.channelKey);
}
function applyAccountNameToChannelSection(params) {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return params.cfg;
  }
  const accountId = normalizeAccountId(params.accountId);
  const channels = params.cfg.channels;
  const baseConfig = channels?.[params.channelKey];
  const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
  const useAccounts = shouldStoreNameInAccounts({
    cfg: params.cfg,
    channelKey: params.channelKey,
    accountId,
    alwaysUseAccounts: params.alwaysUseAccounts
  });
  if (!useAccounts && accountId === DEFAULT_ACCOUNT_ID) {
    const safeBase = base ?? {};
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: {
          ...safeBase,
          name: trimmed
        }
      }
    };
  }
  const baseAccounts = base?.accounts ?? {};
  const existingAccount = baseAccounts[accountId] ?? {};
  const baseWithoutName = accountId === DEFAULT_ACCOUNT_ID ? (({ name: _ignored, ...rest }) => rest)(base ?? {}) : base ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...baseWithoutName,
        accounts: {
          ...baseAccounts,
          [accountId]: {
            ...existingAccount,
            name: trimmed
          }
        }
      }
    }
  };
}
function migrateBaseNameToDefaultAccount(params) {
  if (params.alwaysUseAccounts) {
    return params.cfg;
  }
  const channels = params.cfg.channels;
  const base = channels?.[params.channelKey];
  const baseName = base?.name?.trim();
  if (!baseName) {
    return params.cfg;
  }
  const accounts = {
    ...base?.accounts
  };
  const defaultAccount = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  if (!defaultAccount.name) {
    accounts[DEFAULT_ACCOUNT_ID] = { ...defaultAccount, name: baseName };
  }
  const { name: _ignored, ...rest } = base ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...rest,
        accounts
      }
    }
  };
}
function setAccountEnabledInConfigSection(params) {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels;
  const base = channels?.[params.sectionKey];
  const hasAccounts = Boolean(base?.accounts);
  if (params.allowTopLevel && accountKey === DEFAULT_ACCOUNT_ID && !hasAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...base,
          enabled: params.enabled
        }
      }
    };
  }
  const baseAccounts = base?.accounts ?? {};
  const existing = baseAccounts[accountKey] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.sectionKey]: {
        ...base,
        accounts: {
          ...baseAccounts,
          [accountKey]: {
            ...existing,
            enabled: params.enabled
          }
        }
      }
    }
  };
}
function deleteAccountFromConfigSection(params) {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels;
  const base = channels?.[params.sectionKey];
  if (!base) {
    return params.cfg;
  }
  const baseAccounts = base.accounts && typeof base.accounts === "object" ? { ...base.accounts } : void 0;
  if (accountKey !== DEFAULT_ACCOUNT_ID) {
    const accounts = baseAccounts ? { ...baseAccounts } : {};
    delete accounts[accountKey];
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...base,
          accounts: Object.keys(accounts).length ? accounts : void 0
        }
      }
    };
  }
  if (baseAccounts && Object.keys(baseAccounts).length > 0) {
    delete baseAccounts[accountKey];
    const baseRecord = { ...base };
    for (const field of params.clearBaseFields ?? []) {
      if (field in baseRecord) {
        baseRecord[field] = void 0;
      }
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...baseRecord,
          accounts: Object.keys(baseAccounts).length ? baseAccounts : void 0
        }
      }
    };
  }
  const nextChannels = { ...params.cfg.channels };
  delete nextChannels[params.sectionKey];
  const nextCfg = { ...params.cfg };
  if (Object.keys(nextChannels).length > 0) {
    nextCfg.channels = nextChannels;
  } else {
    delete nextCfg.channels;
  }
  return nextCfg;
}
function formatPairingApproveHint(channelId) {
  return `Approve via: openclaw pairing list ${channelId} / openclaw pairing approve ${channelId} <code>`;
}
function addWildcardAllowFrom(allowFrom) {
  const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (!next.includes("*")) {
    next.push("*");
  }
  return next;
}
function mergeAllowFromEntries(current, additions) {
  const merged = [...current ?? [], ...additions].map((v) => String(v).trim()).filter(Boolean);
  return [...new Set(merged)];
}
function formatDocsLink(path10, label) {
  const trimmed = path10.trim();
  const url = trimmed.startsWith("http") ? trimmed : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  return label ? `${label}: ${url}` : url;
}
async function promptAccountId(params) {
  const existingIds = params.listAccountIds(params.cfg);
  const initial = params.currentId?.trim() || params.defaultAccountId || DEFAULT_ACCOUNT_ID;
  const choice = await params.prompter.select({
    message: `${params.label} account`,
    options: [
      ...existingIds.map((id) => ({
        value: id,
        label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id
      })),
      { value: "__new__", label: "Add a new account" }
    ],
    initialValue: initial
  });
  if (choice !== "__new__") {
    return normalizeAccountId(choice);
  }
  const entered = await params.prompter.text({
    message: `New ${params.label} account id`,
    validate: (value) => value?.trim() ? void 0 : "Required"
  });
  const normalized = normalizeAccountId(String(entered));
  if (String(entered).trim() !== normalized) {
    await params.prompter.note(
      `Normalized account id to "${normalized}".`,
      `${params.label} account`
    );
  }
  return normalized;
}
function readStringParam(params, key, options = {}) {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = readParamRaw(params, key);
  if (typeof raw !== "string") {
    if (required) {
      throw createToolInputError(`${label} required`);
    }
    return void 0;
  }
  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) {
      throw createToolInputError(`${label} required`);
    }
    return void 0;
  }
  return value;
}
function readNumberParam(params, key, options = {}) {
  const { required = false, label = key, integer = false, strict = false } = options;
  const raw = readParamRaw(params, key);
  let value;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      const parsed = strict ? Number(trimmed) : Number.parseFloat(trimmed);
      if (Number.isFinite(parsed)) {
        value = parsed;
      }
    }
  }
  if (value === void 0) {
    if (required) {
      throw createToolInputError(`${label} required`);
    }
    return void 0;
  }
  return integer ? Math.trunc(value) : value;
}
function logInboundDrop(params) {
  const target = params.target ? ` target=${params.target}` : "";
  params.log(`${params.channel}: drop ${params.reason}${target}`);
}
function resolveControlCommandGate(params) {
  const mode = params.modeWhenAccessGroupsOff ?? "allow";
  const commandAuthorized = params.useAccessGroups ? params.authorizers.some((entry) => entry.configured && entry.allowed) : mode === "allow" ? true : mode === "deny" ? false : params.authorizers.some((entry) => entry.configured) ? params.authorizers.some((entry) => entry.configured && entry.allowed) : true;
  return {
    commandAuthorized,
    shouldBlock: params.allowTextCommands && params.hasControlCommand && !commandAuthorized
  };
}
function createChannelPairingController(params) {
  const accountId = normalizeAccountId(params.accountId);
  return {
    accountId,
    readAllowFromStore: () => params.core.channel.pairing.readAllowFromStore({
      channel: params.channel,
      accountId
    }),
    readStoreForDmPolicy: (provider, providerAccountId) => params.core.channel.pairing.readAllowFromStore({
      channel: provider,
      accountId: normalizeAccountId(providerAccountId)
    }),
    upsertPairingRequest: (input) => params.core.channel.pairing.upsertPairingRequest({
      channel: params.channel,
      accountId,
      ...input
    })
  };
}
function createChannelReplyPipeline(_params) {
  const prefixContext = {};
  return {
    responsePrefix: void 0,
    enableSlackInteractiveReplies: void 0,
    responsePrefixContextProvider: () => prefixContext,
    onModelSelected: (ctx) => {
      prefixContext.provider = ctx.provider;
      prefixContext.model = ctx.model;
      prefixContext.modelFull = ctx.provider && ctx.model ? `${ctx.provider}/${ctx.model}` : void 0;
      prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
    },
    ..._params.typingCallbacks ? { typingCallbacks: _params.typingCallbacks } : {}
  };
}
function createActionGate(actions) {
  return (key, defaultValue = true) => {
    const value = actions?.[key];
    if (value === void 0) {
      return defaultValue;
    }
    return value !== false;
  };
}
function jsonResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    details: payload
  };
}

// src/normalize.ts
function stripOpenzaloPrefix(value) {
  return value.trim().replace(/^(openzalo|ozl|zlu):/i, "").trim();
}
function normalizeOpenzaloId(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return typeof value === "string" ? value.trim() : "";
}
function normalizeOpenzaloAllowEntry(raw) {
  return stripOpenzaloPrefix(raw).toLowerCase();
}
function normalizeOpenzaloMessagingTarget(input) {
  const stripped = stripOpenzaloPrefix(input).replace(/^thread:/i, "").trim();
  if (!stripped) {
    return "";
  }
  const aliasMatch = stripped.match(/^([gu])-(.+)$/i);
  if (aliasMatch) {
    const kind = aliasMatch[1]?.toLowerCase() === "g" ? "group" : "user";
    const id = aliasMatch[2]?.trim() ?? "";
    return id ? `${kind}:${id}` : "";
  }
  if (/^g:/i.test(stripped)) {
    const id = stripped.replace(/^g:/i, "").trim();
    return id ? `group:${id}` : "";
  }
  if (/^(u:|dm:)/i.test(stripped)) {
    const id = stripped.replace(/^(u:|dm:)/i, "").trim();
    return id ? `user:${id}` : "";
  }
  const lowered = stripped.toLowerCase();
  if (lowered.startsWith("group:") || lowered.startsWith("user:")) {
    const id = stripped.replace(/^(group:|user:)/i, "").trim();
    if (!id) {
      return "";
    }
    return lowered.startsWith("group:") ? `group:${id}` : `user:${id}`;
  }
  const labeledIdMatch = stripped.match(/\((\d{3,})\)\s*$/);
  if (labeledIdMatch?.[1]) {
    return labeledIdMatch[1];
  }
  return stripped;
}
function looksLikeOpenzaloTargetId(value) {
  return normalizeOpenzaloMessagingTarget(value).length > 0;
}
function parseOpenzaloTarget(raw) {
  const normalized = normalizeOpenzaloMessagingTarget(raw);
  if (!normalized) {
    throw new Error("OpenZalo target is required");
  }
  if (/^group:/i.test(normalized)) {
    const threadId = normalized.replace(/^group:/i, "").trim();
    if (!threadId) {
      throw new Error("OpenZalo group target is missing group id");
    }
    return { threadId, isGroup: true };
  }
  if (/^(dm|user):/i.test(normalized)) {
    const threadId = normalized.replace(/^(dm|user):/i, "").trim();
    if (!threadId) {
      throw new Error("OpenZalo user target is missing user id");
    }
    return { threadId, isGroup: false };
  }
  return {
    threadId: normalized,
    isGroup: false
  };
}
function stripDirectTargetPrefix(value) {
  return value.replace(/^(dm|user):/i, "").trim();
}
function stripGroupTargetPrefix(value) {
  return value.replace(/^group:/i, "").trim();
}
function resolveOpenzaloDirectPeerId(params) {
  const candidates = [params.dmPeerId, params.senderId, params.toId, params.threadId];
  let groupAliasFallback = "";
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const normalized = normalizeOpenzaloMessagingTarget(candidate);
    if (!normalized) {
      continue;
    }
    if (/^group:/i.test(normalized)) {
      if (!groupAliasFallback) {
        groupAliasFallback = stripGroupTargetPrefix(normalized);
      }
      continue;
    }
    if (/^(dm|user):/i.test(normalized)) {
      const direct = stripDirectTargetPrefix(normalized);
      if (direct) {
        return direct;
      }
      continue;
    }
    return normalized;
  }
  if (groupAliasFallback) {
    return groupAliasFallback;
  }
  return "";
}
function formatOpenzaloOutboundTarget(params) {
  return params.isGroup ? `group:${params.threadId}` : `user:${params.threadId}`;
}

// src/openzca.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process2 from "node:process";

// src/json-output.ts
function parseJsonOutput(text, options) {
  const strict = options?.strict === true;
  const emptyValue = options?.emptyValue ?? null;
  const errorPrefix = options?.errorPrefix ?? "failed to parse JSON output";
  const previewLength = options?.previewLength ?? 160;
  const trimmed = text.trim();
  if (!trimmed) {
    if (strict) {
      throw new Error("empty JSON output");
    }
    return emptyValue;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }
  }
  if (strict) {
    throw new Error(`${errorPrefix}: ${trimmed.slice(0, previewLength)}`);
  }
  return emptyValue;
}

// src/openzca.ts
var WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;
function getEnvValue(env, key) {
  if (!env) {
    return "";
  }
  const direct = env[key];
  if (typeof direct === "string") {
    return direct;
  }
  const normalizedKey = key.toLowerCase();
  const found = Object.keys(env).find((entry) => entry.toLowerCase() === normalizedKey);
  const value = found ? env[found] : void 0;
  return typeof value === "string" ? value : "";
}
function isPathLikeCommand(command) {
  return command.includes("/") || command.includes("\\");
}
function commandPathApi(platform) {
  return platform === "win32" ? path.win32 : path;
}
function normalizeCommandPath(command, platform) {
  return commandPathApi(platform).normalize(command);
}
function normalizeCommandName(command, platform) {
  const pathApi = commandPathApi(platform);
  return pathApi.basename(command).replace(/\.(cmd|bat|exe)$/i, "").toLowerCase();
}
function isOpenzcaCommandName(command, platform) {
  const name = normalizeCommandName(command, platform);
  return name === "openzca" || name === "zca";
}
function resolveCommandOnWindowsPath(params) {
  const command = params.command.trim();
  if (!command || isPathLikeCommand(command)) {
    return command || null;
  }
  const pathEnv = getEnvValue(params.env, "PATH");
  if (!pathEnv) {
    return null;
  }
  const pathExt = getEnvValue(params.env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD";
  const ext = path.win32.extname(command);
  const extensions = ext ? [""] : pathExt.split(";").filter(Boolean);
  for (const dir of pathEnv.split(";")) {
    const baseDir = dir.trim();
    if (!baseDir) {
      continue;
    }
    for (const candidateExt of extensions) {
      const candidate = path.win32.join(baseDir, `${command}${candidateExt}`);
      if (params.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
function findOpenzcaCliScript(params) {
  if (params.platform !== "win32" || !isOpenzcaCommandName(params.command, params.platform)) {
    return null;
  }
  const pathApi = commandPathApi(params.platform);
  const ext = pathApi.extname(params.command).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    return null;
  }
  const dir = pathApi.dirname(params.command);
  const candidates = [
    pathApi.join(dir, "node_modules", "openzca", "dist", "cli.js"),
    pathApi.join(dir, "..", "openzca", "dist", "cli.js")
  ].map((candidate) => pathApi.normalize(candidate));
  return candidates.find((candidate) => params.existsSync(candidate)) ?? null;
}
function escapeForCmdExe(arg) {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(
      `Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. Set channels.openzalo.zcaBinary to the openzca dist/cli.js path or reinstall openzca with npm.`
    );
  }
  if (!arg.includes(" ") && !arg.includes('"')) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}
function buildCmdExeCommandLine(command, args) {
  return [escapeForCmdExe(command), ...args.map(escapeForCmdExe)].join(" ");
}
function resolveOpenzcaSpawnInvocation(options) {
  const platform = options.platform ?? process2.platform;
  const existsSync2 = options.existsSync ?? fs.existsSync;
  const binary = options.binary?.trim() || "openzca";
  const displayArgs = ["--profile", options.profile, ...options.args];
  const env = { ...process2.env, ...options.env };
  let command = binary;
  if (platform === "win32") {
    command = resolveCommandOnWindowsPath({
      command: binary,
      env,
      existsSync: existsSync2
    }) ?? binary;
  }
  command = normalizeCommandPath(command, platform);
  const ext = commandPathApi(platform).extname(command).toLowerCase();
  if (platform === "win32" && (ext === ".js" || ext === ".mjs")) {
    return {
      command: options.execPath ?? process2.execPath,
      args: [command, ...displayArgs],
      displayBinary: binary,
      displayArgs,
      windowsHide: true
    };
  }
  const cliScript = findOpenzcaCliScript({ command, platform, existsSync: existsSync2 });
  if (cliScript) {
    return {
      command: options.execPath ?? process2.execPath,
      args: [cliScript, ...displayArgs],
      displayBinary: binary,
      displayArgs,
      windowsHide: true
    };
  }
  if (platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    return {
      command: getEnvValue(env, "ComSpec") || "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(command, displayArgs)],
      displayBinary: binary,
      displayArgs,
      windowsHide: true,
      windowsVerbatimArguments: true
    };
  }
  return {
    command,
    args: displayArgs,
    displayBinary: binary,
    displayArgs
  };
}
function resolveOpenzcaSpawnEnv(options) {
  return { ...process2.env, ...options.env };
}
function makeExecError(params) {
  const stderr = params.stderr.trim();
  const stdout = params.stdout.trim();
  const detail = stderr || stdout || `process exited with code ${params.exitCode}`;
  return new Error(`${params.binary} ${params.args.join(" ")} failed: ${detail}`);
}
function normalizeError(err) {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === "string" ? err : String(err));
}
async function runOpenzcaCommand(options) {
  const env = resolveOpenzcaSpawnEnv(options);
  const invocation = resolveOpenzcaSpawnInvocation({ ...options, env });
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: invocation.windowsHide,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    });
    let stdout = "";
    let stderr = "";
    let timeout;
    let abortHandler;
    const finish = (fn) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      fn();
    };
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2e3).unref();
      }, options.timeoutMs);
    }
    if (options.signal) {
      abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2e3).unref();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      if (options.signal.aborted) {
        abortHandler();
      }
    }
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        finish(
          () => reject(
            makeExecError({
              binary: invocation.displayBinary,
              args: invocation.displayArgs,
              exitCode,
              stderr,
              stdout
            })
          )
        );
        return;
      }
      finish(
        () => resolve({
          stdout,
          stderr,
          exitCode
        })
      );
    });
  });
}
async function runOpenzcaInteractive(options) {
  const env = resolveOpenzcaSpawnEnv(options);
  const invocation = resolveOpenzcaSpawnInvocation({ ...options, env });
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      stdio: ["inherit", "inherit", "pipe"],
      shell: false,
      windowsHide: invocation.windowsHide,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      process2.stderr.write(chunk);
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        reject(
          makeExecError({
            binary: invocation.displayBinary,
            args: invocation.displayArgs,
            exitCode,
            stderr,
            stdout: ""
          })
        );
        return;
      }
      resolve({
        stdout: "",
        stderr,
        exitCode
      });
    });
  });
}
async function runOpenzcaJson(options) {
  const result = await runOpenzcaCommand(options);
  return parseJsonOutput(result.stdout, { strict: true });
}
async function runOpenzcaStreaming(options) {
  const env = resolveOpenzcaSpawnEnv(options);
  const invocation = resolveOpenzcaSpawnInvocation({ ...options, env });
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: invocation.windowsHide,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    });
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let abortHandler;
    let streamHandlerError;
    const emitStdoutLine = async (line) => {
      options.onStdoutLine?.(line);
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      await options.onJsonLine?.(parsed);
    };
    const flushRemainder = async () => {
      if (stdoutRemainder.trim()) {
        await emitStdoutLine(stdoutRemainder);
      }
      if (stderrRemainder.trim()) {
        options.onStderrLine?.(stderrRemainder);
      }
      stdoutRemainder = "";
      stderrRemainder = "";
    };
    if (options.signal) {
      abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2e3).unref();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      if (options.signal.aborted) {
        abortHandler();
      }
    }
    child.stdout.on("data", (chunk) => {
      stdoutRemainder += String(chunk);
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      void Promise.all(lines.map((line) => emitStdoutLine(line))).catch((err) => {
        if (streamHandlerError) {
          return;
        }
        streamHandlerError = err;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2e3).unref();
      });
    });
    child.stderr.on("data", (chunk) => {
      stderrRemainder += String(chunk);
      const lines = stderrRemainder.split(/\r?\n/);
      stderrRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        options.onStderrLine?.(line);
      }
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", async (code) => {
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      try {
        await flushRemainder();
      } catch (err) {
        if (!streamHandlerError) {
          streamHandlerError = err;
        }
      }
      const exitCode = code ?? 0;
      if (streamHandlerError && !options.signal?.aborted) {
        reject(normalizeError(streamHandlerError));
        return;
      }
      if (exitCode !== 0 && !options.signal?.aborted) {
        reject(
          new Error(
            `${invocation.displayBinary} ${invocation.displayArgs.join(" ")} exited with code ${exitCode}`
          )
        );
        return;
      }
      resolve({ exitCode });
    });
  });
}

// src/probe.ts
var PROBE_CACHE_TTL_MS = 15e3;
var MAX_PROBE_CACHE_SIZE = 64;
var probeCache = /* @__PURE__ */ new Map();
function toErrorText(err) {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}
function buildProbeCacheKey(account) {
  return [account.accountId.trim(), account.profile.trim(), account.zcaBinary.trim()].join("|");
}
function clearCachedProbeByPrefix(prefix) {
  for (const key of probeCache.keys()) {
    if (key.startsWith(prefix)) {
      probeCache.delete(key);
    }
  }
}
function readCachedProbe(key, now) {
  const cached = probeCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= now) {
    probeCache.delete(key);
    return null;
  }
  return cached.probe;
}
function writeCachedProbe(key, probe, now, ttlMs) {
  probeCache.set(key, {
    probe,
    expiresAt: now + ttlMs
  });
  if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
    const oldest = probeCache.keys().next().value;
    if (oldest) {
      probeCache.delete(oldest);
    }
  }
}
function clearOpenzaloProbeCacheForAccount(accountId) {
  const normalized = accountId.trim();
  if (!normalized) {
    return;
  }
  clearCachedProbeByPrefix(`${normalized}|`);
}
async function probeOpenzaloAuth(params) {
  const { account, timeoutMs, forceRefresh, cacheTtlMs, deps } = params;
  const now = deps?.now ?? Date.now;
  const runCommand = deps?.runCommand ?? runOpenzcaCommand;
  const ttlMs = Math.max(0, cacheTtlMs ?? PROBE_CACHE_TTL_MS);
  const base = {
    ok: false,
    profile: account.profile,
    binary: account.zcaBinary
  };
  const cacheKey = buildProbeCacheKey(account);
  if (!forceRefresh && ttlMs > 0) {
    const cached = readCachedProbe(cacheKey, now());
    if (cached) {
      return cached;
    }
  }
  try {
    await runCommand({
      binary: account.zcaBinary,
      profile: account.profile,
      args: ["auth", "status"],
      timeoutMs: timeoutMs ?? 8e3
    });
    const probe = {
      ...base,
      ok: true
    };
    if (ttlMs > 0) {
      writeCachedProbe(cacheKey, probe, now(), ttlMs);
    }
    return probe;
  } catch (err) {
    const probe = {
      ...base,
      error: toErrorText(err)
    };
    if (ttlMs > 0) {
      writeCachedProbe(cacheKey, probe, now(), ttlMs);
    }
    return probe;
  }
}

// src/runtime-health.ts
var runtimeHealthByAccount = /* @__PURE__ */ new Map();
var reconnectHandlers = /* @__PURE__ */ new Map();
function normalizeAccountId2(accountId) {
  return accountId.trim();
}
function clearOpenzaloRuntimeHealthState(accountId) {
  const normalized = accountId ? normalizeAccountId2(accountId) : "";
  if (!normalized) {
    runtimeHealthByAccount.clear();
    reconnectHandlers.clear();
    return;
  }
  runtimeHealthByAccount.delete(normalized);
  reconnectHandlers.delete(normalized);
}
function getOpenzaloRuntimeHealthState(accountId) {
  const normalized = normalizeAccountId2(accountId);
  if (!normalized) {
    return void 0;
  }
  const state = runtimeHealthByAccount.get(normalized);
  return state ? { ...state } : void 0;
}
function patchOpenzaloRuntimeHealthState(accountId, patch) {
  const normalized = normalizeAccountId2(accountId);
  if (!normalized) {
    return void 0;
  }
  const current = runtimeHealthByAccount.get(normalized) ?? {};
  const next = {
    ...current,
    ...patch
  };
  runtimeHealthByAccount.set(normalized, next);
  return { ...next };
}
function recordOpenzaloStreamActivity(accountId, at = Date.now()) {
  patchOpenzaloRuntimeHealthState(accountId, {
    lastEventAt: at
  });
}
function markOpenzaloConnected(params) {
  const at = params.at ?? Date.now();
  clearOpenzaloProbeCacheForAccount(params.accountId);
  patchOpenzaloRuntimeHealthState(params.accountId, {
    connected: true,
    reconnectAttempts: params.reconnectAttempts ?? 0,
    lastConnectedAt: at,
    lastEventAt: at,
    lastError: null
  });
}
function markOpenzaloDisconnected(params) {
  patchOpenzaloRuntimeHealthState(params.accountId, {
    connected: false,
    reconnectAttempts: params.reconnectAttempts,
    ...params.reason !== void 0 ? { lastError: params.reason } : {}
  });
}
function registerOpenzaloReconnectHandler(accountId, handler) {
  const normalized = normalizeAccountId2(accountId);
  if (!normalized) {
    return () => {
    };
  }
  const handlers = reconnectHandlers.get(normalized) ?? /* @__PURE__ */ new Set();
  handlers.add(handler);
  reconnectHandlers.set(normalized, handlers);
  return () => {
    const current = reconnectHandlers.get(normalized);
    if (!current) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      reconnectHandlers.delete(normalized);
    }
  };
}
function requestOpenzaloReconnect(params) {
  const normalized = normalizeAccountId2(params.accountId);
  if (!normalized) {
    return false;
  }
  clearOpenzaloProbeCacheForAccount(normalized);
  markOpenzaloDisconnected({
    accountId: normalized,
    reason: params.reason
  });
  const handlers = reconnectHandlers.get(normalized);
  if (!handlers || handlers.size === 0) {
    return false;
  }
  for (const handler of handlers) {
    try {
      handler(params.reason);
    } catch {
    }
  }
  return true;
}

// src/openzca-account.ts
var OPENZCA_AUTH_FAILURE_PATTERNS = [
  /\bauth_unavailable\b/i,
  /\bno auth available\b/i,
  /\bnot logged in\b/i,
  /\blogin required\b/i,
  /\bauth expired\b/i,
  /\bsession expired\b/i
];
function toErrorText2(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}
function isOpenzcaAuthFailureError(error) {
  const text = toErrorText2(error);
  return OPENZCA_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}
function handleOpenzcaAccountCommandFailure(params) {
  if (!isOpenzcaAuthFailureError(params.error)) {
    return;
  }
  requestOpenzaloReconnect({
    accountId: params.account.accountId,
    reason: toErrorText2(params.error)
  });
}
async function runOpenzcaAccountCommand(params) {
  const runCommand = params.deps?.runCommand ?? runOpenzcaCommand;
  try {
    return await runCommand({
      binary: params.binary,
      profile: params.profile,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
      signal: params.signal
    });
  } catch (error) {
    handleOpenzcaAccountCommandFailure({
      account: params.account,
      error
    });
    throw error;
  }
}
async function runOpenzcaAccountJson(params) {
  const runJson = params.deps?.runJson ?? runOpenzcaJson;
  try {
    return await runJson({
      binary: params.binary,
      profile: params.profile,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
      signal: params.signal
    });
  } catch (error) {
    handleOpenzcaAccountCommandFailure({
      account: params.account,
      error
    });
    throw error;
  }
}

// src/directory.ts
async function listOpenzaloDirectorySelf(params) {
  const { account } = params;
  const me = await runOpenzcaAccountJson({
    account,
    binary: account.zcaBinary,
    profile: account.profile,
    args: ["me", "info", "--json"],
    timeoutMs: 1e4
  });
  const id = normalizeOpenzaloId(me?.userId);
  if (!id) {
    return null;
  }
  return {
    kind: "user",
    id,
    name: me?.displayName?.trim() || void 0,
    raw: me
  };
}
async function listOpenzaloDirectoryPeers(params) {
  const { account, query, limit } = params;
  const rows = await runOpenzcaAccountJson({
    account,
    binary: account.zcaBinary,
    profile: account.profile,
    args: ["friend", "list", "--json"],
    timeoutMs: 2e4
  });
  const q = query?.trim().toLowerCase() ?? "";
  const max = typeof limit === "number" && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const out = [];
  for (const row of rows ?? []) {
    const id = normalizeOpenzaloId(row?.userId);
    if (!id) {
      continue;
    }
    const name = row?.displayName?.trim() || row?.username?.trim() || void 0;
    const haystack = [id, name, row?.phone].filter(Boolean).join(" ").toLowerCase();
    if (q && !haystack.includes(q)) {
      continue;
    }
    out.push({
      kind: "user",
      id,
      name,
      raw: row
    });
    if (out.length >= max) {
      break;
    }
  }
  return out;
}
async function listOpenzaloDirectoryGroups(params) {
  const { account, query, limit } = params;
  const rows = await runOpenzcaAccountJson({
    account,
    binary: account.zcaBinary,
    profile: account.profile,
    args: ["group", "list", "--json"],
    timeoutMs: 2e4
  });
  const q = query?.trim().toLowerCase() ?? "";
  const max = typeof limit === "number" && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const out = [];
  for (const row of rows ?? []) {
    const id = normalizeOpenzaloId(row?.groupId);
    if (!id) {
      continue;
    }
    const name = row?.name?.trim() || void 0;
    const haystack = [id, name].filter(Boolean).join(" ").toLowerCase();
    if (q && !haystack.includes(q)) {
      continue;
    }
    out.push({
      kind: "group",
      id,
      name,
      raw: row
    });
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

// src/inbound.ts
import os5 from "node:os";
import path8 from "node:path";

// src/pending-history.ts
var OPENZALO_HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
var OPENZALO_CURRENT_MESSAGE_MARKER = "[Current message]";
var DEFAULT_OPENZALO_PENDING_GROUP_HISTORY_LIMIT = 10;
var DEFAULT_OPENZALO_PENDING_GROUP_HISTORY_TTL_MS = 10 * 60 * 1e3;
var MAX_OPENZALO_PENDING_GROUP_HISTORY_KEYS = 1e3;
var pendingGroupHistories = /* @__PURE__ */ new Map();
function evictOldHistoryKeys(maxKeys = MAX_OPENZALO_PENDING_GROUP_HISTORY_KEYS) {
  if (pendingGroupHistories.size <= maxKeys) {
    return;
  }
  const keysToDelete = pendingGroupHistories.size - maxKeys;
  const iterator = pendingGroupHistories.keys();
  for (let index = 0; index < keysToDelete; index += 1) {
    const key = iterator.next().value;
    if (typeof key === "string" && key) {
      pendingGroupHistories.delete(key);
    }
  }
}
function pruneExpiredEntries(params) {
  const nowMs = params?.nowMs ?? Date.now();
  const ttlMs = params?.ttlMs ?? DEFAULT_OPENZALO_PENDING_GROUP_HISTORY_TTL_MS;
  if (ttlMs <= 0) {
    pendingGroupHistories.clear();
    return;
  }
  for (const [historyKey, entries] of pendingGroupHistories.entries()) {
    const freshEntries = entries.filter((entry) => {
      if (!Number.isFinite(entry.timestamp)) {
        return true;
      }
      return nowMs - entry.timestamp <= ttlMs;
    });
    if (freshEntries.length === 0) {
      pendingGroupHistories.delete(historyKey);
      continue;
    }
    if (freshEntries.length !== entries.length) {
      pendingGroupHistories.set(historyKey, freshEntries);
    }
  }
}
function buildOpenzaloPendingGroupHistoryKey(params) {
  return `${params.accountId}:${params.threadId}`;
}
function appendOpenzaloPendingGroupHistoryEntry(params) {
  pruneExpiredEntries({ nowMs: params.nowMs, ttlMs: params.ttlMs });
  if (params.limit <= 0) {
    return [];
  }
  const history = pendingGroupHistories.get(params.historyKey) ?? [];
  history.push(params.entry);
  while (history.length > params.limit) {
    history.shift();
  }
  if (pendingGroupHistories.has(params.historyKey)) {
    pendingGroupHistories.delete(params.historyKey);
  }
  pendingGroupHistories.set(params.historyKey, history);
  evictOldHistoryKeys();
  return history.slice();
}
function readOpenzaloPendingGroupHistoryEntries(params) {
  pruneExpiredEntries({ nowMs: params.nowMs, ttlMs: params.ttlMs });
  return (pendingGroupHistories.get(params.historyKey) ?? []).slice();
}
function clearOpenzaloPendingGroupHistory(historyKey) {
  pendingGroupHistories.delete(historyKey);
}
function buildOpenzaloPendingHistoryContext(params) {
  if (params.entries.length === 0) {
    return params.currentMessage;
  }
  const lineBreak = params.lineBreak ?? "\n";
  const historyText = params.entries.map(params.formatEntry).join(lineBreak);
  return [
    OPENZALO_HISTORY_CONTEXT_MARKER,
    historyText,
    "",
    OPENZALO_CURRENT_MESSAGE_MARKER,
    params.currentMessage
  ].join(lineBreak);
}

// src/message-refs.ts
var CACHE_TTL_MS = 6 * 60 * 60 * 1e3;
var CACHE_MAX = 4e3;
var cacheByKey = /* @__PURE__ */ new Map();
var cacheByMsgId = /* @__PURE__ */ new Map();
var cacheByCliMsgId = /* @__PURE__ */ new Map();
var cacheByShortId = /* @__PURE__ */ new Map();
var latestByThread = /* @__PURE__ */ new Map();
var shortIdCounter = 0;
var normalizeId = normalizeOpenzaloId;
function makeScopedId(accountId, id) {
  return `${accountId}:${id}`;
}
function makeThreadKey(params) {
  return `${params.accountId}:${params.isGroup ? "group" : "dm"}:${params.threadId}`;
}
function pickRefsFromRecord(value) {
  const data = value.data && typeof value.data === "object" ? value.data : null;
  const message = value.message && typeof value.message === "object" ? value.message : null;
  const undo = value.undo && typeof value.undo === "object" ? value.undo : null;
  const msgId = normalizeId(value.msgId) || normalizeId(value.messageId) || normalizeId(value.globalMsgId) || normalizeId(data?.msgId) || normalizeId(data?.messageId) || normalizeId(message?.msgId) || normalizeId(message?.messageId) || normalizeId(undo?.msgId) || void 0;
  const cliMsgId = normalizeId(value.cliMsgId) || normalizeId(data?.cliMsgId) || normalizeId(message?.cliMsgId) || normalizeId(undo?.cliMsgId) || void 0;
  return { msgId, cliMsgId };
}
function pickRefs(value) {
  if (!value) {
    return {};
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") {
        const refs2 = pickRefsFromRecord(item);
        if (refs2.msgId || refs2.cliMsgId) {
          return refs2;
        }
      }
    }
    return {};
  }
  if (typeof value !== "object") {
    return {};
  }
  const refs = pickRefsFromRecord(value);
  if (refs.msgId || refs.cliMsgId) {
    return refs;
  }
  const record = value;
  const nestedCandidates = [record.result, record.response, record.payload];
  for (const nested of nestedCandidates) {
    const nestedRefs = pickRefs(nested);
    if (nestedRefs.msgId || nestedRefs.cliMsgId) {
      return nestedRefs;
    }
  }
  return {};
}
function pruneExpired() {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [key, entry] of cacheByKey) {
    if (entry.timestamp >= cutoff) {
      continue;
    }
    cacheByKey.delete(key);
    if (entry.msgId) {
      cacheByMsgId.delete(makeScopedId(entry.accountId, entry.msgId));
    }
    if (entry.cliMsgId) {
      cacheByCliMsgId.delete(makeScopedId(entry.accountId, entry.cliMsgId));
    }
    cacheByShortId.delete(makeScopedId(entry.accountId, entry.shortId));
  }
  while (cacheByKey.size > CACHE_MAX) {
    const oldestKey = cacheByKey.keys().next().value;
    if (!oldestKey) {
      break;
    }
    const oldest = cacheByKey.get(oldestKey);
    cacheByKey.delete(oldestKey);
    if (!oldest) {
      continue;
    }
    if (oldest.msgId) {
      cacheByMsgId.delete(makeScopedId(oldest.accountId, oldest.msgId));
    }
    if (oldest.cliMsgId) {
      cacheByCliMsgId.delete(makeScopedId(oldest.accountId, oldest.cliMsgId));
    }
    cacheByShortId.delete(makeScopedId(oldest.accountId, oldest.shortId));
  }
}
function makeCacheKey(params) {
  const msgPart = params.msgId || "_";
  const cliPart = params.cliMsgId || "_";
  return `${params.accountId}:${params.threadId}:${msgPart}:${cliPart}`;
}
function getEntryByCacheKey(cacheKey) {
  if (!cacheKey) {
    return null;
  }
  return cacheByKey.get(cacheKey) ?? null;
}
function splitFullId(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null;
  }
  const msgId = trimmed.slice(0, separatorIndex).trim();
  const cliMsgId = trimmed.slice(separatorIndex + 1).trim();
  if (!msgId || !cliMsgId) {
    return null;
  }
  return { msgId, cliMsgId };
}
function formatOpenzaloMessageSidFull(params) {
  const msgId = normalizeId(params.msgId);
  const cliMsgId = normalizeId(params.cliMsgId);
  if (msgId && cliMsgId) {
    return `${msgId}:${cliMsgId}`;
  }
  return msgId || cliMsgId || normalizeId(params.fallback);
}
function parseOpenzcaMessageRefs(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = parseJsonOutput(trimmed);
  const fromJson = pickRefs(parsed);
  if (fromJson.msgId || fromJson.cliMsgId) {
    return fromJson;
  }
  const msgIdMatch = trimmed.match(/\bmsgId\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i) || trimmed.match(/\bmessage[_\s]?id\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i) || trimmed.match(/\bglobalMsgId\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i);
  const cliMsgIdMatch = trimmed.match(/\bcliMsgId\s*[:=]\s*['"]?([0-9A-Za-z_-]+)/i);
  const msgId = msgIdMatch?.[1];
  const cliMsgId = cliMsgIdMatch?.[1];
  if (msgId || cliMsgId) {
    return { msgId, cliMsgId };
  }
  const firstWord = trimmed.split(/\s+/g)[0];
  if (firstWord && /^[0-9A-Za-z_-]+$/.test(firstWord)) {
    return { msgId: firstWord };
  }
  return {};
}
function rememberOpenzaloMessage(params) {
  const accountId = params.accountId.trim();
  const threadId = params.threadId.trim();
  const msgId = normalizeId(params.msgId);
  const cliMsgId = normalizeId(params.cliMsgId);
  if (!accountId || !threadId || !msgId && !cliMsgId) {
    return null;
  }
  pruneExpired();
  const cacheKey = makeCacheKey({ accountId, threadId, msgId: msgId || void 0, cliMsgId: cliMsgId || void 0 });
  const existing = cacheByKey.get(cacheKey);
  const shortId = existing?.shortId || String(++shortIdCounter);
  const timestamp = typeof params.timestamp === "number" && Number.isFinite(params.timestamp) && params.timestamp > 0 ? Math.trunc(params.timestamp) : Date.now();
  const preview = params.preview?.trim() || void 0;
  const entry = {
    accountId,
    threadId,
    isGroup: params.isGroup,
    msgId: msgId || void 0,
    cliMsgId: cliMsgId || void 0,
    shortId,
    timestamp,
    preview
  };
  cacheByKey.delete(cacheKey);
  cacheByKey.set(cacheKey, entry);
  cacheByShortId.set(makeScopedId(accountId, shortId), cacheKey);
  if (msgId) {
    cacheByMsgId.set(makeScopedId(accountId, msgId), cacheKey);
  }
  if (cliMsgId) {
    cacheByCliMsgId.set(makeScopedId(accountId, cliMsgId), cacheKey);
  }
  latestByThread.set(makeThreadKey({ accountId, threadId, isGroup: params.isGroup }), cacheKey);
  return entry;
}
function getLatestOpenzaloMessageForThread(params) {
  pruneExpired();
  const threadKey = makeThreadKey({
    accountId: params.accountId.trim(),
    threadId: params.threadId.trim(),
    isGroup: params.isGroup
  });
  return getEntryByCacheKey(latestByThread.get(threadKey));
}
function resolveOpenzaloMessageRef(params) {
  pruneExpired();
  const accountId = params.accountId.trim();
  const rawId = params.rawId.trim();
  if (!accountId || !rawId) {
    return {};
  }
  const fromPair = splitFullId(rawId);
  if (fromPair?.msgId || fromPair?.cliMsgId) {
    return fromPair;
  }
  if (/^\d{1,6}$/.test(rawId)) {
    const byShort = getEntryByCacheKey(cacheByShortId.get(makeScopedId(accountId, rawId)));
    if (byShort) {
      return {
        msgId: byShort.msgId,
        cliMsgId: byShort.cliMsgId,
        shortId: byShort.shortId
      };
    }
  }
  const byMsg = getEntryByCacheKey(cacheByMsgId.get(makeScopedId(accountId, rawId)));
  if (byMsg) {
    return {
      msgId: byMsg.msgId,
      cliMsgId: byMsg.cliMsgId,
      shortId: byMsg.shortId
    };
  }
  const byCli = getEntryByCacheKey(cacheByCliMsgId.get(makeScopedId(accountId, rawId)));
  if (byCli) {
    return {
      msgId: byCli.msgId,
      cliMsgId: byCli.cliMsgId,
      shortId: byCli.shortId
    };
  }
  return { msgId: rawId };
}

// src/acp-local/config.ts
function normalizeText(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed || void 0;
}
function normalizeTimeoutSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return void 0;
  }
  return Math.max(1, Math.floor(value));
}
function normalizePermissionMode(value) {
  return value === "approve-all" || value === "approve-reads" || value === "deny-all" ? value : void 0;
}
function normalizeNonInteractivePermissions(value) {
  return value === "deny" || value === "fail" ? value : void 0;
}
function resolveOpenzaloAcpxConfig(params) {
  const rootConfig = params.cfg.channels?.openzalo?.acpx;
  const accountConfig = params.cfg.channels?.openzalo?.accounts?.[params.accountId]?.acpx;
  return {
    enabled: accountConfig?.enabled ?? rootConfig?.enabled ?? true,
    command: normalizeText(accountConfig?.command) ?? normalizeText(rootConfig?.command) ?? normalizeText(process.env.OPENZALO_ACPX_COMMAND) ?? "acpx",
    agent: normalizeText(accountConfig?.agent) ?? normalizeText(rootConfig?.agent) ?? normalizeText(process.env.OPENZALO_ACPX_AGENT) ?? "codex",
    cwd: normalizeText(accountConfig?.cwd) ?? normalizeText(rootConfig?.cwd) ?? normalizeText(process.env.OPENZALO_ACPX_CWD) ?? process.cwd(),
    timeoutSeconds: normalizeTimeoutSeconds(accountConfig?.timeoutSeconds) ?? normalizeTimeoutSeconds(rootConfig?.timeoutSeconds),
    permissionMode: normalizePermissionMode(accountConfig?.permissionMode) ?? normalizePermissionMode(rootConfig?.permissionMode) ?? "approve-all",
    nonInteractivePermissions: normalizeNonInteractivePermissions(accountConfig?.nonInteractivePermissions) ?? normalizeNonInteractivePermissions(rootConfig?.nonInteractivePermissions) ?? "fail"
  };
}

// src/acp-local/bindings.ts
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path2 from "node:path";
var STORE_VERSION = 1;
function normalizeText2(value) {
  return typeof value === "string" ? value.trim() : "";
}
function normalizeTimestamp(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}
function sanitizeAgentId(agent) {
  const sanitized = agent.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "codex";
}
function buildConversationHash(params) {
  return createHash("sha256").update(`${params.accountId}:${params.conversationId}`).digest("hex").slice(0, 16);
}
function resolveBindingsPath(stateDir) {
  return path2.join(stateDir, "openzalo", "acp-local-bindings.json");
}
function restoreBindingRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw;
  const accountId = normalizeText2(source.accountId);
  const conversationId = normalizeText2(source.conversationId);
  const sessionName = normalizeText2(source.sessionName);
  const sessionKey = normalizeText2(source.sessionKey);
  const agent = normalizeText2(source.agent);
  const cwd = normalizeText2(source.cwd);
  if (!accountId || !conversationId || !sessionName || !sessionKey || !agent || !cwd) {
    return null;
  }
  const boundAt = normalizeTimestamp(source.boundAt, Date.now());
  const updatedAt = normalizeTimestamp(source.updatedAt, boundAt);
  return {
    accountId,
    conversationId,
    sessionName,
    sessionKey,
    agent,
    cwd,
    boundAt,
    updatedAt
  };
}
async function readBindings(stateDir) {
  const filePath = resolveBindingsPath(stateDir);
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const bindings = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bindings) ? parsed.bindings : [];
    return bindings.map((entry) => restoreBindingRecord(entry)).filter((entry) => Boolean(entry));
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
}
async function writeBindings(stateDir, bindings) {
  const filePath = resolveBindingsPath(stateDir);
  await fsp.mkdir(path2.dirname(filePath), { recursive: true });
  const payload = {
    version: STORE_VERSION,
    bindings
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}
`, "utf8");
    await fsp.rename(tmpPath, filePath);
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => void 0);
  }
}
function createOpenzaloAcpBindingRecord(params) {
  const now = params.now ?? Date.now();
  const hash = buildConversationHash({
    accountId: params.accountId,
    conversationId: params.conversationId
  });
  const safeAgent = sanitizeAgentId(params.agent);
  return {
    accountId: params.accountId,
    conversationId: params.conversationId,
    sessionName: `openzalo:${params.accountId}:${hash}`,
    sessionKey: `agent:${safeAgent}:openzalo-acp:${hash}`,
    agent: params.agent.trim(),
    cwd: params.cwd.trim(),
    boundAt: now,
    updatedAt: now
  };
}
async function resolveOpenzaloAcpBinding(params) {
  const bindings = await readBindings(params.stateDir);
  return bindings.find(
    (entry) => entry.accountId === params.accountId && entry.conversationId === params.conversationId
  ) ?? null;
}
async function upsertOpenzaloAcpBinding(params) {
  const bindings = await readBindings(params.stateDir);
  const next = bindings.filter(
    (entry) => !(entry.accountId === params.record.accountId && entry.conversationId === params.record.conversationId)
  );
  next.push(params.record);
  await writeBindings(params.stateDir, next);
  return params.record;
}
async function removeOpenzaloAcpBinding(params) {
  const bindings = await readBindings(params.stateDir);
  const removed = bindings.find(
    (entry) => entry.accountId === params.accountId && entry.conversationId === params.conversationId
  ) ?? null;
  if (!removed) {
    return null;
  }
  const next = bindings.filter(
    (entry) => !(entry.accountId === params.accountId && entry.conversationId === params.conversationId)
  );
  await writeBindings(params.stateDir, next);
  return removed;
}

// src/acp-local/client.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync } from "node:fs";
function normalizeText3(value) {
  return typeof value === "string" ? value.trim() : "";
}
function parseJsonLines(value) {
  const events = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return events;
}
function buildPermissionArgs(config) {
  const permissionArg = config.permissionMode === "approve-all" ? "--approve-all" : config.permissionMode === "deny-all" ? "--deny-all" : "--approve-reads";
  return [permissionArg, "--non-interactive-permissions", config.nonInteractivePermissions];
}
function buildVerbArgs(params) {
  const prefix = ["--format", "json", "--json-strict", "--cwd", params.cwd];
  if (params.includePermissions) {
    prefix.push(...buildPermissionArgs(params.config));
    if (params.config.timeoutSeconds) {
      prefix.push("--timeout", String(params.config.timeoutSeconds));
    }
  }
  return [...prefix, params.agent, ...params.command];
}
function toControlErrorMessage(params) {
  const stderr = params.stderr.trim();
  if (stderr) {
    return stderr;
  }
  return `${params.command} ${params.args.join(" ")} exited with code ${params.exitCode}`;
}
function normalizeSpawnError(params) {
  const { command, cwd, error } = params;
  const err = error instanceof Error ? error : new Error(String(error));
  const code = err.code;
  if (code === "ENOENT") {
    if (cwd.trim() && !existsSync(cwd)) {
      return new Error(`acpx working directory not found: ${cwd}`);
    }
    return new Error(`acpx command not found: ${command}`);
  }
  return err;
}
function hasSessionIdentifiers(events) {
  return events.some((event) => {
    const acpxSessionId = normalizeText3(event.acpxSessionId);
    const agentSessionId = normalizeText3(event.agentSessionId);
    const acpxRecordId = normalizeText3(event.acpxRecordId);
    return Boolean(acpxSessionId || agentSessionId || acpxRecordId);
  });
}
function resolveStructuredPromptPayload(parsed) {
  const method = normalizeText3(parsed.method);
  if (method === "session/update") {
    const params = parsed.params;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const update = params.update;
      if (update && typeof update === "object" && !Array.isArray(update)) {
        const updateRecord = update;
        return {
          type: normalizeText3(updateRecord.sessionUpdate) || normalizeText3(updateRecord.type),
          payload: updateRecord
        };
      }
    }
  }
  return {
    type: normalizeText3(parsed.sessionUpdate) || normalizeText3(parsed.type),
    payload: parsed
  };
}
function parsePromptJsonEvent(parsed) {
  const structured = resolveStructuredPromptPayload(parsed);
  const type = structured.type;
  const payload = structured.payload;
  if (!type) {
    return null;
  }
  const content = typeof payload.content === "string" ? payload.content : payload.content && typeof payload.content === "object" && !Array.isArray(payload.content) ? String(payload.content.text ?? "") : typeof payload.text === "string" ? payload.text : "";
  switch (type) {
    case "text":
    case "agent_message_chunk":
      return content ? { type: "text", text: content, stream: "output" } : null;
    case "thought":
    case "agent_thought_chunk":
      return content ? { type: "text", text: content, stream: "thought" } : null;
    case "tool_call":
    case "tool_call_update": {
      const title = normalizeText3(payload.title) || "tool call";
      const status = normalizeText3(payload.status);
      return { type: "status", text: status ? `${title} (${status})` : title };
    }
    case "usage_update":
      return { type: "status", text: "usage updated" };
    case "current_mode_update":
      return {
        type: "status",
        text: normalizeText3(payload.currentModeId) || "mode updated"
      };
    case "session_info_update":
      return {
        type: "status",
        text: normalizeText3(payload.summary) || normalizeText3(payload.message) || "session updated"
      };
    case "done":
      return { type: "done" };
    case "error":
      return {
        type: "error",
        message: normalizeText3(payload.message) || "acpx runtime error",
        code: normalizeText3(payload.code) || void 0
      };
    default:
      return null;
  }
}
async function runAcpxCommand(options) {
  return await new Promise((resolve, reject) => {
    const child = spawn2(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let timeout;
    let abortHandler;
    const finish = (fn) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      fn();
    };
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2e3).unref();
      }, options.timeoutMs);
    }
    if (options.signal) {
      abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2e3).unref();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      if (options.signal.aborted) {
        abortHandler();
      }
    }
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish(
        () => reject(
          normalizeSpawnError({
            command: options.command,
            cwd: options.cwd,
            error
          })
        )
      );
    });
    child.on("close", (code) => {
      finish(
        () => resolve({
          stdout,
          stderr,
          exitCode: code ?? 0
        })
      );
    });
    if (options.stdin) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}
async function runAcpxStreaming(options) {
  return await new Promise((resolve, reject) => {
    const child = spawn2(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: process.env
    });
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let stderr = "";
    let abortHandler;
    let handlerError;
    const flushStdoutLine = async (line) => {
      options.onStdoutLine?.(line);
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        await options.onJsonLine?.(parsed);
      }
    };
    if (options.signal) {
      abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2e3).unref();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      if (options.signal.aborted) {
        abortHandler();
      }
    }
    child.stdout.on("data", (chunk) => {
      stdoutRemainder += String(chunk);
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      void Promise.all(lines.map((line) => flushStdoutLine(line))).catch((error) => {
        handlerError = error;
        child.kill("SIGTERM");
      });
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      stderrRemainder += text;
      const lines = stderrRemainder.split(/\r?\n/);
      stderrRemainder = lines.pop() ?? "";
      for (const line of lines) {
        options.onStderrLine?.(line);
      }
    });
    child.on("error", (error) => {
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      reject(
        normalizeSpawnError({
          command: options.command,
          cwd: options.cwd,
          error
        })
      );
    });
    child.on("close", async (code) => {
      try {
        if (stdoutRemainder.trim()) {
          await flushStdoutLine(stdoutRemainder);
        }
        if (stderrRemainder.trim()) {
          options.onStderrLine?.(stderrRemainder);
        }
      } catch (error) {
        handlerError = error;
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      if (handlerError) {
        reject(handlerError);
        return;
      }
      resolve({ exitCode: code ?? 0, stderr });
    });
    if (options.stdin) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}
async function ensureOpenzaloAcpxSession(params, deps = {}) {
  const run = deps.runCommand ?? runAcpxCommand;
  const timeoutMs = params.config.timeoutSeconds ? params.config.timeoutSeconds * 1e3 : void 0;
  const ensureArgs = buildVerbArgs({
    config: params.config,
    agent: params.agent,
    cwd: params.cwd,
    command: ["sessions", "ensure", "--name", params.sessionName]
  });
  const ensureResult = await run({
    command: params.config.command,
    args: ensureArgs,
    cwd: params.cwd,
    timeoutMs,
    signal: params.signal
  });
  if (ensureResult.exitCode !== 0) {
    throw new Error(
      toControlErrorMessage({
        command: params.config.command,
        args: ensureArgs,
        stderr: ensureResult.stderr,
        exitCode: ensureResult.exitCode
      })
    );
  }
  if (!hasSessionIdentifiers(parseJsonLines(ensureResult.stdout))) {
    const newArgs = buildVerbArgs({
      config: params.config,
      agent: params.agent,
      cwd: params.cwd,
      command: ["sessions", "new", "--name", params.sessionName]
    });
    const newResult = await run({
      command: params.config.command,
      args: newArgs,
      cwd: params.cwd,
      timeoutMs,
      signal: params.signal
    });
    if (newResult.exitCode !== 0) {
      throw new Error(
        toControlErrorMessage({
          command: params.config.command,
          args: newArgs,
          stderr: newResult.stderr,
          exitCode: newResult.exitCode
        })
      );
    }
  }
  return {
    sessionName: params.sessionName,
    agent: params.agent,
    cwd: params.cwd
  };
}
async function promptOpenzaloAcpxSession(params, deps = {}) {
  const runStreaming = deps.runStreaming ?? runAcpxStreaming;
  const args = buildVerbArgs({
    config: params.config,
    agent: params.agent,
    cwd: params.cwd,
    command: ["prompt", "--session", params.sessionName, "--file", "-"],
    includePermissions: true
  });
  let outputText = "";
  const statusLines = [];
  let parsedError = null;
  const result = await runStreaming({
    command: params.config.command,
    args,
    cwd: params.cwd,
    stdin: params.text,
    signal: params.signal,
    onJsonLine: async (payload) => {
      const event = parsePromptJsonEvent(payload);
      if (!event) {
        return;
      }
      if (event.type === "text" && event.stream === "output") {
        outputText += event.text;
        return;
      }
      if (event.type === "status") {
        statusLines.push(event.text);
        return;
      }
      if (event.type === "error") {
        parsedError = {
          message: event.message,
          ...event.code ? { code: event.code } : {}
        };
      }
    }
  });
  if (parsedError) {
    throw new Error(
      parsedError.code ? `${parsedError.code}: ${parsedError.message}` : parsedError.message
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      toControlErrorMessage({
        command: params.config.command,
        args,
        stderr: result.stderr,
        exitCode: result.exitCode
      })
    );
  }
  return {
    text: outputText.trim(),
    ...statusLines.length > 0 ? { statusText: statusLines.join("\n") } : {}
  };
}
async function getOpenzaloAcpxStatus(params, deps = {}) {
  const run = deps.runCommand ?? runAcpxCommand;
  const timeoutMs = params.config.timeoutSeconds ? params.config.timeoutSeconds * 1e3 : void 0;
  const args = buildVerbArgs({
    config: params.config,
    agent: params.agent,
    cwd: params.cwd,
    command: ["status", "--session", params.sessionName]
  });
  const result = await run({
    command: params.config.command,
    args,
    cwd: params.cwd,
    timeoutMs,
    signal: params.signal
  });
  if (result.exitCode !== 0) {
    throw new Error(
      toControlErrorMessage({
        command: params.config.command,
        args,
        stderr: result.stderr,
        exitCode: result.exitCode
      })
    );
  }
  const events = parseJsonLines(result.stdout);
  const detail = events.find((entry) => normalizeText3(entry.type) !== "error") ?? events[0] ?? {};
  const status = normalizeText3(detail.status) || "unknown";
  const acpxSessionId = normalizeText3(detail.acpxSessionId);
  const acpxRecordId = normalizeText3(detail.acpxRecordId);
  const pid = typeof detail.pid === "number" && Number.isFinite(detail.pid) ? Math.floor(detail.pid) : null;
  const summary = [
    `status=${status}`,
    acpxSessionId ? `acpxSessionId=${acpxSessionId}` : null,
    acpxRecordId ? `acpxRecordId=${acpxRecordId}` : null,
    pid != null ? `pid=${pid}` : null
  ].filter(Boolean).join(" ");
  return {
    summary: summary || "status unavailable",
    details: detail
  };
}
async function closeOpenzaloAcpxSession(params, deps = {}) {
  const run = deps.runCommand ?? runAcpxCommand;
  const timeoutMs = params.config.timeoutSeconds ? params.config.timeoutSeconds * 1e3 : void 0;
  const args = buildVerbArgs({
    config: params.config,
    agent: params.agent,
    cwd: params.cwd,
    command: ["sessions", "close", params.sessionName]
  });
  const result = await run({
    command: params.config.command,
    args,
    cwd: params.cwd,
    timeoutMs,
    signal: params.signal
  });
  if (result.exitCode !== 0) {
    throw new Error(
      toControlErrorMessage({
        command: params.config.command,
        args,
        stderr: result.stderr,
        exitCode: result.exitCode
      })
    );
  }
}

// src/state-dir.ts
import os from "node:os";
import path3 from "node:path";
function expandHomePath(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith(`~${path3.sep}`)) {
    return path3.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}
function resolveOpenzaloStateDir(env = process.env) {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path3.resolve(expandHomePath(override));
  }
  return path3.join(os.homedir(), ".openclaw");
}

// src/acp-local/commands.ts
function parseAcpCommandToken(token) {
  const separatorIndex = token.indexOf("=");
  if (separatorIndex <= 0) {
    return { value: token };
  }
  return {
    key: token.slice(0, separatorIndex).trim().toLowerCase(),
    value: token.slice(separatorIndex + 1).trim()
  };
}
function parseOpenzaloAcpCommand(commandBody) {
  const trimmed = commandBody.trim();
  const match = trimmed.match(/^[/!]acp(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  const rawArgs = (match[1] ?? "").trim();
  if (!rawArgs) {
    return { action: "status" };
  }
  const tokens = rawArgs.split(/\s+/).filter(Boolean);
  const actionToken = tokens.shift()?.toLowerCase() ?? "status";
  const action = actionToken === "on" || actionToken === "off" || actionToken === "status" || actionToken === "reset" || actionToken === "help" ? actionToken : "help";
  let agent;
  let cwd;
  for (const token of tokens) {
    const parsed = parseAcpCommandToken(token);
    if (parsed.key === "agent" && parsed.value) {
      agent = parsed.value;
      continue;
    }
    if (parsed.key === "cwd" && parsed.value) {
      cwd = parsed.value;
      continue;
    }
    if (!parsed.key && !agent) {
      agent = parsed.value;
    }
  }
  return {
    action,
    ...agent ? { agent } : {},
    ...cwd ? { cwd } : {}
  };
}
function buildUsagePayload() {
  return {
    text: [
      "OpenZalo ACPX commands:",
      "/acp status",
      "/acp on [agent] [cwd=/abs/path]",
      "/acp reset [agent] [cwd=/abs/path]",
      "/acp off"
    ].join("\n")
  };
}
function buildDisabledPayload() {
  return {
    text: "OpenZalo ACPX is disabled for this account. Set channels.openzalo.acpx.enabled=true to enable it.",
    isError: true
  };
}
function summarizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}
async function handleOpenzaloAcpCommand(params) {
  const parsed = parseOpenzaloAcpCommand(params.commandBody);
  if (!parsed) {
    return { handled: false };
  }
  const stateDir = resolveOpenzaloStateDir(process.env);
  const acpxConfig = resolveOpenzaloAcpxConfig({
    cfg: params.cfg,
    accountId: params.account.accountId
  });
  const existingBinding = await resolveOpenzaloAcpBinding({
    stateDir,
    accountId: params.account.accountId,
    conversationId: params.conversationId
  });
  if (parsed.action === "help") {
    return {
      handled: true,
      payload: buildUsagePayload(),
      ...existingBinding ? { binding: existingBinding } : {}
    };
  }
  if (!acpxConfig.enabled && parsed.action !== "off" && parsed.action !== "status") {
    return {
      handled: true,
      payload: buildDisabledPayload(),
      ...existingBinding ? { binding: existingBinding } : { binding: null }
    };
  }
  if (parsed.action === "status") {
    if (!existingBinding) {
      return {
        handled: true,
        payload: {
          text: acpxConfig.enabled ? `ACP is off for this conversation. Default agent=${acpxConfig.agent} cwd=${acpxConfig.cwd}` : "ACP is off for this conversation. ACPX is currently disabled for this account."
        },
        binding: null
      };
    }
    if (!acpxConfig.enabled) {
      return {
        handled: true,
        payload: {
          text: [
            "ACP is bound for this conversation, but ACPX is currently disabled for this account.",
            `agent=${existingBinding.agent}`,
            `cwd=${existingBinding.cwd}`,
            `session=${existingBinding.sessionName}`
          ].join("\n")
        },
        binding: existingBinding
      };
    }
    try {
      const status = await getOpenzaloAcpxStatus({
        config: acpxConfig,
        sessionName: existingBinding.sessionName,
        agent: existingBinding.agent,
        cwd: existingBinding.cwd
      });
      return {
        handled: true,
        payload: {
          text: [
            `ACP is on for this conversation.`,
            `agent=${existingBinding.agent}`,
            `cwd=${existingBinding.cwd}`,
            `session=${existingBinding.sessionName}`,
            status.summary
          ].join("\n")
        },
        binding: existingBinding
      };
    } catch (error) {
      return {
        handled: true,
        payload: {
          text: `ACP status failed: ${summarizeError(error)}`,
          isError: true
        },
        binding: existingBinding
      };
    }
  }
  if (parsed.action === "off") {
    if (!existingBinding) {
      return {
        handled: true,
        payload: { text: "ACP is already off for this conversation." },
        binding: null
      };
    }
    let warning = null;
    if (acpxConfig.enabled) {
      try {
        await closeOpenzaloAcpxSession({
          config: acpxConfig,
          sessionName: existingBinding.sessionName,
          agent: existingBinding.agent,
          cwd: existingBinding.cwd
        });
      } catch (error) {
        warning = summarizeError(error);
      }
    }
    await removeOpenzaloAcpBinding({
      stateDir,
      accountId: params.account.accountId,
      conversationId: params.conversationId
    });
    return {
      handled: true,
      payload: {
        text: warning ? `ACP unbound, but session close reported: ${warning}` : "ACP is now off for this conversation."
      },
      binding: null
    };
  }
  const desiredAgent = parsed.agent?.trim() || existingBinding?.agent || acpxConfig.agent;
  const desiredCwd = parsed.cwd?.trim() || existingBinding?.cwd || acpxConfig.cwd;
  const nextBinding = createOpenzaloAcpBindingRecord({
    accountId: params.account.accountId,
    conversationId: params.conversationId,
    agent: desiredAgent,
    cwd: desiredCwd
  });
  if (params.hasSubagentBinding && !existingBinding) {
    return {
      handled: true,
      payload: {
        text: "This conversation is already bound to a subagent session. End that binding before enabling ACP here.",
        isError: true
      },
      binding: null
    };
  }
  if (parsed.action === "reset" && existingBinding) {
    try {
      await closeOpenzaloAcpxSession({
        config: acpxConfig,
        sessionName: existingBinding.sessionName,
        agent: existingBinding.agent,
        cwd: existingBinding.cwd
      });
    } catch {
    }
  }
  try {
    await ensureOpenzaloAcpxSession({
      config: acpxConfig,
      sessionName: nextBinding.sessionName,
      agent: nextBinding.agent,
      cwd: nextBinding.cwd
    });
    await upsertOpenzaloAcpBinding({
      stateDir,
      record: nextBinding
    });
    if (existingBinding && (existingBinding.agent !== nextBinding.agent || existingBinding.cwd !== nextBinding.cwd)) {
      try {
        await closeOpenzaloAcpxSession({
          config: acpxConfig,
          sessionName: existingBinding.sessionName,
          agent: existingBinding.agent,
          cwd: existingBinding.cwd
        });
      } catch {
      }
    }
    return {
      handled: true,
      payload: {
        text: parsed.action === "reset" ? `ACP session reset for this conversation.
agent=${nextBinding.agent}
cwd=${nextBinding.cwd}` : `ACP enabled for this conversation.
agent=${nextBinding.agent}
cwd=${nextBinding.cwd}`
      },
      binding: nextBinding
    };
  } catch (error) {
    return {
      handled: true,
      payload: {
        text: `ACP setup failed: ${summarizeError(error)}`,
        isError: true
      },
      ...existingBinding ? { binding: existingBinding } : { binding: null }
    };
  }
}

// src/acp-local/turn.ts
var conversationQueues = /* @__PURE__ */ new Map();
function resolvePromptBaseText(ctx) {
  const candidates = [
    ctx.BodyForAgent,
    ctx.BodyForCommands,
    ctx.CommandBody,
    ctx.RawBody,
    ctx.Body
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}
function asStringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
function buildOpenzaloAcpPromptText(ctx) {
  const lines = [];
  const base = resolvePromptBaseText(ctx);
  lines.push(base || "[media attached]");
  const mediaPaths = asStringList(ctx.MediaPaths);
  const mediaUrls = asStringList(ctx.MediaUrls);
  if (mediaPaths.length > 0) {
    lines.push("", "Media paths:", ...mediaPaths.map((entry) => `- ${entry}`));
  }
  if (mediaUrls.length > 0) {
    lines.push("", "Media URLs:", ...mediaUrls.map((entry) => `- ${entry}`));
  }
  if (typeof ctx.ReplyToBody === "string" && ctx.ReplyToBody.trim()) {
    lines.push("", `Quoted message: ${ctx.ReplyToBody.trim()}`);
  }
  return lines.join("\n").trim();
}
function enqueueConversationTurn(key, task) {
  const previous = conversationQueues.get(key) ?? Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const next = previous.catch(() => void 0).then(() => current);
  conversationQueues.set(key, next);
  return previous.catch(() => void 0).then(task).finally(() => {
    releaseCurrent?.();
    if (conversationQueues.get(key) === next) {
      conversationQueues.delete(key);
    }
  });
}
function summarizeError2(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}
async function runOpenzaloAcpBoundTurn(params) {
  const key = `${params.binding.accountId}:${params.binding.conversationId}`;
  return await enqueueConversationTurn(key, async () => {
    const config = resolveOpenzaloAcpxConfig({
      cfg: params.cfg,
      accountId: params.accountId
    });
    if (!config.enabled) {
      return {
        text: "ACP is disabled for this account.",
        isError: true
      };
    }
    try {
      await ensureOpenzaloAcpxSession({
        config,
        sessionName: params.binding.sessionName,
        agent: params.binding.agent,
        cwd: params.binding.cwd
      });
      const result = await promptOpenzaloAcpxSession({
        config,
        sessionName: params.binding.sessionName,
        agent: params.binding.agent,
        cwd: params.binding.cwd,
        text: buildOpenzaloAcpPromptText(params.ctxPayload)
      });
      if (result.text.trim()) {
        return { text: result.text.trim() };
      }
      if (result.statusText?.trim()) {
        return { text: result.statusText.trim() };
      }
      return { text: "ACP completed with no text output." };
    } catch (error) {
      params.runtime.error?.(`openzalo acp-local turn failed: ${summarizeError2(error)}`);
      return {
        text: `ACP turn failed: ${summarizeError2(error)}`,
        isError: true
      };
    }
  });
}

// src/account-id.ts
var DEFAULT_ACCOUNT_ID2 = "default";
var BLOCKED_OBJECT_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
var VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
var INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
var LEADING_DASH_RE = /^-+/;
var TRAILING_DASH_RE = /-+$/;
function canonicalizeAccountId(value) {
  if (VALID_ID_RE.test(value)) {
    return value.toLowerCase();
  }
  return value.toLowerCase().replace(INVALID_CHARS_RE, "-").replace(LEADING_DASH_RE, "").replace(TRAILING_DASH_RE, "").slice(0, 64);
}
function normalizeCanonicalAccountId2(value) {
  const canonical = canonicalizeAccountId(value);
  if (!canonical || BLOCKED_OBJECT_KEYS.has(canonical)) {
    return void 0;
  }
  return canonical;
}
function normalizeAccountId3(value) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_ACCOUNT_ID2;
  }
  return normalizeCanonicalAccountId2(trimmed) || DEFAULT_ACCOUNT_ID2;
}

// src/subagent-bindings.ts
var bindingsByConversation = /* @__PURE__ */ new Map();
var conversationKeysBySession = /* @__PURE__ */ new Map();
function toConversationKey(params) {
  return `${params.accountId}:${params.to}`;
}
function resolveTargetFromTo(raw) {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  try {
    const parsed = parseOpenzaloTarget(value);
    return {
      to: formatOpenzaloOutboundTarget({
        threadId: parsed.threadId,
        isGroup: parsed.isGroup
      }),
      threadId: parsed.threadId,
      isGroup: parsed.isGroup
    };
  } catch {
    return null;
  }
}
function isExpired(record, at = Date.now()) {
  if (!record.expiresAt || record.expiresAt <= 0) {
    return false;
  }
  return record.expiresAt <= at;
}
function unlinkSessionConversation(params) {
  const entries = conversationKeysBySession.get(params.sessionKey);
  if (!entries) {
    return;
  }
  entries.delete(params.conversationKey);
  if (entries.size === 0) {
    conversationKeysBySession.delete(params.sessionKey);
  }
}
function removeBindingByConversationKey(conversationKey) {
  const existing = bindingsByConversation.get(conversationKey);
  if (!existing) {
    return null;
  }
  bindingsByConversation.delete(conversationKey);
  unlinkSessionConversation({
    sessionKey: existing.childSessionKey,
    conversationKey
  });
  return existing;
}
function setBindingRecord(record) {
  const conversationKey = toConversationKey({
    accountId: record.accountId,
    to: record.to
  });
  removeBindingByConversationKey(conversationKey);
  bindingsByConversation.set(conversationKey, record);
  const sessionEntries = conversationKeysBySession.get(record.childSessionKey) ?? /* @__PURE__ */ new Set();
  sessionEntries.add(conversationKey);
  conversationKeysBySession.set(record.childSessionKey, sessionEntries);
  return record;
}
function sweepExpiredBindings(now = Date.now()) {
  for (const [conversationKey, record] of bindingsByConversation.entries()) {
    if (!isExpired(record, now)) {
      continue;
    }
    removeBindingByConversationKey(conversationKey);
  }
}
function cloneRecord(record) {
  return { ...record };
}
function toPositiveInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return void 0;
  }
  if (value <= 0) {
    return void 0;
  }
  return Math.max(1, Math.floor(value));
}
function toTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return void 0;
  }
  return Math.max(1, Math.floor(value));
}
function toOptionalString(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed || void 0;
}
function restoreBindingRecord2(raw, nowMs) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw;
  const target = resolveTargetFromTo(toOptionalString(source.to));
  if (!target) {
    return null;
  }
  const childSessionKey = toOptionalString(source.childSessionKey);
  const agentId = toOptionalString(source.agentId);
  if (!childSessionKey || !agentId) {
    return null;
  }
  const accountId = normalizeAccountId3(toOptionalString(source.accountId));
  const label = toOptionalString(source.label);
  const ttlMs = toPositiveInteger(source.ttlMs);
  const boundAt = toTimestamp(source.boundAt) ?? nowMs;
  const lastTouchedAt = toTimestamp(source.lastTouchedAt) ?? boundAt;
  const expiresAt = toPositiveInteger(source.expiresAt) ?? (ttlMs ? lastTouchedAt + ttlMs : void 0);
  if (expiresAt && expiresAt <= nowMs) {
    return null;
  }
  return {
    accountId,
    to: target.to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    childSessionKey,
    agentId,
    label,
    boundAt,
    lastTouchedAt,
    ttlMs,
    expiresAt
  };
}
function bindOpenzaloSubagentSession(params) {
  const target = resolveTargetFromTo(params.to);
  if (!target) {
    return null;
  }
  const childSessionKey = params.childSessionKey.trim();
  const agentId = params.agentId.trim();
  if (!childSessionKey || !agentId) {
    return null;
  }
  const accountId = normalizeAccountId3(params.accountId);
  const now = Date.now();
  const ttlMs = toPositiveInteger(params.ttlMs);
  const record = {
    accountId,
    to: target.to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    childSessionKey,
    agentId,
    label: params.label?.trim() || void 0,
    boundAt: now,
    lastTouchedAt: now,
    ttlMs,
    expiresAt: ttlMs ? now + ttlMs : void 0
  };
  return cloneRecord(setBindingRecord(record));
}
function resolveOpenzaloBoundSessionByTarget(params) {
  sweepExpiredBindings();
  const normalizedTarget = resolveTargetFromTo(params.to);
  if (!normalizedTarget) {
    return null;
  }
  const accountId = normalizeAccountId3(params.accountId);
  const conversationKey = toConversationKey({
    accountId,
    to: normalizedTarget.to
  });
  const record = bindingsByConversation.get(conversationKey);
  if (!record) {
    return null;
  }
  return cloneRecord(record);
}
function resolveOpenzaloBoundOriginBySession(params) {
  sweepExpiredBindings();
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    return null;
  }
  const conversationKeys = conversationKeysBySession.get(childSessionKey);
  if (!conversationKeys || conversationKeys.size === 0) {
    return null;
  }
  const accountId = params.accountId ? normalizeAccountId3(params.accountId) : "";
  const candidates = [];
  for (const key of conversationKeys) {
    const entry = bindingsByConversation.get(key);
    if (!entry) {
      continue;
    }
    if (accountId && entry.accountId !== accountId) {
      continue;
    }
    candidates.push(entry);
  }
  const selected = candidates[0];
  if (!selected) {
    return null;
  }
  return cloneRecord(selected);
}
function unbindOpenzaloSubagentSessionByKey(params) {
  sweepExpiredBindings();
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    return [];
  }
  const conversationKeys = conversationKeysBySession.get(childSessionKey);
  if (!conversationKeys || conversationKeys.size === 0) {
    return [];
  }
  const accountId = params.accountId ? normalizeAccountId3(params.accountId) : "";
  const removed = [];
  for (const conversationKey of [...conversationKeys]) {
    const existing = bindingsByConversation.get(conversationKey);
    if (!existing) {
      conversationKeys.delete(conversationKey);
      continue;
    }
    if (accountId && existing.accountId !== accountId) {
      continue;
    }
    const deleted = removeBindingByConversationKey(conversationKey);
    if (deleted) {
      removed.push(cloneRecord(deleted));
    }
  }
  if (conversationKeys.size === 0) {
    conversationKeysBySession.delete(childSessionKey);
  }
  return removed;
}
function snapshotOpenzaloSubagentBindings(nowMs = Date.now()) {
  sweepExpiredBindings(nowMs);
  return [...bindingsByConversation.values()].map((entry) => cloneRecord(entry));
}
function replaceOpenzaloSubagentBindings(records, nowMs = Date.now()) {
  bindingsByConversation.clear();
  conversationKeysBySession.clear();
  if (!Array.isArray(records)) {
    return 0;
  }
  let count = 0;
  for (const raw of records) {
    const restored = restoreBindingRecord2(raw, nowMs);
    if (!restored) {
      continue;
    }
    setBindingRecord(restored);
    count += 1;
  }
  return count;
}

// src/inbound-command.ts
function resolveOwnMentionTextCandidates(params) {
  const ownBotUserId = params.botUserId ? normalizeOpenzaloAllowEntry(params.botUserId) : "";
  if (!ownBotUserId || !params.mentions?.length) {
    return [];
  }
  const texts = /* @__PURE__ */ new Set();
  for (const mention of params.mentions) {
    if (normalizeOpenzaloAllowEntry(mention.uid) !== ownBotUserId) {
      continue;
    }
    const rawText = mention.text?.trim();
    if (!rawText) {
      continue;
    }
    texts.add(rawText.startsWith("@") ? rawText : `@${rawText}`);
  }
  return Array.from(texts).sort((left, right) => right.length - left.length);
}
function consumeOwnMentionTextPrefix(params) {
  for (const candidate of resolveOwnMentionTextCandidates(params)) {
    if (!params.text.startsWith(candidate)) {
      continue;
    }
    const nextChar = params.text[candidate.length] ?? "";
    if (nextChar && !/[\s,:;|./!-]/.test(nextChar)) {
      continue;
    }
    return {
      matched: true,
      rest: params.text.slice(candidate.length).trimStart()
    };
  }
  return {
    matched: false,
    rest: params.text
  };
}
function buildOwnMentionPrefixPatterns(mentionRegexes) {
  return mentionRegexes.flatMap((mentionRegex) => {
    try {
      const flags = mentionRegex.flags.includes("i") ? "i" : "";
      return [
        new RegExp(`^(?:${mentionRegex.source})(?:[\\s,:;|.-]+|$)`, flags),
        new RegExp(`^(?:${mentionRegex.source})(?=[/!])`, flags)
      ];
    } catch {
      return [];
    }
  });
}
function consumeOwnMentionPrefix(params) {
  const exactMentionText = consumeOwnMentionTextPrefix({
    text: params.text,
    mentions: params.mentions,
    botUserId: params.botUserId
  });
  if (exactMentionText.matched) {
    return exactMentionText;
  }
  const prefixPatterns = buildOwnMentionPrefixPatterns(params.mentionRegexes);
  for (const pattern of prefixPatterns) {
    const match = params.text.match(pattern);
    if (!match?.[0]) {
      continue;
    }
    return {
      matched: true,
      rest: params.text.slice(match[0].length).trimStart()
    };
  }
  return {
    matched: false,
    rest: params.text
  };
}
function startsWithOwnMention(params) {
  const consumed = consumeOwnMentionPrefix({
    text: params.text,
    mentionRegexes: params.mentionRegexes,
    mentions: params.mentions,
    botUserId: params.botUserId
  });
  if (consumed.matched) {
    return true;
  }
  const ownBotUserId = params.botUserId ? normalizeOpenzaloAllowEntry(params.botUserId) : "";
  if (!ownBotUserId) {
    return false;
  }
  const simpleTarget = params.text.match(/^@(\S+)/)?.[1] ?? "";
  return Boolean(simpleTarget) && normalizeOpenzaloAllowEntry(simpleTarget) === ownBotUserId;
}
function resolveOpenzaloCommandBody(params) {
  const trimmed = params.rawBody.trim();
  if (!trimmed) {
    return "";
  }
  if (/^[/!]/.test(trimmed)) {
    return trimmed;
  }
  let rest = trimmed;
  let strippedMention = false;
  for (let i = 0; i < 3; i += 1) {
    const consumed = consumeOwnMentionPrefix({
      text: rest,
      mentionRegexes: params.mentionRegexes,
      mentions: params.mentions,
      botUserId: params.botUserId
    });
    if (!consumed.matched) {
      break;
    }
    rest = consumed.rest;
    strippedMention = true;
  }
  if (strippedMention && /^[/!]/.test(rest)) {
    return rest;
  }
  return trimmed;
}
function doesOpenzaloCommandTargetDifferentBot(params) {
  const trimmed = params.commandBody.trim();
  const match = trimmed.match(/^[/!][^\s]+(?:\s+(.*))?$/);
  if (!match) {
    return false;
  }
  const args = (match[1] ?? "").trimStart();
  if (!args.startsWith("@")) {
    return false;
  }
  return !startsWithOwnMention({
    text: args,
    mentionRegexes: params.mentionRegexes,
    mentions: params.mentions,
    botUserId: params.botUserId
  });
}

// src/runtime.ts
var runtime = null;
function setOpenzaloRuntime(next) {
  runtime = next;
}
function getOpenzaloRuntime() {
  if (!runtime) {
    throw new Error("OpenZalo runtime not initialized");
  }
  return runtime;
}

// src/send.ts
import fs3 from "node:fs/promises";
import os4 from "node:os";
import path6 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/outbound-media-compat.ts
import fs2 from "node:fs/promises";
import os2 from "node:os";
import path4 from "node:path";
import { fileURLToPath } from "node:url";
var IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp"
]);
var VIDEO_EXTENSIONS = /* @__PURE__ */ new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"]);
var AUDIO_EXTENSIONS = /* @__PURE__ */ new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav"
]);
function isMissingOutboundMediaSdk(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_MODULE_NOT_FOUND" && error instanceof Error && /openclaw(?:\/plugin-sdk\/outbound-media)?/i.test(error.message);
}
function expandHomePath2(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os2.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith(`~${path4.sep}`)) {
    return path4.join(os2.homedir(), trimmed.slice(2));
  }
  return trimmed;
}
function normalizeLocalPath(input) {
  const trimmed = input.trim();
  if (/^file:\/\//i.test(trimmed)) {
    return fileURLToPath(trimmed);
  }
  return path4.resolve(expandHomePath2(trimmed));
}
function normalizeMediaUrlForFallback(mediaUrl, workspaceDir) {
  const expanded = expandHomePath2(mediaUrl);
  if (workspaceDir && expanded && !path4.isAbsolute(expanded) && !/^[a-zA-Z]:[\\/]/.test(expanded)) {
    return path4.resolve(workspaceDir, expanded);
  }
  return expanded;
}
function isPathInsideRoot(candidate, root) {
  const normalizedCandidate = path4.normalize(candidate);
  const normalizedRoot = path4.normalize(root);
  const rootWithSep = normalizedRoot.endsWith(path4.sep) ? normalizedRoot : normalizedRoot + path4.sep;
  if (process.platform === "win32") {
    return normalizedCandidate.toLowerCase().startsWith(rootWithSep.toLowerCase());
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSep);
}
async function assertFallbackLocalMediaAllowed(source, mediaLocalRoots) {
  const localPath = normalizeLocalPath(source);
  const realFilePath = await fs2.realpath(localPath).catch(() => path4.resolve(localPath));
  const roots = (mediaLocalRoots ?? []).map((root) => path4.resolve(root));
  for (const root of roots) {
    const realRoot = await fs2.realpath(root).catch(() => root);
    if (isPathInsideRoot(realFilePath, realRoot) || isPathInsideRoot(realFilePath, root)) {
      return realFilePath;
    }
  }
  throw new Error(
    `OpenZalo local media path is outside allowed roots. Source="${source}" Existing candidates: ${realFilePath}. Set "channels.openzalo.mediaLocalRoots" (or per-account mediaLocalRoots) to allow more paths.`
  );
}
function inferKindFromFileName(fileName) {
  const ext = fileName ? path4.extname(fileName).toLowerCase() : "";
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  return fileName ? "document" : void 0;
}
function formatMediaLimit(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}
async function loadOutboundMediaFromUrlCompat(mediaUrl, options = {}) {
  try {
    const sdk = await import("openclaw/plugin-sdk/outbound-media");
    return await sdk.loadOutboundMediaFromUrl(mediaUrl, {
      maxBytes: options.maxBytes,
      mediaAccess: options.mediaAccess,
      mediaLocalRoots: options.mediaLocalRoots,
      mediaReadFile: options.mediaReadFile
    });
  } catch (error) {
    if (!isMissingOutboundMediaSdk(error)) {
      throw error;
    }
  }
  if (/^https?:\/\//i.test(mediaUrl)) {
    throw new Error(
      "openclaw/plugin-sdk/outbound-media is unavailable in standalone mode for remote media URLs."
    );
  }
  const fallbackMediaUrl = normalizeMediaUrlForFallback(mediaUrl, options.mediaAccess?.workspaceDir);
  const readFile = options.mediaAccess?.readFile ?? options.mediaReadFile;
  const localRoots = options.mediaAccess?.localRoots ?? options.mediaLocalRoots;
  const localPath = readFile ? normalizeLocalPath(fallbackMediaUrl) : await assertFallbackLocalMediaAllowed(fallbackMediaUrl, localRoots);
  const buffer = readFile ? await readFile(localPath) : await fs2.readFile(localPath);
  if (typeof options.maxBytes === "number" && buffer.byteLength > options.maxBytes) {
    throw new Error(`Media exceeds ${formatMediaLimit(options.maxBytes)} limit`);
  }
  const fileName = path4.basename(localPath) || void 0;
  return {
    buffer,
    fileName,
    kind: inferKindFromFileName(fileName)
  };
}

// src/preferred-tmp-dir.ts
import os3 from "node:os";
import path5 from "node:path";
var preferredTmpDirPromise = null;
function resolveFallbackPreferredTmpDir() {
  let uid;
  try {
    uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  } catch {
    uid = void 0;
  }
  const suffix = uid === void 0 ? "openclaw" : `openclaw-${uid}`;
  return path5.join(os3.tmpdir(), suffix);
}
async function resolvePreferredOpenClawTmpDirCompat() {
  preferredTmpDirPromise ??= (async () => {
    try {
      const mod = await import("openclaw/plugin-sdk/temp-path");
      if (typeof mod.resolvePreferredOpenClawTmpDir === "function") {
        return path5.resolve(mod.resolvePreferredOpenClawTmpDir());
      }
    } catch {
    }
    return path5.resolve(resolveFallbackPreferredTmpDir());
  })();
  return await preferredTmpDirPromise;
}

// src/send.ts
function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}
function stripMediaPrefix(value) {
  return value.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}
function expandHomePath3(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os4.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith(`~${path6.sep}`)) {
    return path6.join(os4.homedir(), trimmed.slice(2));
  }
  return trimmed;
}
function resolveStateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path6.resolve(expandHomePath3(override));
  }
  return path6.join(os4.homedir(), ".openclaw");
}
async function defaultMediaRoots() {
  const stateDir = resolveStateDir();
  return [
    await resolvePreferredOpenClawTmpDirCompat(),
    path6.join(stateDir, "workspace"),
    path6.join(stateDir, "media"),
    path6.join(stateDir, "agents"),
    path6.join(stateDir, "sandboxes")
  ];
}
function resolveConfiguredRootPath(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty mediaLocalRoots entry is not allowed");
  }
  if (trimmed.startsWith("file://")) {
    let parsed;
    try {
      parsed = fileURLToPath2(trimmed);
    } catch {
      throw new Error(`Invalid file:// URL in mediaLocalRoots: ${input}`);
    }
    if (!path6.isAbsolute(parsed)) {
      throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);
    }
    return path6.resolve(parsed);
  }
  const expanded = expandHomePath3(trimmed);
  if (!path6.isAbsolute(expanded)) {
    throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);
  }
  return path6.resolve(expanded);
}
async function resolveMediaRoots(localRoots) {
  const roots = [...localRoots ?? [], ...await defaultMediaRoots()];
  const deduped = /* @__PURE__ */ new Set();
  const resolved = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) {
      continue;
    }
    const resolvedPath = resolveConfiguredRootPath(trimmed);
    if (deduped.has(resolvedPath)) {
      continue;
    }
    deduped.add(resolvedPath);
    resolved.push(resolvedPath);
  }
  return resolved;
}
function resolveOpenzaloMediaMaxBytes(account) {
  const configuredMb = account.config.mediaMaxMb;
  if (typeof configuredMb !== "number" || !Number.isFinite(configuredMb) || configuredMb <= 0) {
    return void 0;
  }
  return Math.round(configuredMb * 1024 * 1024);
}
function normalizeLocalMediaSource(source) {
  if (/^file:\/\//i.test(source)) {
    try {
      return fileURLToPath2(source);
    } catch {
      return source;
    }
  }
  return expandHomePath3(source);
}
async function fileExists(filePath) {
  try {
    const stat = await fs3.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
function isOpenClawMediaStorePath(source) {
  const parts = source.split(/[\\/]/).filter((part) => part && part !== ".");
  return parts[0] === "media";
}
async function resolveMediaLoadSource(params) {
  if (!params.source || isHttpUrl(params.source)) {
    return params.source;
  }
  const normalized = normalizeLocalMediaSource(params.source);
  if (path6.isAbsolute(normalized)) {
    return normalized;
  }
  const candidates = [path6.resolve(normalized)];
  if (params.mediaAccess?.workspaceDir) {
    candidates.push(path6.resolve(params.mediaAccess.workspaceDir, normalized));
  }
  for (const root of params.mediaLocalRoots) {
    candidates.push(path6.resolve(root, normalized));
    if (path6.basename(root) === "media" && isOpenClawMediaStorePath(normalized)) {
      candidates.push(path6.resolve(path6.dirname(root), normalized));
    }
  }
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    const resolvedCandidate = path6.resolve(candidate);
    if (seen.has(resolvedCandidate)) {
      continue;
    }
    seen.add(resolvedCandidate);
    if (await fileExists(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }
  return normalized;
}
async function stageMediaSource(params) {
  const normalized = stripMediaPrefix(params.source);
  if (!normalized) {
    return { source: "", sourceType: "path", rawSourceType: "path" };
  }
  const mediaLocalRoots = await resolveMediaRoots(params.mediaLocalRoots);
  const maxBytes = resolveOpenzaloMediaMaxBytes(params.account);
  const loadSource = await resolveMediaLoadSource({
    source: normalized,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots
  });
  const loaded = await loadOutboundMediaFromUrlCompat(loadSource, {
    maxBytes,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots,
    mediaReadFile: params.mediaReadFile
  });
  const saved = await getOpenzaloRuntime().channel.media.saveMediaBuffer(
    loaded.buffer,
    loaded.contentType,
    "outbound",
    Math.max(maxBytes ?? 0, loaded.buffer.byteLength, 1),
    loaded.fileName
  );
  return {
    source: saved.path,
    sourceType: "path",
    rawSourceType: isHttpUrl(normalized) ? "url" : "path",
    mediaKind: loaded.kind
  };
}
var IMAGE_EXTENSIONS2 = /* @__PURE__ */ new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "webp",
  "heic",
  "heif",
  "avif"
]);
var VIDEO_EXTENSIONS2 = /* @__PURE__ */ new Set(["mp4", "mov", "avi", "webm", "mkv"]);
var AUDIO_EXTENSIONS2 = /* @__PURE__ */ new Set(["aac", "mp3", "m4a", "wav", "ogg", "opus", "flac"]);
function extractFileExtension(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  const fileName = withoutQuery.split("/").pop() ?? withoutQuery;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return "";
  }
  return fileName.slice(dot + 1).toLowerCase();
}
function resolveMediaCommand(source, mediaKind) {
  if (mediaKind === "audio") {
    return "voice";
  }
  if (mediaKind === "video") {
    return "video";
  }
  if (mediaKind === "image") {
    return "image";
  }
  const ext = extractFileExtension(source);
  if (AUDIO_EXTENSIONS2.has(ext)) {
    return "voice";
  }
  if (VIDEO_EXTENSIONS2.has(ext)) {
    return "video";
  }
  if (IMAGE_EXTENSIONS2.has(ext)) {
    return "image";
  }
  return "upload";
}
function buildOpenzcaMediaArgs(params) {
  const { target, source, mediaCommand } = params;
  const args = ["msg", mediaCommand];
  if (mediaCommand === "upload") {
    if (isHttpUrl(source)) {
      args.push(target.threadId, "--url", source);
    } else {
      args.push(source, target.threadId);
    }
  } else {
    args.push(target.threadId);
    if (isHttpUrl(source)) {
      args.push("--url", source);
    } else {
      args.push(source);
    }
    const caption = params.message?.trim();
    if (mediaCommand === "video" && caption) {
      args.push("--message", caption);
    }
  }
  if (target.isGroup) {
    args.push("--group");
  }
  return args;
}
function logOutbound(level, message, meta2) {
  try {
    const logger = getOpenzaloRuntime().logging.getChildLogger({ subsystem: "openzalo/outbound" });
    logger[level]?.(message, meta2);
  } catch {
  }
}
async function sendTextOpenzalo(options) {
  const { account, to, text } = options;
  const target = parseOpenzaloTarget(to);
  const body = text.trim();
  if (!body) {
    return { messageId: "empty", kind: "text" };
  }
  const args = ["msg", "send", target.threadId, body];
  if (target.isGroup) {
    args.push("--group");
  }
  logOutbound("info", "sendText request", {
    accountId: account.accountId,
    to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    textLength: body.length
  });
  try {
    const result = await runOpenzcaAccountCommand({
      account,
      binary: account.zcaBinary,
      profile: account.profile,
      args,
      timeoutMs: 2e4
    });
    const refs = parseOpenzcaMessageRefs(result.stdout);
    logOutbound("info", "sendText success", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      msgId: refs.msgId,
      cliMsgId: refs.cliMsgId
    });
    return {
      messageId: refs.msgId || "ok",
      msgId: refs.msgId,
      cliMsgId: refs.cliMsgId,
      kind: "text",
      textPreview: body
    };
  } catch (error) {
    logOutbound("error", "sendText failed", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      error: String(error)
    });
    throw error;
  }
}
async function sendMediaOpenzalo(options) {
  const { account, to, text, mediaUrl, mediaPath, mediaAccess, mediaLocalRoots, mediaReadFile } = options;
  const target = parseOpenzaloTarget(to);
  const rawSource = (mediaPath ?? mediaUrl ?? "").trim();
  if (!rawSource) {
    if (text?.trim()) {
      const receipt = await sendTextOpenzalo({
        cfg: options.cfg,
        account,
        to,
        text
      });
      return {
        ...receipt,
        receipts: [receipt]
      };
    }
    return {
      messageId: "empty",
      kind: "media",
      receipts: []
    };
  }
  const resolvedSource = await stageMediaSource({
    account,
    source: rawSource,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile
  });
  const source = resolvedSource.source;
  const resolvedMediaCommand = resolveMediaCommand(source, resolvedSource.mediaKind);
  const mediaCommand = resolvedMediaCommand;
  const args = buildOpenzcaMediaArgs({
    target,
    source,
    mediaCommand,
    message: text
  });
  const sourceType = resolvedSource.sourceType;
  const rawSourceType = resolvedSource.rawSourceType;
  logOutbound("info", "sendMedia request", {
    accountId: account.accountId,
    to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    sourceType,
    rawSourceType,
    rawSource,
    source,
    mediaCommand: resolvedMediaCommand,
    hasCaption: Boolean(text?.trim())
  });
  try {
    const result = await runOpenzcaAccountCommand({
      account,
      binary: account.zcaBinary,
      profile: account.profile,
      args,
      timeoutMs: 6e4
    });
    const refs = parseOpenzcaMessageRefs(result.stdout);
    const mediaReceipt = {
      messageId: refs.msgId || "ok",
      msgId: refs.msgId,
      cliMsgId: refs.cliMsgId,
      kind: "media"
    };
    const receipts = [mediaReceipt];
    const captionSentInline = mediaCommand === "video" && Boolean(text?.trim());
    const shouldSendCaptionAsText = text?.trim() && mediaCommand !== "voice" && !captionSentInline;
    if (shouldSendCaptionAsText) {
      const captionReceipt = await sendTextOpenzalo({
        cfg: options.cfg,
        account,
        to,
        text
      });
      receipts.push(captionReceipt);
    }
    const primary = [...receipts].reverse().find((entry) => Boolean(entry.msgId || entry.cliMsgId)) || receipts[receipts.length - 1] || mediaReceipt;
    logOutbound("info", "sendMedia success", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      sourceType,
      rawSourceType,
      mediaCommand,
      msgId: primary.msgId,
      cliMsgId: primary.cliMsgId,
      receiptCount: receipts.length
    });
    return {
      ...primary,
      receipts
    };
  } catch (error) {
    logOutbound("error", "sendMedia failed", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      sourceType,
      rawSourceType,
      mediaCommand,
      source,
      error: String(error)
    });
    throw error;
  }
}
async function sendTypingOpenzalo(options) {
  const { account, to } = options;
  const target = parseOpenzaloTarget(to);
  const args = ["msg", "typing", target.threadId];
  if (target.isGroup) {
    args.push("--group");
  }
  try {
    await runOpenzcaAccountCommand({
      account,
      binary: account.zcaBinary,
      profile: account.profile,
      args,
      timeoutMs: 1e4
    });
  } catch (error) {
    logOutbound("warn", "sendTyping failed", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      error: String(error)
    });
    throw error;
  }
}

// src/policy.ts
function resolveGroupId(rawTarget) {
  const stripped = stripOpenzaloPrefix(rawTarget).replace(/^thread:/i, "").trim();
  if (!stripped) {
    return "";
  }
  if (/^group:/i.test(stripped)) {
    return stripped.replace(/^group:/i, "").trim();
  }
  if (/^g[:-]/i.test(stripped)) {
    return stripped.replace(/^g[:-]/i, "").trim();
  }
  return stripped;
}
function buildGroupLookupKeys(target) {
  const groupId = resolveGroupId(target);
  const candidates = [
    target.trim(),
    stripOpenzaloPrefix(target).trim(),
    groupId,
    groupId ? `group:${groupId}` : "",
    groupId ? `g-${groupId}` : "",
    groupId ? `g:${groupId}` : ""
  ].map((entry) => entry.trim()).filter(Boolean);
  return Array.from(new Set(candidates));
}
function matchesGroupAllowlist(params) {
  const aliases = buildGroupLookupKeys(params.target);
  return aliases.some((alias) => allowlistHasEntry(params.groupAllowFrom, alias));
}
function resolveOpenzaloGroupMatch(params) {
  const groups = params.groups ?? {};
  const hasConfiguredGroups = Object.keys(groups).length > 0;
  const wildcard = groups["*"];
  for (const key of buildGroupLookupKeys(params.target)) {
    const direct = groups[key];
    if (direct) {
      return {
        allowed: true,
        groupConfig: direct,
        wildcardConfig: wildcard,
        hasConfiguredGroups
      };
    }
  }
  if (wildcard) {
    return {
      allowed: true,
      wildcardConfig: wildcard,
      hasConfiguredGroups
    };
  }
  return {
    allowed: false,
    hasConfiguredGroups
  };
}
function normalizeAllowlist(entries) {
  return (entries ?? []).map((entry) => normalizeOpenzaloAllowEntry(String(entry))).filter(Boolean);
}
function allowlistHasEntry(allowFrom, value) {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalized = normalizeOpenzaloAllowEntry(value);
  return allowFrom.includes(normalized);
}
function resolveOpenzaloGroupAccessGate(params) {
  const policy = params.groupPolicy ?? "allowlist";
  if (policy === "disabled") {
    return { allowed: false, reason: "groupPolicy=disabled" };
  }
  if (params.groupMatch.groupConfig?.enabled === false || params.groupMatch.wildcardConfig?.enabled === false) {
    return { allowed: false, reason: "group disabled" };
  }
  const targetAllowed = params.groupMatch.allowed || matchesGroupAllowlist({
    groupAllowFrom: params.groupAllowFrom,
    target: params.target
  });
  if (policy === "allowlist") {
    if (!targetAllowed) {
      if (!params.groupMatch.hasConfiguredGroups && params.groupAllowFrom.length === 0) {
        return {
          allowed: false,
          reason: "groupPolicy=allowlist and no groups configured"
        };
      }
      return { allowed: false, reason: "group not allowlisted" };
    }
  }
  return {
    allowed: true,
    reason: policy === "open" ? "open" : "allowlisted"
  };
}
function resolveOpenzaloRequireMention(params) {
  if (params.groupConfig?.requireMention !== void 0) {
    return params.groupConfig.requireMention;
  }
  if (params.wildcardConfig?.requireMention !== void 0) {
    return params.wildcardConfig.requireMention;
  }
  return true;
}
function resolveOpenzaloGroupSenderAllowed(params) {
  const sender = normalizeOpenzaloAllowEntry(params.senderId);
  const inner = normalizeAllowlist(
    params.groupConfig?.allowFrom?.length ? params.groupConfig.allowFrom : params.wildcardConfig?.allowFrom
  );
  if (inner.length > 0) {
    return inner.includes("*") || inner.includes(sender);
  }
  return true;
}
function normalizeSenderKey(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return withoutAt.toLowerCase();
}
function resolveOpenzaloToolsBySender(params) {
  const toolsBySender = params.toolsBySender;
  if (!toolsBySender) {
    return void 0;
  }
  const entries = Object.entries(toolsBySender);
  if (entries.length === 0) {
    return void 0;
  }
  const normalized = /* @__PURE__ */ new Map();
  let wildcard;
  for (const [rawKey, policy] of entries) {
    if (!policy) {
      continue;
    }
    const key = normalizeSenderKey(rawKey);
    if (!key) {
      continue;
    }
    if (key === "*") {
      wildcard = policy;
      continue;
    }
    if (!normalized.has(key)) {
      normalized.set(key, policy);
    }
  }
  const candidates = [
    params.senderId?.trim(),
    params.senderE164?.trim(),
    params.senderUsername?.trim(),
    params.senderName?.trim()
  ].filter(Boolean);
  for (const candidate of candidates) {
    const key = normalizeSenderKey(candidate);
    if (!key) {
      continue;
    }
    const matched = normalized.get(key);
    if (matched) {
      return matched;
    }
  }
  return wildcard;
}
function resolveOpenzaloGroupToolPolicy(params) {
  const fromGroup = resolveOpenzaloToolsBySender({
    toolsBySender: params.groupConfig?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164
  });
  if (fromGroup) {
    return fromGroup;
  }
  if (params.groupConfig?.tools) {
    return params.groupConfig.tools;
  }
  const fromWildcard = resolveOpenzaloToolsBySender({
    toolsBySender: params.wildcardConfig?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164
  });
  if (fromWildcard) {
    return fromWildcard;
  }
  return params.wildcardConfig?.tools;
}
function resolveOpenzaloGroupCommandAuthorizers(params) {
  const normalizedSender = normalizeOpenzaloAllowEntry(params.senderId);
  const groupAllowFrom = normalizeAllowlist(
    params.groupConfig?.allowFrom?.length ? params.groupConfig.allowFrom : params.wildcardConfig?.allowFrom
  );
  return {
    owner: {
      configured: params.ownerAllowFrom.length > 0,
      allowed: allowlistHasEntry(params.ownerAllowFrom, normalizedSender)
    },
    group: {
      configured: groupAllowFrom.length > 0,
      allowed: allowlistHasEntry(groupAllowFrom, normalizedSender)
    }
  };
}

// src/outbound-dedupe.ts
import { createHash as createHash2 } from "node:crypto";
var OPENZALO_OUTBOUND_RECENT_TTL_MS = 15e3;
var MAX_OPENZALO_OUTBOUND_RECENT_SIGNATURES = 5e3;
var inflightBySignature = /* @__PURE__ */ new Map();
var inflightByTicket = /* @__PURE__ */ new Map();
var recentBySignature = /* @__PURE__ */ new Map();
var nextTicketId = 0;
function normalizeIdentity(value) {
  return (value ?? "").trim();
}
function buildSignature(params) {
  const accountId = normalizeIdentity(params.accountId);
  const sessionKey = normalizeIdentity(params.sessionKey) || "-";
  const target = normalizeIdentity(params.target);
  const idempotencyContext = normalizeIdentity(params.idempotencyContext) || "-";
  const sequence = Number.isFinite(params.sequence) && typeof params.sequence === "number" ? String(Math.max(1, Math.floor(params.sequence))) : "1";
  const hash = createHash2("sha256");
  hash.update(accountId, "utf8");
  hash.update("", "utf8");
  hash.update(sessionKey, "utf8");
  hash.update("", "utf8");
  hash.update(target, "utf8");
  hash.update("", "utf8");
  hash.update(params.kind, "utf8");
  hash.update("", "utf8");
  hash.update(idempotencyContext, "utf8");
  hash.update("", "utf8");
  hash.update(sequence, "utf8");
  hash.update("", "utf8");
  hash.update(params.text ?? "", "utf8");
  hash.update("", "utf8");
  hash.update(params.mediaRef ?? "", "utf8");
  return hash.digest("hex");
}
function evictRecentOverflow() {
  while (recentBySignature.size > MAX_OPENZALO_OUTBOUND_RECENT_SIGNATURES) {
    const oldest = recentBySignature.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    recentBySignature.delete(oldest);
  }
}
function pruneExpired2(nowMs = Date.now()) {
  for (const [signature, expiresAt] of recentBySignature.entries()) {
    if (expiresAt <= nowMs) {
      recentBySignature.delete(signature);
    }
  }
  const staleCutoff = nowMs - OPENZALO_OUTBOUND_RECENT_TTL_MS * 4;
  for (const [signature, entry] of inflightBySignature.entries()) {
    if (entry.createdAt < staleCutoff) {
      inflightBySignature.delete(signature);
      inflightByTicket.delete(entry.ticketId);
    }
  }
}
function acquireOpenzaloOutboundDedupeSlot(params, nowMs = Date.now()) {
  pruneExpired2(nowMs);
  const signature = buildSignature(params);
  const recentUntil = recentBySignature.get(signature);
  if (typeof recentUntil === "number" && recentUntil > nowMs) {
    return { acquired: false, reason: "recent" };
  }
  if (inflightBySignature.has(signature)) {
    return { acquired: false, reason: "inflight" };
  }
  nextTicketId += 1;
  const entry = {
    ticketId: nextTicketId,
    signature,
    createdAt: nowMs
  };
  inflightBySignature.set(signature, entry);
  inflightByTicket.set(entry.ticketId, entry);
  return {
    acquired: true,
    ticket: {
      id: entry.ticketId,
      signature
    }
  };
}
function releaseOpenzaloOutboundDedupeSlot(params) {
  const nowMs = params.nowMs ?? Date.now();
  const entry = inflightByTicket.get(params.ticket.id);
  if (!entry || entry.signature !== params.ticket.signature) {
    return;
  }
  inflightByTicket.delete(entry.ticketId);
  inflightBySignature.delete(entry.signature);
  if (params.sent) {
    recentBySignature.set(entry.signature, nowMs + OPENZALO_OUTBOUND_RECENT_TTL_MS);
    evictRecentOverflow();
  }
}

// src/reply-payload-transform.ts
var MEDIA_DIRECTIVE_RE = /^\s*MEDIA:\s*(.+)$/i;
var WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
var SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
var HAS_FILE_EXT_RE = /\.\w{1,10}$/;
var TRAVERSAL_SEGMENT_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)/;
function cleanMediaCandidate(raw) {
  return raw.trim().replace(/^file:\/\//i, "").replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
}
function unwrapQuoted(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return void 0;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return first === last && (first === `"` || first === "'" || first === "`") ? trimmed.slice(1, -1).trim() : void 0;
}
function hasTraversalOrHomePrefix(value) {
  return value === ".." || value.startsWith("../") || value.startsWith("~") || TRAVERSAL_SEGMENT_RE.test(value);
}
function looksLikeLocalPath(value) {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~") || WINDOWS_DRIVE_RE.test(value) || value.startsWith("\\\\") || !SCHEME_RE.test(value) && (value.includes("/") || value.includes("\\"));
}
function isValidMediaSource(value, opts) {
  if (!value || value.length > 4096 || hasTraversalOrHomePrefix(value)) {
    return false;
  }
  if (/^https?:\/\//i.test(value)) {
    return true;
  }
  if (value.startsWith("/") || value.startsWith("./") || WINDOWS_DRIVE_RE.test(value) || value.startsWith("\\\\") || !SCHEME_RE.test(value) && (value.includes("/") || value.includes("\\"))) {
    return true;
  }
  return Boolean(opts?.allowBareFilename && !SCHEME_RE.test(value) && HAS_FILE_EXT_RE.test(value));
}
function parseMediaSources(raw) {
  const unwrapped = unwrapQuoted(raw);
  const direct = cleanMediaCandidate(unwrapped ?? raw);
  if (isValidMediaSource(direct, { allowBareFilename: true })) {
    return [direct];
  }
  if (unwrapped) {
    return [];
  }
  return raw.split(/\s+/).map(cleanMediaCandidate).filter((candidate) => isValidMediaSource(candidate, { allowBareFilename: true }));
}
function dedupeMediaSources(sources) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const source of sources) {
    const trimmed = source.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
function hasOpenzaloMediaDirectives(text) {
  return /^\s*MEDIA:/im.test(text);
}
function parseOpenzaloMediaDirectives(payload) {
  const rawText = payload.text;
  if (!rawText || !hasOpenzaloMediaDirectives(rawText)) {
    return payload;
  }
  const keptLines = [];
  const mediaSources = [];
  let inFence = false;
  let changed = false;
  for (const line of rawText.trimEnd().split("\n")) {
    const trimmedStart = line.trimStart();
    if (/^(?:```|~~~)/.test(trimmedStart)) {
      inFence = !inFence;
      keptLines.push(line);
      continue;
    }
    if (inFence) {
      keptLines.push(line);
      continue;
    }
    const directive = line.match(MEDIA_DIRECTIVE_RE);
    if (!directive) {
      keptLines.push(line);
      continue;
    }
    const sources = parseMediaSources(directive[1]);
    if (sources.length > 0) {
      mediaSources.push(...sources);
      changed = true;
      continue;
    }
    const cleanedPayload = cleanMediaCandidate(directive[1]);
    if (!looksLikeLocalPath(cleanedPayload)) {
      keptLines.push(line);
    } else {
      changed = true;
    }
  }
  const text = keptLines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (mediaSources.length === 0) {
    return changed ? {
      ...payload,
      text: text || void 0
    } : payload;
  }
  const existingMediaSources = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
  const mediaUrls = dedupeMediaSources([...existingMediaSources, ...mediaSources]);
  return {
    ...payload,
    text: text || void 0,
    mediaUrl: payload.mediaUrl ?? mediaUrls[0],
    mediaUrls
  };
}

// src/reply-session-recovery.ts
import fs4 from "node:fs/promises";
import path7 from "node:path";
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function listOpenzaloPayloadMedia(payload) {
  return payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
}
function normalizeOpenzaloRecoveryText(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
function parseTextSignaturePhase(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) && typeof parsed.phase === "string" ? parsed.phase : void 0;
  } catch {
    return void 0;
  }
}
function extractAssistantTextFromSessionLine(line, lineNumber) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.message)) {
    return null;
  }
  const message = parsed.message;
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }
  const textParts = [];
  let finalAnswer = false;
  for (const item of message.content) {
    if (!isRecord(item)) {
      continue;
    }
    if (parseTextSignaturePhase(item.textSignature) === "final_answer") {
      finalAnswer = true;
    }
    if (item.type === "text" && typeof item.text === "string") {
      textParts.push(item.text);
    }
  }
  return textParts.length > 0 ? {
    text: textParts.join("\n"),
    lineNumber,
    finalAnswer
  } : null;
}
function isSessionIndexPath(storePath) {
  return path7.basename(storePath) === "sessions.json";
}
function extractSessionFileFromIndex(index, sessionKey) {
  if (!sessionKey || !isRecord(index)) {
    return null;
  }
  const entry = index[sessionKey];
  if (!isRecord(entry) || typeof entry.sessionFile !== "string") {
    return null;
  }
  return entry.sessionFile.trim() || null;
}
async function resolveOpenzaloRecoveryStoreCandidate(params) {
  if (!isSessionIndexPath(params.storePath)) {
    return {
      storePath: params.storePath,
      source: "direct"
    };
  }
  let rawIndex;
  try {
    rawIndex = await fs4.readFile(params.storePath, "utf8");
  } catch (error) {
    params.trace?.("recovery.indexReadFailed", {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
  try {
    const sessionFile = extractSessionFileFromIndex(JSON.parse(rawIndex), params.sessionKey);
    if (!sessionFile) {
      params.trace?.("recovery.indexMiss", {
        storePath: params.storePath,
        sessionKey: params.sessionKey
      });
      return null;
    }
    params.trace?.("recovery.indexHit", {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      sessionFile
    });
    return {
      storePath: sessionFile,
      source: "sessionsIndex"
    };
  } catch (error) {
    params.trace?.("recovery.indexParseFailed", {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}
async function recoverOpenzaloMediaPayloadFromCandidate(params) {
  let raw;
  try {
    raw = await fs4.readFile(params.candidate.storePath, "utf8");
  } catch (error) {
    params.trace?.("recovery.readFailed", {
      storePath: params.originalStorePath,
      candidateStorePath: params.candidate.storePath,
      candidateSource: params.candidate.source,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
  const lines = raw.split(/\r?\n/);
  const start = Math.max(0, lines.length - params.maxLines);
  let assistantTextLinesChecked = 0;
  for (let index = lines.length - 1; index >= start; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    const extracted = extractAssistantTextFromSessionLine(line, index + 1);
    if (!extracted) {
      continue;
    }
    assistantTextLinesChecked += 1;
    if (!hasOpenzaloMediaDirectives(extracted.text)) {
      continue;
    }
    const recovered = parseOpenzaloMediaDirectives({
      ...params.payload,
      text: extracted.text,
      mediaUrl: void 0,
      mediaUrls: void 0
    });
    const recoveredMedia = listOpenzaloPayloadMedia(recovered);
    const recoveredText = normalizeOpenzaloRecoveryText(recovered.text);
    if (recoveredMedia.length === 0) {
      params.trace?.("recovery.directiveWithoutMedia", {
        storePath: params.originalStorePath,
        candidateStorePath: params.candidate.storePath,
        candidateSource: params.candidate.source,
        sourceLine: extracted.lineNumber,
        finalAnswer: extracted.finalAnswer || void 0
      });
      return null;
    }
    if (recoveredText !== params.deliveryText) {
      params.trace?.("recovery.skipTextMismatch", {
        storePath: params.originalStorePath,
        candidateStorePath: params.candidate.storePath,
        candidateSource: params.candidate.source,
        sourceLine: extracted.lineNumber,
        finalAnswer: extracted.finalAnswer || void 0,
        deliveryTextPreview: params.deliveryText.slice(0, 240),
        recoveredTextPreview: recoveredText.slice(0, 240)
      });
      return null;
    }
    params.trace?.("recovery.hit", {
      storePath: params.originalStorePath,
      candidateStorePath: params.candidate.storePath,
      candidateSource: params.candidate.source,
      sourceLine: extracted.lineNumber,
      finalAnswer: extracted.finalAnswer || void 0,
      mediaCount: recoveredMedia.length,
      mediaRefs: recoveredMedia.slice(0, 5)
    });
    return recovered;
  }
  params.trace?.("recovery.miss", {
    storePath: params.originalStorePath,
    candidateStorePath: params.candidate.storePath,
    candidateSource: params.candidate.source,
    checkedLines: lines.length - start,
    assistantTextLinesChecked
  });
  return null;
}
async function recoverOpenzaloMediaPayloadFromSession(params) {
  const currentMedia = listOpenzaloPayloadMedia(params.payload);
  const deliveryText = normalizeOpenzaloRecoveryText(params.payload.text);
  if (!params.storePath || currentMedia.length > 0 || !deliveryText) {
    return null;
  }
  const maxLines = Math.max(1, Math.floor(params.maxLines ?? 120));
  const candidate = await resolveOpenzaloRecoveryStoreCandidate({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    trace: params.trace
  });
  if (!candidate) {
    params.trace?.("recovery.noCandidates", {
      storePath: params.storePath,
      sessionKey: params.sessionKey
    });
    return null;
  }
  return recoverOpenzaloMediaPayloadFromCandidate({
    candidate,
    originalStorePath: params.storePath,
    payload: params.payload,
    deliveryText,
    maxLines,
    trace: params.trace
  });
}

// src/utils/dedupe-strings.ts
function dedupeStrings(values) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// src/inbound.ts
var CHANNEL_ID = "openzalo";
var OPENZALO_REPLY_TRACE_ENV_KEYS = [
  "OPENZALO_REPLY_TRACE",
  "OPENZALO_MEDIA_TRACE",
  "OPENZALO_DEBUG_MEDIA"
];
var DEFAULT_GROUP_SYSTEM_PROMPT = "When sending media/files in this same group, never claim success unless media is actually attached. Prefer the message tool with media/path/filePath. If inlining, use MEDIA:./relative-path or MEDIA:https://... in your reply text. If the source file is outside workspace, copy it into workspace first and then use a relative MEDIA path.";
function isTruthyEnvValue(value) {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}
function isOpenzaloReplyTraceEnabled() {
  return OPENZALO_REPLY_TRACE_ENV_KEYS.some((key) => isTruthyEnvValue(process.env[key]));
}
function clipOpenzaloTraceValue(value, limit = 240) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}
function summarizeOpenzaloReplyPayload(payload) {
  const text = payload.text ?? "";
  const mediaUrls = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
  return {
    textLength: text.length,
    textPreview: text ? clipOpenzaloTraceValue(text) : void 0,
    hasMediaDirective: text ? hasOpenzaloMediaDirectives(text) : false,
    mediaCount: mediaUrls.length,
    mediaRefs: mediaUrls.slice(0, 5).map((entry) => clipOpenzaloTraceValue(entry, 320)),
    mediaUrl: payload.mediaUrl ? clipOpenzaloTraceValue(payload.mediaUrl, 320) : void 0,
    audioAsVoice: payload.audioAsVoice === true || void 0,
    replyToId: payload.replyToId || void 0
  };
}
function createOpenzaloReplyTraceLogger(params) {
  if (!isOpenzaloReplyTraceEnabled()) {
    return void 0;
  }
  return (event, meta2) => {
    const payload = {
      accountId: params.accountId,
      target: params.target,
      sessionKey: params.sessionKey,
      ...meta2
    };
    try {
      params.runtime.log?.(`[openzalo/reply-trace] ${event} ${JSON.stringify(payload)}`);
    } catch {
      params.runtime.log?.(`[openzalo/reply-trace] ${event}`);
    }
  };
}
var outboundRuntimePromise;
var replyPayloadRuntimePromise;
var agentMediaRuntimePromise;
function isMissingOpenClawOutboundRuntime(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_MODULE_NOT_FOUND" && error instanceof Error && /openclaw(?:\/plugin-sdk\/outbound-runtime)?/i.test(error.message);
}
function isOpenClawOutboundRuntime(value) {
  return typeof value === "object" && value !== null && typeof value.createOutboundPayloadPlan === "function" && typeof value.projectOutboundPayloadPlanForDelivery === "function";
}
function isMissingOpenClawReplyPayloadRuntime(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_MODULE_NOT_FOUND" && error instanceof Error && /openclaw(?:\/plugin-sdk\/reply-payload)?/i.test(error.message);
}
function isMissingOpenClawAgentMediaRuntime(error) {
  return typeof error === "object" && error !== null && error instanceof Error && "code" in error && (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") && /openclaw(?:\/plugin-sdk\/(?:agent-media-payload|media-runtime))?/i.test(error.message);
}
function isOpenClawReplyPayloadRuntime(value) {
  return typeof value === "object" && value !== null && typeof value.resolvePayloadMediaUrls === "function" && typeof value.sendPayloadMediaSequenceOrFallback === "function";
}
function isOpenClawAgentMediaRuntime(value) {
  return typeof value === "object" && value !== null && typeof value.getAgentScopedMediaLocalRoots === "function";
}
async function loadOpenClawOutboundRuntime() {
  outboundRuntimePromise ??= import("openclaw/plugin-sdk/outbound-runtime").then((mod) => isOpenClawOutboundRuntime(mod) ? mod : null).catch((error) => {
    if (isMissingOpenClawOutboundRuntime(error)) {
      return null;
    }
    throw error;
  });
  return outboundRuntimePromise;
}
async function loadOpenClawReplyPayloadRuntime() {
  replyPayloadRuntimePromise ??= import("openclaw/plugin-sdk/reply-payload").then((mod) => isOpenClawReplyPayloadRuntime(mod) ? mod : null).catch((error) => {
    if (isMissingOpenClawReplyPayloadRuntime(error)) {
      return null;
    }
    throw error;
  });
  return replyPayloadRuntimePromise;
}
async function loadOpenClawAgentMediaRuntime() {
  agentMediaRuntimePromise ??= import("openclaw/plugin-sdk/agent-media-payload").then((mod) => isOpenClawAgentMediaRuntime(mod) ? mod : null).catch((error) => {
    if (isMissingOpenClawAgentMediaRuntime(error)) {
      return null;
    }
    throw error;
  });
  return agentMediaRuntimePromise;
}
function toOpenzaloOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function normalizeOpenzaloAgentId(value) {
  return String(value ?? "").trim().toLowerCase();
}
function listOpenzaloAgentEntries(cfg) {
  const agents = cfg.agents ?? {};
  return Array.isArray(agents.list) ? agents.list.filter(
    (entry) => typeof entry === "object" && entry !== null
  ) : [];
}
function resolveOpenzaloUserPath(input) {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return os5.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith(`~${path8.sep}`)) {
    return path8.join(os5.homedir(), trimmed.slice(2));
  }
  return trimmed;
}
function resolveOpenzaloDefaultAgentId(cfg) {
  const entries = listOpenzaloAgentEntries(cfg);
  const defaultEntry = entries.find((entry) => entry.default === true) ?? entries[0];
  return normalizeOpenzaloAgentId(defaultEntry?.id) || "main";
}
function resolveOpenzaloAgentWorkspaceDir(cfg, agentId) {
  const id = normalizeOpenzaloAgentId(agentId) || resolveOpenzaloDefaultAgentId(cfg);
  const configured = toOpenzaloOptionalString(
    listOpenzaloAgentEntries(cfg).find((entry) => normalizeOpenzaloAgentId(entry.id) === id)?.workspace
  );
  if (configured) {
    return path8.resolve(resolveOpenzaloUserPath(configured));
  }
  const defaultWorkspace = toOpenzaloOptionalString(
    (cfg.agents ?? {}).defaults?.workspace
  );
  if (defaultWorkspace) {
    const base = path8.resolve(resolveOpenzaloUserPath(defaultWorkspace));
    return id === resolveOpenzaloDefaultAgentId(cfg) ? base : path8.join(base, id);
  }
  const stateDir = resolveOpenzaloStateDir(process.env);
  return id === resolveOpenzaloDefaultAgentId(cfg) ? path8.join(stateDir, "workspace") : path8.join(stateDir, `workspace-${id}`);
}
function resolveOpenzaloFallbackAgentMediaLocalRoots(cfg, agentId) {
  const stateDir = resolveOpenzaloStateDir(process.env);
  return [
    path8.join(stateDir, "workspace"),
    path8.join(stateDir, "media"),
    path8.join(stateDir, "agents"),
    path8.join(stateDir, "sandboxes"),
    resolveOpenzaloAgentWorkspaceDir(cfg, agentId)
  ];
}
function dedupeOpenzaloMediaRoots(roots) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
async function resolveOpenzaloReplyMediaLocalRoots(params) {
  const runtimeRoots = (await loadOpenClawAgentMediaRuntime())?.getAgentScopedMediaLocalRoots(
    params.cfg,
    params.agentId
  ) ?? resolveOpenzaloFallbackAgentMediaLocalRoots(params.cfg, params.agentId);
  const roots = dedupeOpenzaloMediaRoots([
    ...params.account.config.mediaLocalRoots ?? [],
    ...runtimeRoots
  ]);
  return roots.length > 0 ? roots : void 0;
}
function resolveOpenzaloPayloadMediaUrlsFallback(payload) {
  if (payload.mediaUrls?.length) {
    return payload.mediaUrls;
  }
  if (payload.mediaUrl) {
    return [payload.mediaUrl];
  }
  return [];
}
async function resolveOpenzaloPayloadMediaUrls(payload) {
  const runtime2 = await loadOpenClawReplyPayloadRuntime();
  return runtime2?.resolvePayloadMediaUrls(payload) ?? resolveOpenzaloPayloadMediaUrlsFallback(payload);
}
async function sendOpenzaloPayloadMediaSequenceOrFallback(params) {
  const runtime2 = await loadOpenClawReplyPayloadRuntime();
  if (runtime2) {
    return await runtime2.sendPayloadMediaSequenceOrFallback(params);
  }
  if (params.mediaUrls.length === 0) {
    return params.sendNoMedia ? await params.sendNoMedia() : params.fallbackResult;
  }
  let lastResult;
  for (let index = 0; index < params.mediaUrls.length; index += 1) {
    const mediaUrl = params.mediaUrls[index];
    if (!mediaUrl) {
      continue;
    }
    lastResult = await params.send({
      text: index === 0 ? params.text : "",
      mediaUrl,
      index,
      isFirst: index === 0
    });
  }
  return lastResult ?? params.fallbackResult;
}
async function normalizeOpenzaloReplyPayloadsForDelivery(params) {
  params.trace?.("normalize.input", summarizeOpenzaloReplyPayload(params.payload));
  const parsedPayload = parseOpenzaloMediaDirectives(params.payload);
  params.trace?.("normalize.afterOpenzaloParser", summarizeOpenzaloReplyPayload(parsedPayload));
  const outboundRuntime = await loadOpenClawOutboundRuntime();
  if (outboundRuntime) {
    const planned = outboundRuntime.projectOutboundPayloadPlanForDelivery(
      outboundRuntime.createOutboundPayloadPlan([parsedPayload], {
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        surface: CHANNEL_ID
      })
    );
    const reparsed = planned.map((payload) => parseOpenzaloMediaDirectives(payload));
    params.trace?.("normalize.afterOutboundRuntime", {
      payloadCount: reparsed.length,
      payloads: reparsed.map(summarizeOpenzaloReplyPayload)
    });
    return reparsed;
  }
  params.trace?.("normalize.outboundRuntimeMissing", {
    payloadCount: 1
  });
  return [parsedPayload];
}
function resolveOpenzaloDisableBlockStreaming(config) {
  return config.blockStreaming === true ? false : true;
}
function nextOpenzaloOutboundSequence(map, key) {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}
function resolveAgentIdFromSessionKey(sessionKey) {
  return sessionKey.trim().match(/^agent:([^:]+):/i)?.[1]?.trim() || null;
}
function resolveOpenzaloPendingGroupHistoryLimit(params) {
  const configuredLimit = typeof params.accountHistoryLimit === "number" ? params.accountHistoryLimit : typeof params.globalHistoryLimit === "number" ? params.globalHistoryLimit : DEFAULT_OPENZALO_PENDING_GROUP_HISTORY_LIMIT;
  return Math.max(0, Math.floor(configuredLimit));
}
function buildOpenzaloGroupSenderLabel(message) {
  if (message.senderName) {
    return `${message.senderName} (${message.senderId})`;
  }
  return message.senderId;
}
function buildOpenzaloPendingGroupHistoryEntry(params) {
  return {
    sender: buildOpenzaloGroupSenderLabel(params.message),
    body: params.rawBody || "[media attached]",
    timestamp: params.message.timestamp,
    messageId: params.message.messageId,
    mediaPaths: params.message.mediaPaths.slice(),
    mediaUrls: params.message.mediaUrls.slice(),
    mediaTypes: params.message.mediaTypes.slice()
  };
}
function buildOpenzaloCommandAuthorizers(params) {
  if (params.message.isGroup) {
    const resolved = resolveOpenzaloGroupCommandAuthorizers({
      senderId: params.message.senderId,
      ownerAllowFrom: params.ownerAllowFrom,
      groupConfig: params.groupConfig,
      wildcardConfig: params.wildcardConfig
    });
    return [resolved.owner, resolved.group];
  }
  return [
    {
      configured: params.ownerAllowFrom.length > 0,
      allowed: params.senderAllowedDm
    }
  ];
}
function buildOutboundMessageEventText(params) {
  const refs = [
    `[message_id:${params.shortId}]`,
    params.msgId ? `[msg_id:${params.msgId}]` : "",
    params.cliMsgId ? `[cli_msg_id:${params.cliMsgId}]` : ""
  ].filter(Boolean).join(" ");
  const preview = (params.preview ?? "").replace(/\s+/g, " ").trim();
  if (!preview) {
    return `Assistant sent ${refs}`;
  }
  const clipped = preview.length > 80 ? `${preview.slice(0, 80)}...` : preview;
  return `Assistant sent "${clipped}" ${refs}`;
}
function logOpenzaloGroupAllowlistHint(params) {
  const log = params.runtime.log;
  log?.(
    `[openzalo] group message blocked (${params.reason}) for ${params.threadId}. Allow this group with channels.openzalo.groups.${params.threadId} or channels.openzalo.groupAllowFrom=["${params.threadId}"].`
  );
  log?.(
    `[openzalo] account override path: channels.openzalo.accounts.${params.accountId}.groups.${params.threadId} or channels.openzalo.accounts.${params.accountId}.groupAllowFrom=["${params.threadId}"].`
  );
}
function logOpenzaloGroupSenderAllowHint(params) {
  const log = params.runtime.log;
  log?.(
    `[openzalo] sender ${params.senderId} blocked in group ${params.threadId}. Allow sender with channels.openzalo.groups.${params.threadId}.allowFrom=["${params.senderId}"].`
  );
  log?.(
    `[openzalo] account override path: channels.openzalo.accounts.${params.accountId}.groups.${params.threadId}.allowFrom=["${params.senderId}"].`
  );
}
function logOpenzaloCommandAllowHint(params) {
  const log = params.runtime.log;
  log?.(
    `[openzalo] control command blocked in group ${params.threadId} from ${params.senderId}. Authorize command senders via channels.openzalo.allowFrom or channels.openzalo.groups.${params.threadId}.allowFrom.`
  );
  log?.(
    `[openzalo] account override path: channels.openzalo.accounts.${params.accountId}.allowFrom or channels.openzalo.accounts.${params.accountId}.groups.${params.threadId}.allowFrom.`
  );
}
async function deliverOpenzaloReply(params) {
  const { target, sessionKey, account, cfg, runtime: runtime2, statusSink } = params;
  const receipts = [];
  const trace = createOpenzaloReplyTraceLogger({
    runtime: runtime2,
    accountId: account.accountId,
    target,
    sessionKey
  });
  const normalizedPayloads = await normalizeOpenzaloReplyPayloadsForDelivery({
    payload: params.payload,
    cfg,
    sessionKey,
    trace
  });
  const payloads = [];
  for (const payload of normalizedPayloads) {
    payloads.push(
      await recoverOpenzaloMediaPayloadFromSession({
        storePath: params.storePath,
        sessionKey,
        payload,
        trace
      }) ?? payload
    );
  }
  trace?.("delivery.normalized", {
    payloadCount: payloads.length,
    payloads: payloads.map(summarizeOpenzaloReplyPayload)
  });
  for (const payload of payloads) {
    const mediaList = await resolveOpenzaloPayloadMediaUrls(payload);
    const text = payload.text?.trim() ?? "";
    if (!text && mediaList.length === 0) {
      trace?.("delivery.skipEmpty", summarizeOpenzaloReplyPayload(payload));
      continue;
    }
    if (mediaList.length > 0) {
      const deliveryMediaLocalRoots = await resolveOpenzaloReplyMediaLocalRoots({
        cfg,
        account,
        agentId: params.agentId ?? resolveAgentIdFromSessionKey(sessionKey)
      });
      trace?.("delivery.sendMedia", {
        mediaCount: mediaList.length,
        hasCaption: Boolean(text),
        mediaRefs: mediaList.slice(0, 5).map((entry) => clipOpenzaloTraceValue(entry, 320)),
        mediaLocalRootCount: deliveryMediaLocalRoots?.length ?? 0
      });
      await sendOpenzaloPayloadMediaSequenceOrFallback({
        text,
        mediaUrls: mediaList,
        fallbackResult: { messageId: "empty", kind: "media" },
        send: async ({ text: captionText, mediaUrl }) => {
          const caption = captionText.trim() || void 0;
          const dedupe = acquireOpenzaloOutboundDedupeSlot({
            accountId: account.accountId,
            sessionKey,
            target,
            kind: "media",
            text: caption,
            mediaRef: mediaUrl
          });
          if (!dedupe.acquired) {
            runtime2.log?.(
              `[${account.accountId}] openzalo skip duplicate media send (${dedupe.reason}) target=${target}`
            );
            return { messageId: "duplicate", kind: "media" };
          }
          let sent = false;
          try {
            const result = await sendMediaOpenzalo({
              cfg,
              account,
              to: target,
              mediaUrl,
              text: caption,
              mediaLocalRoots: deliveryMediaLocalRoots
            });
            receipts.push(...result.receipts.length > 0 ? result.receipts : [result]);
            sent = true;
            statusSink?.({ lastOutboundAt: Date.now() });
            return result;
          } finally {
            releaseOpenzaloOutboundDedupeSlot({
              ticket: dedupe.ticket,
              sent
            });
          }
        }
      });
      continue;
    }
    if (text) {
      trace?.("delivery.sendText", {
        textLength: text.length,
        textPreview: clipOpenzaloTraceValue(text)
      });
      const limit = account.config.textChunkLimit && account.config.textChunkLimit > 0 ? account.config.textChunkLimit : 1800;
      const chunkMode = account.config.chunkMode ?? "length";
      const core = getOpenzaloRuntime();
      const chunks = chunkMode === "newline" ? core.channel.text.chunkTextWithMode(text, limit, chunkMode) : core.channel.text.chunkMarkdownText(text, limit);
      const finalChunks = chunks.length > 0 ? chunks : [text];
      const textSequenceByChunk = /* @__PURE__ */ new Map();
      for (const chunk of finalChunks) {
        const sequence = nextOpenzaloOutboundSequence(textSequenceByChunk, chunk);
        const dedupe = acquireOpenzaloOutboundDedupeSlot({
          accountId: account.accountId,
          sessionKey,
          target,
          kind: "text",
          text: chunk,
          sequence
        });
        if (!dedupe.acquired) {
          runtime2.log?.(
            `[${account.accountId}] openzalo skip duplicate text send (${dedupe.reason}) target=${target}`
          );
          continue;
        }
        let sent = false;
        try {
          const receipt = await sendTextOpenzalo({
            cfg,
            account,
            to: target,
            text: chunk
          });
          receipts.push(receipt);
          sent = true;
          statusSink?.({ lastOutboundAt: Date.now() });
        } finally {
          releaseOpenzaloOutboundDedupeSlot({
            ticket: dedupe.ticket,
            sent
          });
        }
      }
    }
  }
  return receipts;
}
async function deliverAndRememberOpenzaloReply(params) {
  const receipts = await deliverOpenzaloReply(params);
  if (receipts.length === 0) {
    return;
  }
  const core = getOpenzaloRuntime();
  const outboundParsedTarget = parseOpenzaloTarget(params.target);
  for (const receipt of receipts) {
    const remembered = rememberOpenzaloMessage({
      accountId: params.account.accountId,
      threadId: outboundParsedTarget.threadId,
      isGroup: outboundParsedTarget.isGroup,
      msgId: receipt.msgId,
      cliMsgId: receipt.cliMsgId,
      timestamp: Date.now(),
      preview: receipt.textPreview
    });
    if (!remembered?.shortId) {
      continue;
    }
    core.system.enqueueSystemEvent(
      buildOutboundMessageEventText({
        shortId: remembered.shortId,
        preview: remembered.preview,
        msgId: remembered.msgId,
        cliMsgId: remembered.cliMsgId
      }),
      {
        sessionKey: params.sessionKey,
        contextKey: `openzalo:outbound:${params.target}:${remembered.msgId || remembered.cliMsgId || remembered.shortId}`
      }
    );
  }
}
async function handleOpenzaloInbound(params) {
  const { message, account, cfg, runtime: runtime2, botUserId, statusSink } = params;
  const core = getOpenzaloRuntime();
  const directPeerId = message.isGroup ? "" : resolveOpenzaloDirectPeerId({
    dmPeerId: message.dmPeerId,
    senderId: message.senderId,
    toId: message.toId,
    threadId: message.threadId
  }) || message.senderId;
  const targetThreadId = message.isGroup ? message.threadId : directPeerId;
  const outboundTarget = formatOpenzaloOutboundTarget({
    threadId: targetThreadId,
    isGroup: message.isGroup
  });
  const rawBody = message.text.trim();
  const hasMedia = message.mediaUrls.length > 0 || message.mediaPaths.length > 0;
  if (!rawBody && !hasMedia) {
    return;
  }
  const dmPolicy2 = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const groupHistoryLimit = message.isGroup ? resolveOpenzaloPendingGroupHistoryLimit({
    accountHistoryLimit: account.config.historyLimit,
    globalHistoryLimit: cfg.messages?.groupChat?.historyLimit
  }) : 0;
  const groupHistoryKey = message.isGroup && groupHistoryLimit > 0 ? buildOpenzaloPendingGroupHistoryKey({
    accountId: account.accountId,
    threadId: message.threadId
  }) : "";
  const configAllowFrom = normalizeAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeAllowlist(account.config.groupAllowFrom);
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId
  });
  const storeAllowFrom = await pairing.readAllowFromStore().catch(() => []);
  const storeAllowlist = normalizeAllowlist(storeAllowFrom);
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowlist].filter(Boolean);
  const effectiveGroupAllowFrom = [...configGroupAllowFrom, ...storeAllowlist].filter(Boolean);
  const groupMatch = resolveOpenzaloGroupMatch({
    groups: account.config.groups,
    target: message.threadId
  });
  const senderAllowedDm = allowlistHasEntry(effectiveAllowFrom, message.senderId);
  if (message.isGroup) {
    const groupGate = resolveOpenzaloGroupAccessGate({
      groupPolicy,
      groupAllowFrom: effectiveGroupAllowFrom,
      groupMatch,
      target: message.threadId
    });
    if (!groupGate.allowed) {
      runtime2.log?.(`openzalo: drop group ${message.threadId} (${groupGate.reason})`);
      logOpenzaloGroupAllowlistHint({
        runtime: runtime2,
        reason: groupGate.reason,
        threadId: message.threadId,
        accountId: account.accountId
      });
      return;
    }
    const senderAllowed = resolveOpenzaloGroupSenderAllowed({
      groupPolicy,
      senderId: message.senderId,
      groupConfig: groupMatch.groupConfig,
      wildcardConfig: groupMatch.wildcardConfig
    });
    if (!senderAllowed) {
      runtime2.log?.(`openzalo: drop group sender ${message.senderId} (not allowlisted)`);
      logOpenzaloGroupSenderAllowHint({
        runtime: runtime2,
        threadId: message.threadId,
        senderId: message.senderId,
        accountId: account.accountId
      });
      return;
    }
  } else {
    if (dmPolicy2 === "disabled") {
      runtime2.log?.(`openzalo: drop DM sender=${message.senderId} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy2 !== "open" && !senderAllowedDm) {
      if (dmPolicy2 === "pairing") {
        const { code, created } = await pairing.upsertPairingRequest({
          meta: { name: message.senderName },
          id: message.senderId
        });
        if (created) {
          try {
            const pairingReply = core.channel.pairing.buildPairingReply({
              channel: CHANNEL_ID,
              idLine: `Your OpenZalo sender id: ${message.senderId}`,
              code
            });
            await sendTextOpenzalo({
              cfg,
              account,
              to: message.senderId,
              text: pairingReply
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            runtime2.error?.(`openzalo pairing reply failed for ${message.senderId}: ${String(err)}`);
          }
        }
      }
      return;
    }
  }
  const stateDir = resolveOpenzaloStateDir(process.env);
  const boundAcpBinding = await resolveOpenzaloAcpBinding({
    stateDir,
    accountId: account.accountId,
    conversationId: outboundTarget
  });
  const defaultRoute = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: targetThreadId
    }
  });
  const boundSession = resolveOpenzaloBoundSessionByTarget({
    accountId: account.accountId,
    to: outboundTarget
  });
  const boundAgentId = boundSession ? resolveAgentIdFromSessionKey(boundSession.childSessionKey) ?? boundSession.agentId : null;
  const route = boundSession && boundAgentId ? {
    ...defaultRoute,
    agentId: boundAgentId,
    sessionKey: boundSession.childSessionKey,
    mainSessionKey: `agent:${boundAgentId}:main`
  } : defaultRoute;
  const mentionAgentId = boundAcpBinding?.agent || route.agentId;
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(
    cfg,
    mentionAgentId
  );
  const commandBody = message.isGroup ? resolveOpenzaloCommandBody({
    rawBody,
    mentionRegexes,
    mentions: message.mentions,
    botUserId
  }) : rawBody;
  const commandTargetsDifferentBot = message.isGroup ? doesOpenzaloCommandTargetDifferentBot({
    commandBody,
    mentionRegexes,
    mentions: message.mentions,
    botUserId
  }) : false;
  const localAcpCommand = parseOpenzaloAcpCommand(commandBody);
  if (message.isGroup && commandTargetsDifferentBot) {
    runtime2.log?.(`openzalo: drop group ${message.threadId} (command targets different bot)`);
    return;
  }
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: CHANNEL_ID
  });
  const hasControlCommand = core.channel.text.hasControlCommand(commandBody, cfg);
  const commandAuthorizers = buildOpenzaloCommandAuthorizers({
    message,
    ownerAllowFrom: effectiveAllowFrom,
    senderAllowedDm,
    groupConfig: groupMatch.groupConfig,
    wildcardConfig: groupMatch.wildcardConfig
  });
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: commandAuthorizers,
    allowTextCommands,
    hasControlCommand
  });
  if (message.isGroup && (commandGate.shouldBlock || localAcpCommand && !commandGate.commandAuthorized)) {
    logInboundDrop({
      log: (line) => runtime2.log?.(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: message.senderId
    });
    logOpenzaloCommandAllowHint({
      runtime: runtime2,
      threadId: message.threadId,
      senderId: message.senderId,
      accountId: account.accountId
    });
    return;
  }
  const wasMentionedByPattern = message.isGroup && mentionRegexes.length > 0 ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) : false;
  const normalizedBotUserId = botUserId ? normalizeOpenzaloAllowEntry(botUserId) : "";
  const mentionedIds = message.mentionIds.map((entry) => normalizeOpenzaloAllowEntry(entry));
  const wasMentionedById = message.isGroup && Boolean(normalizedBotUserId) ? mentionedIds.includes(normalizedBotUserId) : false;
  const wasMentioned = message.isGroup ? wasMentionedByPattern || wasMentionedById : true;
  const canDetectMention = mentionRegexes.length > 0 || Boolean(normalizedBotUserId);
  const requireMention = message.isGroup ? resolveOpenzaloRequireMention({
    groupConfig: groupMatch.groupConfig,
    wildcardConfig: groupMatch.wildcardConfig
  }) : false;
  if (message.isGroup && requireMention && !wasMentioned && !boundAcpBinding) {
    const bypassForCommand = (hasControlCommand && allowTextCommands || Boolean(localAcpCommand)) && commandGate.commandAuthorized && !commandTargetsDifferentBot;
    if (!bypassForCommand) {
      if (groupHistoryKey && groupHistoryLimit > 0) {
        const historyEntry = buildOpenzaloPendingGroupHistoryEntry({
          message,
          rawBody
        });
        const history = appendOpenzaloPendingGroupHistoryEntry({
          historyKey: groupHistoryKey,
          entry: historyEntry,
          limit: groupHistoryLimit
        });
        runtime2.log?.(
          `openzalo: stored pending group history thread=${message.threadId} entries=${history.length} textLen=${historyEntry.body.length} media=${historyEntry.mediaPaths.length + historyEntry.mediaUrls.length}`
        );
      }
      if (!canDetectMention) {
        runtime2.error?.(
          "openzalo: mention required but detection unavailable (missing mention regexes and bot user id); dropping group message"
        );
      } else {
        runtime2.log?.(`openzalo: drop group ${message.threadId} (missing mention)`);
      }
      return;
    }
  }
  const peerLabel = message.isGroup ? `group:${message.threadId}` : message.senderName ? `${message.senderName} id:${message.senderId}` : message.senderId;
  const shouldRouteToBoundAcp = Boolean(boundAcpBinding) && !hasControlCommand;
  const sessionKeyForContext = shouldRouteToBoundAcp ? boundAcpBinding.sessionKey : route.sessionKey;
  const sessionAgentId = shouldRouteToBoundAcp && boundAcpBinding ? boundAcpBinding.agent : route.agentId;
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: sessionAgentId
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: sessionKeyForContext
  });
  let body = core.channel.reply.formatAgentEnvelope({
    channel: "OpenZalo",
    from: peerLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody || "[media attached]"
  });
  const pendingGroupHistory = message.isGroup && groupHistoryKey ? readOpenzaloPendingGroupHistoryEntries({
    historyKey: groupHistoryKey
  }) : [];
  if (message.isGroup && pendingGroupHistory.length > 0) {
    body = buildOpenzaloPendingHistoryContext({
      entries: pendingGroupHistory,
      currentMessage: body,
      formatEntry: (entry) => core.channel.reply.formatAgentEnvelope({
        channel: "OpenZalo",
        from: peerLabel,
        timestamp: entry.timestamp,
        body: entry.body,
        chatType: "group",
        senderLabel: entry.sender,
        envelope: envelopeOptions
      })
    });
    runtime2.log?.(
      `openzalo: injecting pending group history thread=${message.threadId} entries=${pendingGroupHistory.length}`
    );
  }
  const mergedMediaPaths = dedupeStrings([
    ...pendingGroupHistory.flatMap((entry) => entry.mediaPaths),
    ...message.mediaPaths
  ]);
  const mergedMediaUrls = dedupeStrings([
    ...pendingGroupHistory.flatMap((entry) => entry.mediaUrls),
    ...message.mediaUrls
  ]);
  const mergedMediaTypes = dedupeStrings([
    ...pendingGroupHistory.flatMap((entry) => entry.mediaTypes),
    ...message.mediaTypes
  ]);
  const inboundHistory = message.isGroup && pendingGroupHistory.length > 0 ? pendingGroupHistory.map((entry) => ({
    sender: entry.sender,
    body: entry.body,
    timestamp: entry.timestamp
  })) : void 0;
  const rememberedInbound = rememberOpenzaloMessage({
    accountId: account.accountId,
    threadId: targetThreadId,
    isGroup: message.isGroup,
    msgId: message.msgId,
    cliMsgId: message.cliMsgId,
    timestamp: message.timestamp,
    preview: rawBody || void 0
  });
  let replyToId = formatOpenzaloMessageSidFull({
    msgId: message.quoteMsgId,
    cliMsgId: message.quoteCliMsgId
  });
  let replyToIdFull = replyToId;
  if (replyToId) {
    const resolvedReply = resolveOpenzaloMessageRef({
      accountId: account.accountId,
      rawId: replyToId
    });
    const rememberedReply = rememberOpenzaloMessage({
      accountId: account.accountId,
      threadId: targetThreadId,
      isGroup: message.isGroup,
      msgId: resolvedReply.msgId || message.quoteMsgId,
      cliMsgId: resolvedReply.cliMsgId || message.quoteCliMsgId,
      timestamp: message.timestamp - 1,
      preview: message.quoteText
    });
    if (rememberedReply?.shortId) {
      replyToId = rememberedReply.shortId;
      replyToIdFull = formatOpenzaloMessageSidFull({
        msgId: rememberedReply.msgId,
        cliMsgId: rememberedReply.cliMsgId,
        fallback: replyToIdFull
      });
    }
  }
  const messageSids = [message.msgId, message.cliMsgId].filter(
    (value) => typeof value === "string" && value.trim().length > 0
  );
  const messageSidFull = formatOpenzaloMessageSidFull({
    msgId: message.msgId,
    cliMsgId: message.cliMsgId,
    fallback: message.messageId
  });
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    BodyForCommands: commandBody,
    MediaUrl: mergedMediaUrls[0],
    MediaUrls: mergedMediaUrls.length > 0 ? mergedMediaUrls : void 0,
    MediaPath: mergedMediaPaths[0],
    MediaPaths: mergedMediaPaths.length > 0 ? mergedMediaPaths : void 0,
    MediaType: mergedMediaTypes[0],
    MediaTypes: mergedMediaTypes.length > 0 ? mergedMediaTypes : void 0,
    From: message.isGroup ? `openzalo:group:${message.threadId}` : `openzalo:${message.senderId}`,
    To: outboundTarget,
    SessionKey: sessionKeyForContext,
    AccountId: account.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: peerLabel,
    SenderName: message.senderName,
    SenderId: message.senderId,
    GroupSubject: message.isGroup ? message.threadId : void 0,
    GroupSystemPrompt: message.isGroup ? groupMatch.groupConfig?.systemPrompt?.trim() || DEFAULT_GROUP_SYSTEM_PROMPT : void 0,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.isGroup ? wasMentioned : void 0,
    MessageSid: rememberedInbound?.shortId || message.messageId,
    MessageSidFull: messageSidFull,
    MessageSids: messageSids.length > 0 ? messageSids : void 0,
    ReplyToId: replyToId || void 0,
    ReplyToIdFull: replyToIdFull || void 0,
    ReplyToSender: message.quoteSender,
    ReplyToBody: message.quoteText,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: outboundTarget,
    CommandAuthorized: message.isGroup ? commandGate.commandAuthorized : dmPolicy2 === "open" || senderAllowedDm
  });
  const acpCommandResult = await handleOpenzaloAcpCommand({
    commandBody,
    account,
    cfg,
    runtime: runtime2,
    conversationId: outboundTarget,
    hasSubagentBinding: Boolean(boundSession)
  });
  const activeSessionKey = acpCommandResult.handled ? acpCommandResult.binding?.sessionKey || boundAcpBinding?.sessionKey || route.sessionKey : ctxPayload.SessionKey ?? route.sessionKey;
  ctxPayload.SessionKey = activeSessionKey;
  const onReplyStartTyping = account.config.sendTypingIndicators === false ? void 0 : async () => {
    try {
      await sendTypingOpenzalo({
        account,
        to: outboundTarget
      });
    } catch (err) {
      runtime2.error?.(`openzalo typing start failed: ${String(err)}`);
    }
  };
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: activeSessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime2.error?.(`openzalo: failed updating session meta: ${String(err)}`);
    }
  });
  if (acpCommandResult.handled) {
    await deliverAndRememberOpenzaloReply({
      payload: acpCommandResult.payload,
      target: outboundTarget,
      sessionKey: activeSessionKey,
      storePath,
      account,
      cfg,
      runtime: runtime2,
      statusSink
    });
    return;
  }
  if (shouldRouteToBoundAcp && boundAcpBinding) {
    await onReplyStartTyping?.();
    const acpPayload = await runOpenzaloAcpBoundTurn({
      cfg,
      runtime: runtime2,
      accountId: account.accountId,
      binding: boundAcpBinding,
      ctxPayload
    });
    await deliverAndRememberOpenzaloReply({
      payload: acpPayload,
      target: outboundTarget,
      sessionKey: boundAcpBinding.sessionKey,
      storePath,
      account,
      cfg,
      runtime: runtime2,
      statusSink
    });
    if (groupHistoryKey && pendingGroupHistory.length > 0) {
      clearOpenzaloPendingGroupHistory(groupHistoryKey);
      runtime2.log?.(
        `openzalo: cleared pending group history thread=${message.threadId} consumed=${pendingGroupHistory.length} queuedFinal=1`
      );
    }
    return;
  }
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    transformReplyPayload: parseOpenzaloMediaDirectives
  });
  const dispatchResult = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...replyPipeline,
      onReplyStart: onReplyStartTyping,
      deliver: async (payload) => {
        await deliverAndRememberOpenzaloReply({
          payload,
          target: outboundTarget,
          sessionKey: route.sessionKey,
          storePath,
          account,
          cfg,
          agentId: route.agentId,
          runtime: runtime2,
          statusSink
        });
      },
      onError: (err, info) => {
        runtime2.error?.(`openzalo ${info.kind} reply failed: ${String(err)}`);
      }
    },
    replyOptions: {
      skillFilter: message.isGroup ? groupMatch.groupConfig?.skills : void 0,
      onModelSelected,
      disableBlockStreaming: resolveOpenzaloDisableBlockStreaming(account.config)
    }
  });
  if (groupHistoryKey && pendingGroupHistory.length > 0) {
    clearOpenzaloPendingGroupHistory(groupHistoryKey);
    runtime2.log?.(
      `openzalo: cleared pending group history thread=${message.threadId} consumed=${pendingGroupHistory.length} queuedFinal=${dispatchResult.queuedFinal}`
    );
  }
}

// src/listen-args.ts
var OPENZCA_LISTEN_ARGS = ["listen", "--raw", "--supervised"];

// src/monitor-normalize.ts
var toId = normalizeOpenzaloId;
function toStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}
function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  return void 0;
}
function toRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}
function normalizeMentionUid(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || void 0;
  }
  return void 0;
}
function parseOptionalInt(value) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return void 0;
  }
  return Math.trunc(numeric);
}
function looksLikeStructuredJsonString(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return false;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return first === "[" && last === "]" || first === "{" && last === "}";
}
function buildInboundMention(params) {
  const uid = normalizeMentionUid(
    params.value.uid ?? params.value.userId ?? params.value.user_id ?? params.value.id
  );
  if (!uid) {
    return null;
  }
  const pos = parseOptionalInt(
    params.value.pos ?? params.value.offset ?? params.value.start ?? params.value.index
  );
  const len = parseOptionalInt(params.value.len ?? params.value.length);
  const type = parseOptionalInt(params.value.type ?? params.value.kind);
  let text = (typeof params.value.text === "string" ? params.value.text.trim() : "") || (typeof params.value.label === "string" ? params.value.label.trim() : "") || (typeof params.value.name === "string" ? params.value.name.trim() : "") || (typeof pos === "number" && typeof len === "number" && len > 0 && pos >= 0 && pos < params.rawText.length ? params.rawText.slice(pos, Math.min(params.rawText.length, pos + len)).trim() : "");
  if (!text) {
    text = "";
  }
  return {
    uid,
    ...typeof pos === "number" ? { pos } : {},
    ...typeof len === "number" ? { len } : {},
    ...typeof type === "number" ? { type } : {},
    ...text ? { text } : {}
  };
}
function collectInboundMentions(params) {
  if (params.depth > 4 || params.value === void 0 || params.value === null) {
    return;
  }
  if (typeof params.value === "string") {
    if (!looksLikeStructuredJsonString(params.value)) {
      const scalarId2 = normalizeMentionUid(params.value);
      if (scalarId2) {
        params.sink.set(`${scalarId2}|||`, { uid: scalarId2 });
      }
      return;
    }
    try {
      const parsed = JSON.parse(params.value);
      collectInboundMentions({
        value: parsed,
        sink: params.sink,
        rawText: params.rawText,
        depth: params.depth + 1
      });
    } catch {
    }
    return;
  }
  const scalarId = normalizeMentionUid(params.value);
  if (scalarId) {
    params.sink.set(`${scalarId}|||`, { uid: scalarId });
    return;
  }
  if (Array.isArray(params.value)) {
    for (const item of params.value) {
      collectInboundMentions({
        value: item,
        sink: params.sink,
        rawText: params.rawText,
        depth: params.depth + 1
      });
    }
    return;
  }
  const record = toRecord(params.value);
  if (!record) {
    return;
  }
  const mention = buildInboundMention({
    value: record,
    rawText: params.rawText
  });
  if (mention) {
    const key = `${mention.uid}|${mention.pos ?? ""}|${mention.len ?? ""}|${mention.type ?? ""}`;
    params.sink.set(key, mention);
  }
  const nestedKeys = [
    "mentionIds",
    "mentions",
    "mentionInfo",
    "mention_info",
    "mentionList",
    "mention_list",
    "mention"
  ];
  for (const key of nestedKeys) {
    if (!(key in record)) {
      continue;
    }
    collectInboundMentions({
      value: record[key],
      sink: params.sink,
      rawText: params.rawText,
      depth: params.depth + 1
    });
  }
}
function extractInboundMentions(params) {
  const sink = /* @__PURE__ */ new Map();
  const candidates = [
    params.payload.mentionIds,
    params.payload.mentions,
    params.payload.mentionInfo,
    params.payload.mention_info,
    params.payload.mentionList,
    params.payload.mention_list,
    params.payload.mention,
    params.metadata?.mentionIds,
    params.metadata?.mentions,
    params.metadata?.mentionInfo,
    params.metadata?.mention_info,
    params.metadata?.mentionList,
    params.metadata?.mention_list,
    params.metadata?.mention
  ];
  for (const candidate of candidates) {
    collectInboundMentions({
      value: candidate,
      sink,
      rawText: params.rawText,
      depth: 0
    });
  }
  return Array.from(sink.values());
}
function extractMentionIds(mentions) {
  const sink = /* @__PURE__ */ new Set();
  for (const mention of mentions) {
    if (mention.uid) {
      sink.add(mention.uid);
    }
  }
  return Array.from(sink);
}
function toEpochMs(value) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Date.now();
  }
  if (numeric < 1e10) {
    return Math.floor(numeric * 1e3);
  }
  return Math.floor(numeric);
}
function resolveDmPeerId(params) {
  const threadId = params.threadId.trim();
  const senderId = params.senderId.trim();
  const toId2 = (params.toId ?? "").trim();
  const selfId = (params.selfId ?? "").trim();
  if (selfId) {
    if (senderId === selfId && toId2 && toId2 !== selfId) {
      return toId2;
    }
    if (toId2 === selfId && senderId && senderId !== selfId) {
      return senderId;
    }
    if (threadId && threadId !== selfId) {
      return threadId;
    }
    if (toId2 && toId2 !== selfId) {
      return toId2;
    }
    if (senderId && senderId !== selfId) {
      return senderId;
    }
  }
  if (senderId && toId2 && senderId === threadId && toId2 !== senderId) {
    return toId2;
  }
  if (senderId && toId2 && toId2 === threadId && senderId !== toId2) {
    return senderId;
  }
  if (threadId) {
    return threadId;
  }
  if (toId2 && toId2 !== senderId) {
    return toId2;
  }
  return senderId;
}
function summarizeQuoteText(quote) {
  const directText = (typeof quote.msg === "string" ? quote.msg.trim() : "") || (typeof quote.text === "string" ? quote.text.trim() : "") || (typeof quote.content === "string" ? quote.content.trim() : "");
  if (directText) {
    return directText;
  }
  const attach = toRecord(quote.attach);
  if (!attach) {
    return void 0;
  }
  const title = (typeof attach.title === "string" ? attach.title.trim() : "") || (typeof attach.description === "string" ? attach.description.trim() : "");
  if (title) {
    return title;
  }
  const href = typeof attach.href === "string" ? attach.href.trim() : "";
  return href || void 0;
}
function extractQuoteContext(params) {
  const quote = toRecord(params.payload.quote) ?? toRecord(params.metadata?.quote);
  if (!quote) {
    return {};
  }
  const quoteMsgId = toId(quote.globalMsgId) || toId(quote.msgId) || toId(quote.realMsgId);
  const quoteCliMsgId = toId(quote.cliMsgId);
  const quoteSender = (typeof quote.senderName === "string" ? quote.senderName.trim() : "") || (typeof quote.ownerId === "string" ? quote.ownerId.trim() : "") || (typeof quote.fromId === "string" ? quote.fromId.trim() : "") || void 0;
  const quoteText = summarizeQuoteText(quote);
  return {
    quoteMsgId: quoteMsgId || void 0,
    quoteCliMsgId: quoteCliMsgId || void 0,
    quoteSender,
    quoteText
  };
}
function isSelfMessage(params) {
  if (toBoolean(params.payload.fromMe) === true || toBoolean(params.payload.isFromMe) === true || toBoolean(params.metadata?.fromMe) === true || toBoolean(params.metadata?.isFromMe) === true) {
    return true;
  }
  if (params.senderId === "0") {
    return true;
  }
  const normalizedSelfId = (params.selfId ?? "").trim();
  return Boolean(normalizedSelfId) && params.senderId === normalizedSelfId;
}
function normalizeOpenzcaInboundPayload(payload, selfId) {
  if (payload.kind === "lifecycle") {
    return null;
  }
  const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : null;
  const threadId = toId(payload.threadId) || toId(payload.targetId) || toId(payload.conversationId) || toId(metadata?.threadId) || toId(metadata?.targetId);
  const senderId = toId(payload.senderId) || toId(metadata?.senderId) || toId(metadata?.fromId);
  if (!threadId || !senderId) {
    return null;
  }
  if (isSelfMessage({ payload, metadata, senderId, selfId })) {
    return null;
  }
  const toIdValue = toId(payload.toId) || toId(metadata?.toId);
  let chatType = "";
  if (typeof payload.chatType === "string") {
    chatType = payload.chatType;
  } else if (typeof metadata?.chatType === "string") {
    chatType = metadata.chatType;
  }
  const metadataIsGroup = toBoolean(metadata?.isGroup);
  const isGroup = metadataIsGroup !== void 0 ? metadataIsGroup : chatType.toLowerCase() === "group";
  const mediaPaths = [
    ...toStringArray(payload.mediaPaths),
    ...typeof payload.mediaPath === "string" ? [payload.mediaPath.trim()] : []
  ].filter(Boolean);
  const mediaUrls = [
    ...toStringArray(payload.mediaUrls),
    ...typeof payload.mediaUrl === "string" ? [payload.mediaUrl.trim()] : []
  ].filter(Boolean);
  const mediaTypes = [
    ...toStringArray(payload.mediaTypes),
    ...typeof payload.mediaType === "string" ? [payload.mediaType.trim()] : []
  ].filter(Boolean);
  const text = typeof payload.content === "string" ? payload.content : "";
  const msgId = toId(payload.msgId) || toId(metadata?.msgId);
  const cliMsgId = toId(payload.cliMsgId) || toId(metadata?.cliMsgId);
  const messageId = msgId || cliMsgId || `${Date.now()}:${threadId}`;
  const dmPeerId = isGroup ? void 0 : resolveDmPeerId({
    threadId,
    senderId,
    toId: toIdValue,
    selfId
  });
  const quote = extractQuoteContext({ payload, metadata });
  const mentions = extractInboundMentions({
    payload,
    metadata,
    rawText: text
  });
  const mentionIds = extractMentionIds(mentions);
  return {
    messageId,
    msgId: msgId || void 0,
    cliMsgId: cliMsgId || void 0,
    threadId,
    toId: toIdValue || void 0,
    dmPeerId: dmPeerId || void 0,
    senderId,
    senderName: (typeof payload.senderName === "string" ? payload.senderName.trim() : "") || (typeof payload.senderDisplayName === "string" ? payload.senderDisplayName.trim() : "") || (typeof metadata?.senderName === "string" ? metadata.senderName.trim() : "") || void 0,
    text,
    timestamp: toEpochMs(payload.timestamp ?? payload.ts ?? metadata?.timestamp),
    isGroup,
    quoteMsgId: quote.quoteMsgId,
    quoteCliMsgId: quote.quoteCliMsgId,
    quoteSender: quote.quoteSender,
    quoteText: quote.quoteText,
    mentions,
    mentionIds,
    mediaPaths,
    mediaUrls,
    mediaTypes,
    raw: payload
  };
}

// src/monitor.ts
var DEFAULT_INBOUND_DEBOUNCE_MS = 1200;
var OPENZALO_READY_TIMEOUT_MS = 3e4;
var OPENZALO_READY_POLL_MS = 500;
var OPENZALO_READY_LOG_AFTER_MS = 1e4;
var OPENZALO_READY_LOG_INTERVAL_MS = 1e4;
var OPENZALO_RECONNECT_INITIAL_MS = 1e3;
var OPENZALO_RECONNECT_MAX_MS = 6e4;
var OPENZALO_RECONNECT_FACTOR = 2;
var OPENZALO_RECONNECT_JITTER = 0.2;
var OPENZALO_RECONNECT_STABLE_RESET_MS = 9e4;
var OPENZALO_WATCHDOG_IDLE_MS = 5 * 6e4;
var OPENZALO_WATCHDOG_POLL_MS = 3e4;
function toErrorText3(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}
function computeReconnectDelayMs(attempt) {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const base = Math.min(
    OPENZALO_RECONNECT_MAX_MS,
    OPENZALO_RECONNECT_INITIAL_MS * OPENZALO_RECONNECT_FACTOR ** (normalizedAttempt - 1)
  );
  const jitterWindow = base * OPENZALO_RECONNECT_JITTER;
  const jitter = (Math.random() * 2 - 1) * jitterWindow;
  return Math.max(0, Math.round(base + jitter));
}
function nextReconnectAttempt(currentAttempt, attemptDurationMs) {
  return attemptDurationMs >= OPENZALO_RECONNECT_STABLE_RESET_MS ? 1 : currentAttempt + 1;
}
function attachAbort(parent, child) {
  if (parent.aborted) {
    child.abort();
    return () => {
    };
  }
  const onAbort = () => {
    child.abort();
  };
  parent.addEventListener("abort", onAbort, { once: true });
  return () => {
    parent.removeEventListener("abort", onAbort);
  };
}
function startIdleWatchdog(params) {
  const timer = setInterval(() => {
    const idleForMs = Date.now() - params.getLastActivityAt();
    if (idleForMs < OPENZALO_WATCHDOG_IDLE_MS) {
      return;
    }
    params.runtime.error?.(
      `[${params.accountId}] openzca idle for ${idleForMs}ms; forcing reconnect`
    );
    params.onIdle();
  }, OPENZALO_WATCHDOG_POLL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}
async function sleepWithAbort(ms, signal) {
  if (ms <= 0) {
    return;
  }
  if (signal.aborted) {
    throw new Error("aborted");
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function noteOpenzaloStreamActivity(params) {
  const at = params.at ?? Date.now();
  recordOpenzaloStreamActivity(params.accountId, at);
  params.statusSink?.({ lastEventAt: at });
}
function noteOpenzaloConnected(params) {
  const at = params.at ?? Date.now();
  markOpenzaloConnected({
    accountId: params.accountId,
    at
  });
  params.statusSink?.({
    connected: true,
    reconnectAttempts: 0,
    lastConnectedAt: at,
    lastEventAt: at,
    lastError: null
  });
}
function noteOpenzaloDisconnected(params) {
  markOpenzaloDisconnected({
    accountId: params.accountId,
    reason: params.reason,
    reconnectAttempts: params.reconnectAttempts
  });
  params.statusSink?.({
    connected: false,
    reconnectAttempts: params.reconnectAttempts,
    ...params.reason !== void 0 ? { lastError: params.reason } : {}
  });
}
async function waitForOpenzcaReady(options) {
  const { account, runtime: runtime2, abortSignal } = options;
  const startedAt = Date.now();
  const deadlineAt = startedAt + OPENZALO_READY_TIMEOUT_MS;
  let nextLogAt = startedAt + OPENZALO_READY_LOG_AFTER_MS;
  let lastError = "unknown error";
  while (!abortSignal.aborted) {
    try {
      await runOpenzcaCommand({
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["auth", "status"],
        timeoutMs: 8e3,
        signal: abortSignal
      });
      return true;
    } catch (error) {
      if (abortSignal.aborted) {
        return false;
      }
      lastError = toErrorText3(error);
    }
    const now = Date.now();
    if (now >= deadlineAt) {
      break;
    }
    if (now >= nextLogAt) {
      runtime2.error?.(
        `[${account.accountId}] openzca not ready after ${now - startedAt}ms (${lastError})`
      );
      nextLogAt = now + OPENZALO_READY_LOG_INTERVAL_MS;
    }
    try {
      await sleepWithAbort(OPENZALO_READY_POLL_MS, abortSignal);
    } catch {
      return false;
    }
  }
  if (abortSignal.aborted) {
    return false;
  }
  throw new Error(`openzca not ready after ${OPENZALO_READY_TIMEOUT_MS}ms (${lastError})`);
}
function resolveCombinedText(texts) {
  if (texts.length === 0) {
    return "";
  }
  if (texts.length === 1) {
    return texts[0] ?? "";
  }
  const last = texts[texts.length - 1] ?? "";
  if (/^([/!]|@\S)/.test(last.trim())) {
    return last;
  }
  return texts.join("\n");
}
function combineDebouncedInbound(entries) {
  if (entries.length === 0) {
    throw new Error("Cannot combine empty OpenZalo debounce entries");
  }
  if (entries.length === 1) {
    return entries[0].message;
  }
  const first = entries[0].message;
  const messages = entries.map((entry) => entry.message);
  const text = resolveCombinedText(
    dedupeStrings(messages.map((msg) => msg.text))
  );
  const mediaPaths = dedupeStrings(messages.flatMap((msg) => msg.mediaPaths));
  const mediaUrls = dedupeStrings(messages.flatMap((msg) => msg.mediaUrls));
  const mediaTypes = dedupeStrings(messages.flatMap((msg) => msg.mediaTypes));
  const mentionIds = dedupeStrings(messages.flatMap((msg) => msg.mentionIds));
  const maxTimestamp = Math.max(
    ...messages.map((msg) => msg.timestamp).filter((value) => Number.isFinite(value))
  );
  const latest = messages[messages.length - 1] ?? first;
  const preferredMsgId = messages.find((msg) => Boolean(msg.msgId))?.msgId;
  const preferredCliMsgId = messages.find((msg) => Boolean(msg.cliMsgId))?.cliMsgId;
  const messageId = preferredMsgId || preferredCliMsgId || first.messageId;
  const quoteMsgId = messages.find((msg) => Boolean(msg.quoteMsgId))?.quoteMsgId;
  const quoteCliMsgId = messages.find((msg) => Boolean(msg.quoteCliMsgId))?.quoteCliMsgId;
  const quoteSender = messages.find((msg) => Boolean(msg.quoteSender))?.quoteSender;
  const quoteText = messages.find((msg) => Boolean(msg.quoteText))?.quoteText;
  return {
    ...first,
    messageId,
    msgId: preferredMsgId || void 0,
    cliMsgId: preferredCliMsgId || void 0,
    text,
    timestamp: Number.isFinite(maxTimestamp) ? maxTimestamp : first.timestamp,
    quoteMsgId: quoteMsgId || void 0,
    quoteCliMsgId: quoteCliMsgId || void 0,
    quoteSender: quoteSender || void 0,
    quoteText: quoteText || void 0,
    mentionIds,
    mediaPaths,
    mediaUrls,
    mediaTypes,
    // Preserve the latest raw payload for troubleshooting while keeping first IDs/route info.
    raw: latest.raw
  };
}
function resolveOpenzaloDebounceMs(cfg) {
  const inbound = cfg.messages?.inbound;
  const hasExplicitDebounce = typeof inbound?.debounceMs === "number" || typeof inbound?.byChannel?.openzalo === "number";
  if (!hasExplicitDebounce) {
    return DEFAULT_INBOUND_DEBOUNCE_MS;
  }
  const core = getOpenzaloRuntime();
  return core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "openzalo"
  });
}
function buildOpenzaloDebounceKey(params) {
  const chatType = params.message.isGroup ? "group" : "direct";
  return [
    "openzalo",
    params.accountId,
    chatType,
    params.message.threadId.trim(),
    params.message.senderId.trim()
  ].join(":");
}
async function monitorOpenzaloProvider(options) {
  const { account, cfg, runtime: runtime2, abortSignal, statusSink } = options;
  const core = getOpenzaloRuntime();
  clearOpenzaloRuntimeHealthState(account.accountId);
  statusSink?.({
    connected: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastEventAt: null,
    lastError: null
  });
  runtime2.log?.(
    `[${account.accountId}] starting openzca listener (profile=${account.profile}, binary=${account.zcaBinary})`
  );
  let selfId;
  const inboundDebouncer = core.channel.debounce.createInboundDebouncer({
    debounceMs: resolveOpenzaloDebounceMs(cfg),
    buildKey: (entry) => buildOpenzaloDebounceKey({
      accountId: account.accountId,
      message: entry.message
    }),
    shouldDebounce: () => true,
    onFlush: async (entries) => {
      if (entries.length === 0) {
        return;
      }
      if (abortSignal.aborted) {
        return;
      }
      const message = entries.length === 1 ? entries[0].message : combineDebouncedInbound(entries);
      if (entries.length > 1 && core.logging.shouldLogVerbose()) {
        runtime2.log?.(
          `[${account.accountId}] openzalo coalesced ${entries.length} inbound events thread=${message.threadId} sender=${message.senderId} textLen=${message.text.length} media=${message.mediaPaths.length + message.mediaUrls.length}`
        );
      }
      core.channel.activity.record({
        channel: "openzalo",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp
      });
      statusSink?.({ lastInboundAt: message.timestamp });
      if (abortSignal.aborted) {
        return;
      }
      await handleOpenzaloInbound({
        message,
        account,
        cfg,
        runtime: runtime2,
        botUserId: selfId,
        statusSink
      });
    },
    onError: (error) => {
      runtime2.error?.(`[${account.accountId}] openzalo debounce flush failed: ${String(error)}`);
    }
  });
  let reconnectAttempt = 0;
  while (!abortSignal.aborted) {
    const attemptStartedAt = Date.now();
    let streamEndReason = null;
    try {
      const ready = await waitForOpenzcaReady({
        account,
        runtime: runtime2,
        abortSignal
      });
      if (!ready || abortSignal.aborted) {
        return;
      }
      if (!selfId) {
        try {
          const me = await runOpenzcaCommand({
            binary: account.zcaBinary,
            profile: account.profile,
            args: ["me", "id"],
            timeoutMs: 1e4,
            signal: abortSignal
          });
          const resolved = me.stdout.trim().split(/\s+/g)[0]?.trim();
          if (resolved) {
            selfId = resolved;
            runtime2.log?.(`[${account.accountId}] resolved self id ${selfId}`);
          }
        } catch (error) {
          runtime2.error?.(`[${account.accountId}] failed to resolve self id: ${String(error)}`);
        }
      }
      const streamAbort = new AbortController();
      const detachAbort = attachAbort(abortSignal, streamAbort);
      let lastActivityAt = Date.now();
      let streamConnected = false;
      const touchActivity = () => {
        lastActivityAt = Date.now();
      };
      const stopWatchdog = startIdleWatchdog({
        accountId: account.accountId,
        runtime: runtime2,
        getLastActivityAt: () => lastActivityAt,
        onIdle: () => {
          streamEndReason = "idle timeout";
          noteOpenzaloDisconnected({
            accountId: account.accountId,
            statusSink,
            reason: "openzca idle timeout",
            reconnectAttempts: reconnectAttempt + 1
          });
          streamAbort.abort();
        }
      });
      const detachReconnect = registerOpenzaloReconnectHandler(account.accountId, (reason2) => {
        streamEndReason = "reconnect requested";
        runtime2.error?.(`[${account.accountId}] openzca reconnect requested: ${reason2}`);
        streamAbort.abort();
      });
      try {
        await runOpenzcaStreaming({
          binary: account.zcaBinary,
          profile: account.profile,
          // Let OpenZalo own restart policy. Supervised mode gives us lifecycle
          // heartbeats so silence becomes a meaningful stuck-stream signal.
          args: [...OPENZCA_LISTEN_ARGS],
          signal: streamAbort.signal,
          onStdoutLine: (line) => {
            if (line.trim()) {
              touchActivity();
              noteOpenzaloStreamActivity({
                accountId: account.accountId,
                statusSink
              });
            }
          },
          onStderrLine: (line) => {
            if (!line.trim()) {
              return;
            }
            touchActivity();
            noteOpenzaloStreamActivity({
              accountId: account.accountId,
              statusSink
            });
            runtime2.error?.(`[${account.accountId}] openzca stderr: ${line}`);
          },
          onJsonLine: async (payload) => {
            touchActivity();
            noteOpenzaloStreamActivity({
              accountId: account.accountId,
              statusSink
            });
            if (!streamConnected) {
              streamConnected = true;
              noteOpenzaloConnected({
                accountId: account.accountId,
                statusSink
              });
            }
            const message = normalizeOpenzcaInboundPayload(payload, selfId);
            if (!message) {
              if (payload.kind === "lifecycle" && payload.event === "connected") {
                runtime2.log?.(`[${account.accountId}] openzca connected`);
              }
              return;
            }
            if (abortSignal.aborted || streamAbort.signal.aborted) {
              return;
            }
            await inboundDebouncer.enqueue({ message });
          }
        });
      } finally {
        detachReconnect();
        stopWatchdog();
        detachAbort();
      }
      if (abortSignal.aborted) {
        noteOpenzaloDisconnected({
          accountId: account.accountId,
          statusSink,
          reconnectAttempts: reconnectAttempt
        });
        return;
      }
      const attemptDurationMs = Date.now() - attemptStartedAt;
      reconnectAttempt = nextReconnectAttempt(reconnectAttempt, attemptDurationMs);
      const delayMs = computeReconnectDelayMs(reconnectAttempt);
      const reason = streamEndReason ?? "listener exited";
      noteOpenzaloDisconnected({
        accountId: account.accountId,
        statusSink,
        reason: reason === "reconnect requested" ? void 0 : `openzca ${reason}`,
        reconnectAttempts: reconnectAttempt
      });
      runtime2.error?.(
        `[${account.accountId}] openzca ${reason}; reconnecting in ${Math.round(delayMs / 1e3)}s`
      );
      await sleepWithAbort(delayMs, abortSignal);
    } catch (error) {
      if (abortSignal.aborted) {
        noteOpenzaloDisconnected({
          accountId: account.accountId,
          statusSink,
          reconnectAttempts: reconnectAttempt
        });
        return;
      }
      const attemptDurationMs = Date.now() - attemptStartedAt;
      reconnectAttempt = nextReconnectAttempt(reconnectAttempt, attemptDurationMs);
      const delayMs = computeReconnectDelayMs(reconnectAttempt);
      const errorText = toErrorText3(error);
      noteOpenzaloDisconnected({
        accountId: account.accountId,
        statusSink,
        reason: errorText,
        reconnectAttempts: reconnectAttempt
      });
      runtime2.error?.(
        `[${account.accountId}] openzca listener error: ${errorText}; reconnecting in ${Math.round(delayMs / 1e3)}s`
      );
      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch {
        return;
      }
    }
  }
}

// src/accounts.ts
function listConfiguredAccountIds(cfg) {
  const accounts = cfg.channels?.openzalo?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}
function listOpenzaloAccountIds(cfg) {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID2];
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}
function resolveDefaultOpenzaloAccountId(cfg) {
  const configuredDefault = cfg.channels?.openzalo?.defaultAccount?.trim();
  if (configuredDefault) {
    return configuredDefault;
  }
  const ids = listOpenzaloAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID2)) {
    return DEFAULT_ACCOUNT_ID2;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID2;
}
function resolveAccountConfig(cfg, accountId) {
  const accounts = cfg.channels?.openzalo?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return void 0;
  }
  return accounts[accountId];
}
function hasExplicitAccountConfig(config) {
  if (!config) {
    return false;
  }
  if (config.profile?.trim()) {
    return true;
  }
  if (config.zcaBinary?.trim()) {
    return true;
  }
  if (config.acpx && Object.keys(config.acpx).length > 0) {
    return true;
  }
  if (config.dmPolicy) {
    return true;
  }
  if (Array.isArray(config.allowFrom) && config.allowFrom.length > 0) {
    return true;
  }
  if (config.groupPolicy) {
    return true;
  }
  if (Array.isArray(config.groupAllowFrom) && config.groupAllowFrom.length > 0) {
    return true;
  }
  if (config.groups && Object.keys(config.groups).length > 0) {
    return true;
  }
  if (typeof config.historyLimit === "number") {
    return true;
  }
  if (typeof config.dmHistoryLimit === "number") {
    return true;
  }
  if (typeof config.textChunkLimit === "number") {
    return true;
  }
  if (config.chunkMode) {
    return true;
  }
  if (typeof config.blockStreaming === "boolean") {
    return true;
  }
  if (typeof config.mediaMaxMb === "number") {
    return true;
  }
  if (Array.isArray(config.mediaLocalRoots) && config.mediaLocalRoots.length > 0) {
    return true;
  }
  if (typeof config.sendTypingIndicators === "boolean") {
    return true;
  }
  if (config.threadBindings && Object.keys(config.threadBindings).length > 0) {
    return true;
  }
  if (config.actions && Object.keys(config.actions).length > 0) {
    return true;
  }
  if (config.dms && Object.keys(config.dms).length > 0) {
    return true;
  }
  return false;
}
function mergeOpenzaloAccountConfig(cfg, accountId) {
  const base = cfg.channels?.openzalo ?? {};
  const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...rest } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...rest, ...account };
}
function resolveOpenzaloAccount(params) {
  const accountId = normalizeAccountId3(params.accountId);
  const baseEnabled = params.cfg.channels?.openzalo?.enabled;
  const baseConfig = params.cfg.channels?.openzalo ?? {};
  const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...topLevelConfig } = baseConfig;
  const accountConfig = resolveAccountConfig(params.cfg, accountId);
  const merged = mergeOpenzaloAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const profile = merged.profile?.trim() || accountId;
  const zcaBinary = merged.zcaBinary?.trim() || process.env.OPENZCA_BINARY?.trim() || "openzca";
  const configured = hasExplicitAccountConfig(topLevelConfig) || hasExplicitAccountConfig(accountConfig);
  return {
    accountId,
    enabled: baseEnabled !== false && accountEnabled,
    name: merged.name?.trim() || void 0,
    profile,
    zcaBinary,
    configured,
    config: merged
  };
}
function listEnabledOpenzaloAccounts(cfg) {
  return listOpenzaloAccountIds(cfg).map((accountId) => resolveOpenzaloAccount({ cfg, accountId })).filter((account) => account.enabled);
}

// src/resolver-target.ts
function normalizeResolvedUserTarget(input) {
  const normalized = normalizeOpenzaloMessagingTarget(input);
  if (!normalized) {
    return "";
  }
  if (/^group:/i.test(normalized)) {
    return "";
  }
  return normalized.replace(/^(dm|user):/i, "").trim();
}
function normalizeResolvedGroupTarget(input) {
  const stripped = stripOpenzaloPrefix(input).replace(/^thread:/i, "").trim();
  if (!stripped) {
    return "";
  }
  if (/^(dm|user|u):/i.test(stripped) || /^u-/i.test(stripped)) {
    return "";
  }
  const normalized = normalizeOpenzaloMessagingTarget(stripped);
  if (!normalized) {
    return "";
  }
  if (/^group:/i.test(normalized)) {
    const groupId2 = normalized.replace(/^group:/i, "").trim();
    return groupId2 ? `group:${groupId2}` : "";
  }
  if (/^(dm|user):/i.test(normalized)) {
    return "";
  }
  const groupId = normalized.trim();
  if (!groupId) {
    return "";
  }
  return `group:${groupId}`;
}

// src/actions-target.ts
function readString(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed || void 0;
}
function resolveListGroupMembersFallbackTarget(params, fallbackTarget) {
  const explicitGroup = readString(params.groupId) ?? readString(params.group_id) ?? readString(params.threadId) ?? readString(params.thread_id);
  if (explicitGroup) {
    const normalized = normalizeResolvedGroupTarget(explicitGroup);
    if (normalized) {
      return normalized;
    }
  }
  return fallbackTarget;
}

// src/group-members.ts
var normalizeId2 = normalizeOpenzaloId;
function normalizeOpenzaloGroupMembers(payload) {
  const items = pickGroupMemberItems(payload);
  const members = /* @__PURE__ */ new Map();
  for (const item of items) {
    const id = normalizeGroupMemberId(item);
    if (!id) {
      continue;
    }
    const displayName = readFirstString(item, [
      "displayName",
      "display_name",
      "fullName",
      "full_name",
      "name"
    ]);
    const zaloName = readFirstString(item, [
      "zaloName",
      "zalo_name",
      "username"
    ]);
    const name = displayName || zaloName;
    const existing = members.get(id);
    if (!existing) {
      members.set(id, {
        id,
        ...name ? { name } : {},
        ...displayName ? { displayName } : {},
        ...zaloName ? { zaloName } : {},
        raw: item
      });
      continue;
    }
    let updated = false;
    if (!existing.displayName && displayName) {
      existing.displayName = displayName;
      updated = true;
    }
    if (!existing.zaloName && zaloName) {
      existing.zaloName = zaloName;
      updated = true;
    }
    if (!existing.name && name) {
      existing.name = name;
      updated = true;
    }
    if (updated) {
      existing.raw = item;
    }
  }
  return Array.from(members.values());
}
function pickGroupMemberItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload;
  const arrayCandidates = [
    record.members,
    record.memberList,
    record.member_list,
    record.participants,
    record.users,
    record.items,
    record.data
  ];
  for (const candidate of arrayCandidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  const objectCandidates = [
    record.members,
    record.memberList,
    record.member_list,
    record.participants,
    record.users,
    record.items,
    record.data
  ];
  for (const candidate of objectCandidates) {
    if (candidate && typeof candidate === "object") {
      return Object.values(candidate);
    }
  }
  return [record];
}
function normalizeGroupMemberId(row) {
  if (typeof row === "string" || typeof row === "number") {
    return normalizeId2(row);
  }
  if (!row || typeof row !== "object") {
    return "";
  }
  const record = row;
  const nestedUser = getNestedUser(record);
  return normalizeId2(
    record.userId ?? record.user_id ?? record.memberId ?? record.member_id ?? record.uid ?? record.id ?? nestedUser?.userId ?? nestedUser?.user_id ?? nestedUser?.id
  );
}
function readFirstString(row, keys) {
  if (!row || typeof row !== "object") {
    return void 0;
  }
  const record = row;
  const nestedUser = getNestedUser(record);
  const candidates = [
    ...keys.map((key) => record[key]),
    ...keys.map((key) => nestedUser?.[key])
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const normalized = candidate.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return void 0;
}
function getNestedUser(record) {
  return record.user && typeof record.user === "object" ? record.user : void 0;
}

// src/actions.ts
var SUPPORTED_ACTIONS = /* @__PURE__ */ new Set([
  "react",
  "read",
  "edit",
  "unsend",
  "renameGroup",
  "addParticipant",
  "removeParticipant",
  "leaveGroup",
  "pin",
  "unpin",
  "list-pins",
  "member-info"
]);
var normalizeId3 = normalizeOpenzaloId;
function resolveActionTarget(params, required = true, fallbackTarget) {
  const to = readStringParam(params, "to") ?? fallbackTarget?.trim() ?? "";
  if (!to) {
    if (required) {
      throw new Error("OpenZalo action requires target (to=...).");
    }
    return null;
  }
  return parseOpenzaloTarget(to);
}
function requireActionTarget(params, fallbackTarget) {
  const target = resolveActionTarget(params, true, fallbackTarget);
  if (!target) {
    throw new Error("OpenZalo action requires target (to=...).");
  }
  return target;
}
function readCliMessageId(params) {
  return readStringParam(params, "cliMsgId") ?? readStringParam(params, "cliMessageId") ?? readStringParam(params, "clientMessageId") ?? "";
}
function readMessageId(params) {
  return readStringParam(params, "messageId") ?? readStringParam(params, "msgId") ?? readStringParam(params, "messageSid") ?? readStringParam(params, "messageSidFull") ?? "";
}
function resolveGroupTarget(params, fallbackTarget) {
  const target = requireActionTarget(params, fallbackTarget);
  if (!target.isGroup) {
    throw new Error("Group action requires a group target: use to=group:<groupId>.");
  }
  return target;
}
function readIdList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeId3(item)).filter(Boolean);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return [String(Math.trunc(value))];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.includes(",")) {
      return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return [trimmed];
  }
  return [];
}
function readParticipantIds(params) {
  const candidates = [
    ...readIdList(params.userIds),
    ...readIdList(params.users),
    ...readIdList(params.participants),
    ...readIdList(params.participant),
    ...readIdList(params.userId),
    ...readIdList(params.address)
  ];
  const deduped = /* @__PURE__ */ new Set();
  for (const item of candidates) {
    const normalized = normalizeId3(item);
    if (normalized) {
      deduped.add(normalized);
    }
  }
  return Array.from(deduped);
}
function extractRecentRows(payload) {
  if (Array.isArray(payload)) {
    return payload.filter((item) => Boolean(item && typeof item === "object"));
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const result = payload;
  if (!Array.isArray(result.messages)) {
    return [];
  }
  return result.messages.filter((item) => Boolean(item && typeof item === "object"));
}
function normalizePinnedThreadIds(payload) {
  const out = /* @__PURE__ */ new Set();
  const collect = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          const id = item.trim();
          if (id) {
            out.add(id);
          }
          continue;
        }
        if (item && typeof item === "object") {
          const record = item;
          const id = normalizeId3(
            record.threadId ?? record.thread_id ?? record.id ?? record.conversationId ?? record.conversation_id
          );
          if (id) {
            out.add(id);
          }
        }
      }
      return;
    }
    if (value && typeof value === "object") {
      const record = value;
      collect(record.conversations);
      collect(record.items);
    }
  };
  collect(payload);
  return Array.from(out);
}
async function readRecentRows(params) {
  const args = ["msg", "recent", params.target.threadId, "--json", "-n", "80"];
  if (params.target.isGroup) {
    args.push("--group");
  }
  const recent = await runOpenzcaAccountJson({
    account: params.account,
    binary: params.account.zcaBinary,
    profile: params.account.profile,
    args,
    timeoutMs: 25e3
  });
  return extractRecentRows(recent);
}
async function resolveMessageRefsFromRecent(params) {
  const wantedMsgId = normalizeId3(params.messageId);
  const wantedCliMsgId = normalizeId3(params.cliMessageId);
  const rows = await readRecentRows({
    account: params.account,
    target: params.target
  });
  for (const row of rows) {
    const rowMsgId = normalizeId3(row.msgId);
    const rowCliMsgId = normalizeId3(row.cliMsgId);
    if (!rowMsgId && !rowCliMsgId) {
      continue;
    }
    const msgMatches = wantedMsgId && (rowMsgId === wantedMsgId || rowCliMsgId === wantedMsgId);
    const cliMatches = wantedCliMsgId && (rowCliMsgId === wantedCliMsgId || rowMsgId === wantedCliMsgId);
    if (msgMatches || cliMatches) {
      return {
        msgId: rowMsgId || void 0,
        cliMsgId: rowCliMsgId || void 0
      };
    }
  }
  if (!wantedMsgId && !wantedCliMsgId) {
    for (const row of rows) {
      const rowMsgId = normalizeId3(row.msgId);
      const rowCliMsgId = normalizeId3(row.cliMsgId);
      if (!rowMsgId || !rowCliMsgId) {
        continue;
      }
      if (!params.target.isGroup) {
        const rowSenderId = normalizeId3(row.senderId);
        if (rowSenderId && rowSenderId === params.target.threadId) {
          continue;
        }
      }
      return {
        msgId: rowMsgId,
        cliMsgId: rowCliMsgId
      };
    }
  }
  return {};
}
async function resolveActionMessageRefs(params) {
  let msgId = "";
  let cliMsgId = normalizeId3(params.cliMessageId);
  const rawMessageId = normalizeId3(params.messageId);
  if (rawMessageId) {
    const resolved = resolveOpenzaloMessageRef({
      accountId: params.account.accountId,
      rawId: rawMessageId
    });
    msgId = normalizeId3(resolved.msgId);
    if (!cliMsgId) {
      cliMsgId = normalizeId3(resolved.cliMsgId);
    }
  }
  if (!msgId && !cliMsgId && params.allowLatestFromCache) {
    const latest = getLatestOpenzaloMessageForThread({
      accountId: params.account.accountId,
      threadId: params.target.threadId,
      isGroup: params.target.isGroup
    });
    if (latest) {
      msgId = normalizeId3(latest.msgId);
      cliMsgId = normalizeId3(latest.cliMsgId);
    }
  }
  if (msgId && cliMsgId) {
    return { msgId, cliMsgId };
  }
  const fromRecent = await resolveMessageRefsFromRecent({
    account: params.account,
    target: params.target,
    messageId: msgId || rawMessageId || void 0,
    cliMessageId: cliMsgId || void 0
  });
  if (!msgId) {
    msgId = normalizeId3(fromRecent.msgId);
  }
  if (!cliMsgId) {
    cliMsgId = normalizeId3(fromRecent.cliMsgId);
  }
  if (msgId && cliMsgId) {
    return { msgId, cliMsgId };
  }
  return null;
}
var openzaloMessageActions = {
  describeMessageTool: ({ cfg }) => {
    const accounts = listEnabledOpenzaloAccounts(cfg).filter((account) => account.configured);
    if (accounts.length === 0) {
      return null;
    }
    const actions = /* @__PURE__ */ new Set([]);
    for (const account of accounts) {
      const gate = createActionGate(account.config.actions ?? {});
      if (gate("reactions")) {
        actions.add("react");
      }
      if (gate("messages")) {
        actions.add("read");
        actions.add("edit");
        actions.add("unsend");
      }
      if (gate("groups")) {
        actions.add("renameGroup");
        actions.add("addParticipant");
        actions.add("removeParticipant");
        actions.add("leaveGroup");
      }
      if (gate("pins")) {
        actions.add("pin");
        actions.add("unpin");
        actions.add("list-pins");
      }
      const memberInfoEnabled = gate("memberInfo");
      if (memberInfoEnabled) {
        actions.add("member-info");
      }
    }
    return {
      actions: Array.from(actions),
      capabilities: []
    };
  },
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    const account = resolveOpenzaloAccount({ cfg, accountId });
    const contextTarget = typeof toolContext?.currentChannelId === "string" ? toolContext.currentChannelId.trim() : "";
    if (action === "react") {
      const target = requireActionTarget(params, contextTarget);
      const refs = await resolveActionMessageRefs({
        account,
        target,
        messageId: readMessageId(params),
        cliMessageId: readCliMessageId(params),
        allowLatestFromCache: true
      });
      if (!refs) {
        throw new Error(
          "OpenZalo react could not resolve message references. Pass messageId/cliMsgId, use [message_id:N] from context, or run action=read first."
        );
      }
      const remove = typeof params.remove === "boolean" ? params.remove : false;
      if (remove) {
        throw new Error("OpenZalo remove reaction is not supported by openzca msg react.");
      }
      const emoji = readStringParam(params, "emoji") ?? readStringParam(params, "reaction", { required: true });
      const args = ["msg", "react", refs.msgId, refs.cliMsgId, target.threadId, emoji];
      if (target.isGroup) {
        args.push("--group");
      }
      await runOpenzcaAccountCommand({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 15e3
      });
      return jsonResult({ ok: true, reacted: emoji, msgId: refs.msgId, cliMsgId: refs.cliMsgId });
    }
    if (action === "read") {
      const target = requireActionTarget(params, contextTarget);
      const limit = readNumberParam(params, "limit", { integer: true });
      const args = ["msg", "recent", target.threadId, "--json"];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
        args.push("-n", String(limit));
      }
      if (target.isGroup) {
        args.push("--group");
      }
      const payload = await runOpenzcaAccountJson({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 2e4
      });
      const rows = extractRecentRows(payload);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const objectPayload = payload;
        return jsonResult({
          ok: true,
          ...objectPayload,
          messages: rows.length > 0 ? rows : objectPayload.messages
        });
      }
      return jsonResult({ ok: true, count: rows.length, messages: rows });
    }
    if (action === "edit") {
      const target = requireActionTarget(params, contextTarget);
      const refs = await resolveActionMessageRefs({
        account,
        target,
        messageId: readMessageId(params),
        cliMessageId: readCliMessageId(params),
        allowLatestFromCache: true
      });
      if (!refs) {
        throw new Error(
          "OpenZalo edit could not resolve message references. Pass messageId/cliMsgId, use [message_id:N] from context, or run action=read first."
        );
      }
      const message = readStringParam(params, "message", { allowEmpty: true }) ?? readStringParam(params, "text", { required: true, allowEmpty: true });
      const args = ["msg", "edit", refs.msgId, refs.cliMsgId, target.threadId, message];
      if (target.isGroup) {
        args.push("--group");
      }
      await runOpenzcaAccountCommand({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 2e4
      });
      return jsonResult({ ok: true, edited: refs.msgId, cliMsgId: refs.cliMsgId });
    }
    if (action === "unsend") {
      const target = requireActionTarget(params, contextTarget);
      const refs = await resolveActionMessageRefs({
        account,
        target,
        messageId: readMessageId(params),
        cliMessageId: readCliMessageId(params),
        allowLatestFromCache: true
      });
      if (!refs) {
        throw new Error(
          "OpenZalo unsend could not resolve message references. Pass messageId/cliMsgId, use [message_id:N] from context, or run action=read first."
        );
      }
      const args = ["msg", "undo", refs.msgId, refs.cliMsgId, target.threadId];
      if (target.isGroup) {
        args.push("--group");
      }
      await runOpenzcaAccountCommand({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 2e4
      });
      return jsonResult({ ok: true, unsent: refs.msgId, cliMsgId: refs.cliMsgId });
    }
    if (action === "renameGroup") {
      const target = resolveGroupTarget(params, contextTarget);
      const displayName = readStringParam(params, "displayName") ?? readStringParam(params, "name", { required: true });
      await runOpenzcaAccountCommand({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["group", "rename", target.threadId, displayName],
        timeoutMs: 2e4
      });
      return jsonResult({ ok: true, groupId: target.threadId, displayName });
    }
    if (action === "addParticipant" || action === "removeParticipant") {
      const target = resolveGroupTarget(params, contextTarget);
      const participantIds = readParticipantIds(params);
      if (participantIds.length === 0) {
        throw new Error(
          `OpenZalo ${action} requires at least one participant id (participant, participantIds, or userId).`
        );
      }
      await runOpenzcaAccountCommand({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args: [
          "group",
          action === "addParticipant" ? "add" : "remove",
          target.threadId,
          ...participantIds
        ],
        timeoutMs: 3e4
      });
      return jsonResult({
        ok: true,
        action,
        groupId: target.threadId,
        participants: participantIds
      });
    }
    if (action === "leaveGroup") {
      const target = resolveGroupTarget(params, contextTarget);
      await runOpenzcaAccountCommand({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["group", "leave", target.threadId],
        timeoutMs: 2e4
      });
      return jsonResult({ ok: true, left: target.threadId });
    }
    if (action === "pin" || action === "unpin") {
      const target = requireActionTarget(params, contextTarget);
      const args = ["msg", action === "pin" ? "pin" : "unpin", target.threadId];
      if (target.isGroup) {
        args.push("--group");
      }
      await runOpenzcaAccountCommand({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 2e4
      });
      return jsonResult({ ok: true, action, threadId: target.threadId });
    }
    if (action === "list-pins") {
      const target = resolveActionTarget(params, false, contextTarget);
      const payload = await runOpenzcaAccountJson({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["msg", "list-pins", "--json"],
        timeoutMs: 15e3
      });
      const pins = normalizePinnedThreadIds(payload).map((threadId) => ({ threadId, pinned: true }));
      if (!target) {
        return jsonResult({ ok: true, pins });
      }
      const filtered = pins.filter((row) => row.threadId === target.threadId);
      return jsonResult({ ok: true, pins: filtered, threadId: target.threadId });
    }
    if (action === "member-info") {
      const userId = readStringParam(params, "userId", { required: true });
      const row = await runOpenzcaAccountJson({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["msg", "member-info", userId, "--json"],
        timeoutMs: 15e3
      });
      return jsonResult({ ok: true, member: row });
    }
    if (action === "list-group-members") {
      const target = resolveGroupTarget(
        params,
        resolveListGroupMembersFallbackTarget(params, contextTarget)
      );
      const payload = await runOpenzcaAccountJson({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["group", "members", target.threadId, "--json"],
        timeoutMs: 2e4
      });
      const members = normalizeOpenzaloGroupMembers(payload);
      const lines = members.map((member) => `${member.id} - ${member.name ?? ""}`.trimEnd());
      return jsonResult({
        ok: true,
        groupId: target.threadId,
        count: members.length,
        members,
        lines
      });
    }
    throw new Error(`Action ${action} is not supported for provider openzalo.`);
  }
};

// src/onboarding.ts
var channel = "openzalo";
function setOpenzaloDmPolicy(cfg, dmPolicy2) {
  const allowFrom = dmPolicy2 === "open" ? addWildcardAllowFrom(cfg.channels?.openzalo?.allowFrom) : void 0;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      openzalo: {
        ...cfg.channels?.openzalo,
        dmPolicy: dmPolicy2,
        ...allowFrom ? { allowFrom } : {}
      }
    }
  };
}
function setOpenzaloAllowFrom(cfg, accountId, allowFrom) {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        openzalo: {
          ...cfg.channels?.openzalo,
          allowFrom
        }
      }
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      openzalo: {
        ...cfg.channels?.openzalo,
        accounts: {
          ...cfg.channels?.openzalo?.accounts,
          [accountId]: {
            ...cfg.channels?.openzalo?.accounts?.[accountId],
            allowFrom
          }
        }
      }
    }
  };
}
function parseOpenzaloAllowFromInput(raw) {
  return raw.split(/[\n,;]+/g).map((entry) => normalizeOpenzaloAllowEntry(entry)).filter(Boolean);
}
async function promptOpenzaloAllowFrom(params) {
  const accountId = params.accountId && normalizeAccountId(params.accountId) ? normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID : resolveDefaultOpenzaloAccountId(params.cfg);
  const resolved = resolveOpenzaloAccount({ cfg: params.cfg, accountId });
  const existing = resolved.config.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist OpenZalo DM senders by user ID.",
      "Examples:",
      "- 123456789",
      "- 987654321",
      "Multiple entries: comma- or newline-separated.",
      `Docs: ${formatDocsLink("/channels/openzalo", "openzalo")}`
    ].join("\n"),
    "OpenZalo allowlist"
  );
  const entry = await params.prompter.text({
    message: "OpenZalo allowFrom (user ids)",
    placeholder: "123456789, 987654321",
    initialValue: existing[0] ? String(existing[0]) : void 0,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const parts2 = parseOpenzaloAllowFromInput(raw);
      if (parts2.length === 0) {
        return "Invalid entries";
      }
      return void 0;
    }
  });
  const parts = parseOpenzaloAllowFromInput(String(entry));
  const unique = mergeAllowFromEntries(void 0, parts);
  return setOpenzaloAllowFrom(params.cfg, accountId, unique);
}
var dmPolicy = {
  label: "OpenZalo",
  channel,
  policyKey: "channels.openzalo.dmPolicy",
  allowFromKey: "channels.openzalo.allowFrom",
  getCurrent: (cfg) => cfg.channels?.openzalo?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setOpenzaloDmPolicy(cfg, policy),
  promptAllowFrom: promptOpenzaloAllowFrom
};
function setOpenzaloProfileAndBinary(params) {
  const { cfg, accountId, profile, zcaBinary } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        openzalo: {
          ...cfg.channels?.openzalo,
          enabled: true,
          profile,
          zcaBinary
        }
      }
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      openzalo: {
        ...cfg.channels?.openzalo,
        enabled: true,
        accounts: {
          ...cfg.channels?.openzalo?.accounts,
          [accountId]: {
            ...cfg.channels?.openzalo?.accounts?.[accountId],
            enabled: cfg.channels?.openzalo?.accounts?.[accountId]?.enabled ?? true,
            profile,
            zcaBinary
          }
        }
      }
    }
  };
}
var openzaloOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listOpenzaloAccountIds(cfg).some((accountId) => {
      const account = resolveOpenzaloAccount({ cfg, accountId });
      return account.configured;
    });
    return {
      channel,
      configured,
      statusLines: [`OpenZalo: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "personal account via openzca CLI",
      quickstartScore: configured ? 1 : 0
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides.openzalo?.trim();
    const defaultAccountId = resolveDefaultOpenzaloAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "OpenZalo",
        currentId: accountId,
        listAccountIds: listOpenzaloAccountIds,
        defaultAccountId
      });
    }
    const resolved = resolveOpenzaloAccount({ cfg, accountId });
    const profileInput = await prompter.text({
      message: "openzca profile",
      placeholder: accountId,
      initialValue: resolved.config.profile?.trim() || accountId,
      validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
    });
    const profile = String(profileInput).trim();
    const customBinary = await prompter.confirm({
      message: "Use custom openzca binary path?",
      initialValue: Boolean(
        resolved.config.zcaBinary?.trim() && resolved.config.zcaBinary?.trim() !== "openzca"
      )
    });
    let zcaBinary = resolved.config.zcaBinary?.trim() || "openzca";
    if (customBinary) {
      const binaryInput = await prompter.text({
        message: "openzca binary path",
        placeholder: "openzca",
        initialValue: zcaBinary,
        validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
      });
      zcaBinary = String(binaryInput).trim();
    } else {
      zcaBinary = "openzca";
    }
    const next = setOpenzaloProfileAndBinary({
      cfg,
      accountId,
      profile,
      zcaBinary
    });
    await prompter.note(
      [
        "Next steps:",
        `1. Login: openzca --profile ${profile} auth login`,
        "2. Restart gateway if needed.",
        "3. Send a DM to test pairing/access policy.",
        `Docs: ${formatDocsLink("/channels/openzalo", "openzalo")}`
      ].join("\n"),
      "OpenZalo next steps"
    );
    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      openzalo: { ...cfg.channels?.openzalo, enabled: false }
    }
  })
};

// src/config-schema.ts
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

// src/config-schema-core.ts
import { z } from "zod";
var allowFromEntry = z.union([z.string(), z.number()]);
var markdownTableModeSchema = z.enum(["off", "bullets", "code"]);
var markdownConfigSchema = z.object({
  tables: markdownTableModeSchema.optional()
}).strict().optional();
var toolPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  alsoAllow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional()
}).strict().superRefine((value, ctx) => {
  if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)"
    });
  }
}).optional();
var openzaloAcpxSchema = z.object({
  enabled: z.boolean().optional(),
  command: z.string().optional(),
  agent: z.string().optional(),
  cwd: z.string().optional(),
  timeoutSeconds: z.number().positive().optional(),
  permissionMode: z.enum(["approve-all", "approve-reads", "deny-all"]).optional(),
  nonInteractivePermissions: z.enum(["deny", "fail"]).optional()
}).optional();
var openzaloThreadBindingsSchema = z.object({
  enabled: z.boolean().optional(),
  spawnSubagentSessions: z.boolean().optional(),
  ttlHours: z.number().nonnegative().optional()
}).optional();
var openzaloActionSchema = z.object({
  reactions: z.boolean().default(true),
  messages: z.boolean().default(true),
  groups: z.boolean().default(true),
  pins: z.boolean().default(true),
  memberInfo: z.boolean().default(true),
  groupMembers: z.boolean().default(true)
}).optional();
var openzaloGroupConfigSchema = z.object({
  enabled: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  tools: toolPolicySchema,
  toolsBySender: z.record(z.string(), toolPolicySchema).optional(),
  skills: z.array(z.string()).optional(),
  systemPrompt: z.string().optional()
});
var openzaloAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  profile: z.string().optional(),
  zcaBinary: z.string().optional(),
  acpx: openzaloAcpxSchema,
  markdown: markdownConfigSchema,
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  groupPolicy: z.enum(["open", "disabled", "allowlist"]).optional(),
  groupAllowFrom: z.array(allowFromEntry).optional(),
  groups: z.object({}).catchall(openzaloGroupConfigSchema).optional(),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  blockStreaming: z.boolean().optional(),
  mediaMaxMb: z.number().int().positive().optional(),
  mediaLocalRoots: z.array(z.string()).optional(),
  sendTypingIndicators: z.boolean().optional(),
  threadBindings: openzaloThreadBindingsSchema,
  actions: openzaloActionSchema
});
var OpenzaloConfigSchema = openzaloAccountSchema.extend({
  accounts: z.object({}).catchall(openzaloAccountSchema).optional(),
  defaultAccount: z.string().optional()
});

// src/config-schema.ts
var OpenzaloChannelConfigSchema = buildChannelConfigSchema(OpenzaloConfigSchema);

// src/status.ts
function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function readProbeFailure(value) {
  if (!value || typeof value !== "object") {
    return { failed: false };
  }
  const probe = value;
  if (probe.ok !== false) {
    return { failed: false };
  }
  return {
    failed: true,
    error: asString(probe.error ?? null) ?? void 0
  };
}
function resolveOpenzaloAccountState(params) {
  if (!params.enabled) {
    return "disabled";
  }
  if (!params.configured) {
    return "not configured";
  }
  return "configured";
}
function collectOpenzaloStatusIssues(accounts) {
  const issues = [];
  for (const account of accounts) {
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) {
      continue;
    }
    const configured = account.configured === true;
    if (!configured) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "config",
        message: "Not configured (missing OpenZalo account settings).",
        fix: "Set channels.openzalo profile/settings and run: openclaw channels login --channel openzalo"
      });
      continue;
    }
    const probeFailure = readProbeFailure(account.probe);
    if (probeFailure.failed) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "runtime",
        message: probeFailure.error ? `openzca auth check failed: ${probeFailure.error}` : "openzca auth check failed",
        fix: "Verify openzca login/profile on the gateway host."
      });
    }
    const running = account.running === true;
    const connected = account.connected === false ? false : account.connected === true ? true : null;
    const reconnectAttempts = asNumber(account.reconnectAttempts);
    const lastError = asString(account.lastError);
    if (running && connected === false) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "runtime",
        message: `openzca disconnected${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
        fix: "Check openzca auth/profile health on the gateway host and inspect gateway logs."
      });
      continue;
    }
    if (lastError) {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "runtime",
        message: `Channel error: ${lastError}`
      });
    }
  }
  return issues;
}

// src/channel.ts
var meta = {
  id: "openzalo",
  label: "OpenZalo",
  selectionLabel: "OpenZalo (personal account)",
  detailLabel: "OpenZalo",
  docsPath: "/channels/openzalo",
  docsLabel: "openzalo",
  blurb: "Personal Zalo account integration via openzca CLI.",
  systemImage: "message",
  aliases: ["ozl", "zlu", "zalo-personal"],
  order: 80,
  quickstartAllowFrom: true
};
function normalizeDirectoryName(value) {
  return typeof value === "string" ? value.trim() : "";
}
function resolveAccount(cfg, accountId) {
  return resolveOpenzaloAccount({ cfg, accountId });
}
function mergeOpenzaloRuntimeState(accountId, runtime2) {
  const local = getOpenzaloRuntimeHealthState(accountId);
  return {
    connected: local?.connected ?? (typeof runtime2?.connected === "boolean" ? runtime2.connected : null),
    reconnectAttempts: local?.reconnectAttempts ?? (typeof runtime2?.reconnectAttempts === "number" ? runtime2.reconnectAttempts : null),
    lastConnectedAt: local?.lastConnectedAt ?? (typeof runtime2?.lastConnectedAt === "number" ? runtime2.lastConnectedAt : null),
    lastEventAt: local?.lastEventAt ?? (typeof runtime2?.lastEventAt === "number" ? runtime2.lastEventAt : null),
    lastError: local?.lastError ?? (typeof runtime2?.lastError === "string" || runtime2?.lastError === null ? runtime2.lastError : null)
  };
}
function chooseDirectoryMatch(params) {
  const query = params.query.trim().toLowerCase();
  if (!query) {
    return { ambiguous: false };
  }
  const exactMatches = params.entries.filter(
    (entry) => entry.id.toLowerCase() === query || normalizeDirectoryName(entry.name).toLowerCase() === query
  );
  if (exactMatches.length === 1) {
    return { best: exactMatches[0], ambiguous: false };
  }
  if (exactMatches.length > 1) {
    return { best: exactMatches[0], ambiguous: true };
  }
  const partialMatches = params.entries.filter((entry) => {
    const name = normalizeDirectoryName(entry.name).toLowerCase();
    return entry.id.toLowerCase().includes(query) || (name ? name.includes(query) : false);
  });
  if (partialMatches.length === 1) {
    return { best: partialMatches[0], ambiguous: false };
  }
  if (partialMatches.length > 1) {
    return { best: partialMatches[0], ambiguous: true };
  }
  return { ambiguous: false };
}
var openzaloPlugin = {
  id: "openzalo",
  meta,
  onboarding: openzaloOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    unsend: true,
    groupManagement: true,
    blockStreaming: true
  },
  pairing: {
    idLabel: "openzaloSenderId",
    normalizeAllowEntry: (entry) => normalizeOpenzaloAllowEntry(entry),
    notifyApproval: async ({ cfg, id, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      await sendTextOpenzalo({
        cfg,
        account,
        to: id,
        text: PAIRING_APPROVED_MESSAGE
      });
    }
  },
  reload: { configPrefixes: ["channels.openzalo"] },
  configSchema: OpenzaloChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listOpenzaloAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
    defaultAccountId: (cfg) => resolveDefaultOpenzaloAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
      cfg,
      sectionKey: "openzalo",
      accountId,
      enabled,
      allowTopLevel: true
    }),
    deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
      cfg,
      sectionKey: "openzalo",
      accountId,
      clearBaseFields: ["name", "profile", "zcaBinary"]
    }),
    // Keep startup config static so gateway-level restart/backoff can recover
    // from transient auth/CLI failures after updates or restarts.
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      profile: account.profile,
      zcaBinary: account.zcaBinary
    }),
    resolveAllowFrom: ({ cfg, accountId }) => (resolveAccount(cfg, accountId).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => normalizeOpenzaloAllowEntry(String(entry))).filter(Boolean)
  },
  actions: openzaloMessageActions,
  agentPrompt: {
    messageToolHints: () => [
      "- OpenZalo action workflow: after `message` tool actions like `edit`, `unsend`, `react`, or `unreact`, always send a normal assistant reply that summarizes what you changed.",
      "- OpenZalo group `send`: plain `@Name` or `@userId` in the outgoing message becomes a native Zalo mention, not just literal text.",
      "- OpenZalo mentions: do not guess. Only send an exact unique native mention when the correct member id or name is already known from context or provided by the user.",
      "- If exact member identity is missing for a native mention, use the bundled `openzca` skill to resolve group members first instead of asking the user for the id/name immediately.",
      "- OpenZalo `member-info`: pass only `userId` (no `target`/`to`).",
      "- Do not reply with `NO_REPLY` after non-send actions. Use `NO_REPLY` only when `action=send` already contains the full user-facing response.",
      "- If an action fails, send a concise failure summary naming the action and error reason.",
      "- OpenZalo media: prefer the message tool with media/path/filePath for generated images or files. If you inline media, keep `MEDIA:<path-or-url>` on its own line with a safe workspace path.",
      "- Restart recovery: if recent history shows tool actions completed but no assistant confirmation (for example after interruption/restart), send a brief recovery summary of completed and failed actions before handling the new request."
    ]
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.openzalo?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath ? `channels.openzalo.accounts.${resolvedAccountId}.` : "channels.openzalo.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("openzalo"),
        normalizeEntry: (raw) => normalizeOpenzaloAllowEntry(raw)
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      const hasGroups = Boolean(account.config.groups && Object.keys(account.config.groups).length > 0);
      const hasGroupAllowFrom = Boolean(account.config.groupAllowFrom?.length);
      if (groupPolicy === "open" && !hasGroups && !hasGroupAllowFrom) {
        warnings.push(
          '- OpenZalo groups: groupPolicy="open" with no group restrictions allows all groups (mention-gated). Prefer channels.openzalo.groupPolicy="allowlist".'
        );
      }
      return warnings;
    }
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveAccount(cfg, accountId);
      if (!groupId) {
        return true;
      }
      const match = resolveOpenzaloGroupMatch({
        groups: account.config.groups,
        target: groupId
      });
      return resolveOpenzaloRequireMention({
        groupConfig: match.groupConfig,
        wildcardConfig: match.wildcardConfig
      });
    },
    resolveToolPolicy: ({ cfg, accountId, groupId, senderId, senderName, senderUsername, senderE164 }) => {
      const account = resolveAccount(cfg, accountId);
      if (!groupId) {
        return void 0;
      }
      const match = resolveOpenzaloGroupMatch({
        groups: account.config.groups,
        target: groupId
      });
      return resolveOpenzaloGroupToolPolicy({
        groupConfig: match.groupConfig,
        wildcardConfig: match.wildcardConfig,
        senderId,
        senderName,
        senderUsername,
        senderE164
      });
    }
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => {
      const normalizedCurrentChannelId = context.To ? normalizeOpenzaloMessagingTarget(context.To.trim()) : "";
      return {
        currentChannelId: normalizedCurrentChannelId || context.To?.trim() || void 0,
        currentThreadTs: context.MessageSidFull ?? context.MessageSid ?? context.ReplyToIdFull ?? context.ReplyToId,
        hasRepliedRef
      };
    }
  },
  messaging: {
    normalizeTarget: normalizeOpenzaloMessagingTarget,
    transformReplyPayload: ({ payload }) => parseOpenzaloMediaDirectives(payload),
    targetResolver: {
      looksLikeId: looksLikeOpenzaloTargetId,
      hint: "<userId|group:groupId>"
    }
  },
  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      return await listOpenzaloDirectorySelf({ account });
    },
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveAccount(cfg, accountId);
      return await listOpenzaloDirectoryPeers({ account, query, limit });
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveAccount(cfg, accountId);
      return await listOpenzaloDirectoryGroups({ account, query, limit });
    }
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind, runtime: runtime2 }) => {
      const account = resolveAccount(cfg, accountId);
      const results = inputs.map((input) => ({
        input,
        resolved: false,
        id: void 0,
        name: void 0,
        note: void 0
      }));
      const unresolved = [];
      for (const [index, input] of inputs.entries()) {
        const trimmed = input.trim();
        if (!trimmed) {
          results[index].note = "empty input";
          continue;
        }
        if (kind === "user") {
          const normalized = normalizeResolvedUserTarget(trimmed);
          if (normalized) {
            results[index] = {
              input,
              resolved: true,
              id: normalized
            };
            continue;
          }
          unresolved.push({ query: trimmed, index });
          continue;
        }
        const normalizedGroup = normalizeResolvedGroupTarget(trimmed);
        if (normalizedGroup) {
          results[index] = {
            input,
            resolved: true,
            id: normalizedGroup
          };
          continue;
        }
        unresolved.push({ query: trimmed, index });
      }
      if (unresolved.length === 0) {
        return results;
      }
      try {
        if (kind === "user") {
          const peers = await listOpenzaloDirectoryPeers({
            account
          });
          for (const pending of unresolved) {
            const match = chooseDirectoryMatch({
              query: pending.query,
              entries: peers.map((entry) => ({ id: entry.id, name: entry.name }))
            });
            if (!match.best) {
              results[pending.index].note = "no user match";
              continue;
            }
            results[pending.index] = {
              input: results[pending.index].input,
              resolved: true,
              id: match.best.id,
              name: match.best.name,
              ...match.ambiguous ? { note: "multiple matches; chose first" } : {}
            };
          }
          return results;
        }
        const groups = await listOpenzaloDirectoryGroups({
          account
        });
        for (const pending of unresolved) {
          const match = chooseDirectoryMatch({
            query: pending.query,
            entries: groups.map((entry) => ({ id: entry.id, name: entry.name }))
          });
          if (!match.best) {
            results[pending.index].note = "no group match";
            continue;
          }
          results[pending.index] = {
            input: results[pending.index].input,
            resolved: true,
            id: `group:${match.best.id}`,
            name: match.best.name,
            ...match.ambiguous ? { note: "multiple matches; chose first" } : {}
          };
        }
        return results;
      } catch (err) {
        runtime2.error?.(`openzalo resolve failed: ${String(err)}`);
        for (const pending of unresolved) {
          results[pending.index].note = "lookup failed";
        }
        return results;
      }
    }
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
      cfg,
      channelKey: "openzalo",
      accountId,
      name
    }),
    validateInput: () => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "openzalo",
        accountId,
        name: input.name
      });
      const next = accountId !== DEFAULT_ACCOUNT_ID ? migrateBaseNameToDefaultAccount({
        cfg: namedConfig,
        channelKey: "openzalo"
      }) : namedConfig;
      const binaryPath = input.cliPath?.trim();
      if (accountId === DEFAULT_ACCOUNT_ID) {
        const existingProfile = next.channels?.openzalo?.profile?.trim();
        return {
          ...next,
          channels: {
            ...next.channels,
            openzalo: {
              ...next.channels?.openzalo,
              enabled: true,
              profile: existingProfile || accountId,
              ...binaryPath ? { zcaBinary: binaryPath } : {}
            }
          }
        };
      }
      const existingAccountProfile = next.channels?.openzalo?.accounts?.[accountId]?.profile?.trim();
      return {
        ...next,
        channels: {
          ...next.channels,
          openzalo: {
            ...next.channels?.openzalo,
            enabled: true,
            accounts: {
              ...next.channels?.openzalo?.accounts,
              [accountId]: {
                ...next.channels?.openzalo?.accounts?.[accountId],
                enabled: true,
                profile: existingAccountProfile || accountId,
                ...binaryPath ? { zcaBinary: binaryPath } : {}
              }
            }
          }
        }
      };
    }
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getOpenzaloRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 1800,
    resolveTarget: ({ to }) => {
      try {
        const parsed = parseOpenzaloTarget(to);
        return {
          ok: true,
          to: parsed.isGroup ? `group:${parsed.threadId}` : `user:${parsed.threadId}`
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err))
        };
      }
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      const result = await sendTextOpenzalo({
        cfg,
        account,
        to,
        text
      });
      return {
        channel: "openzalo",
        ...result
      };
    },
    sendMedia: async (ctx) => {
      const { cfg, to, text, mediaUrl, mediaAccess, mediaLocalRoots, mediaReadFile, accountId } = ctx;
      const { mediaPath } = ctx;
      const account = resolveAccount(cfg, accountId);
      const mergedMediaLocalRoots = Array.from(
        /* @__PURE__ */ new Set([
          ...account.config.mediaLocalRoots ?? [],
          ...mediaAccess?.localRoots ?? [],
          ...mediaLocalRoots ?? []
        ])
      );
      const mergedMediaAccess = mediaAccess ? {
        ...mediaAccess,
        ...mergedMediaLocalRoots.length > 0 ? { localRoots: mergedMediaLocalRoots } : {}
      } : void 0;
      const result = await sendMediaOpenzalo({
        cfg,
        account,
        to,
        text,
        mediaUrl,
        mediaPath,
        mediaAccess: mergedMediaAccess,
        mediaLocalRoots: mergedMediaLocalRoots.length > 0 ? mergedMediaLocalRoots : void 0,
        mediaReadFile
      });
      return {
        channel: "openzalo",
        ...result
      };
    }
  },
  auth: {
    login: async ({ cfg, accountId, runtime: runtime2 }) => {
      const account = resolveAccount(cfg, accountId);
      runtime2.log(
        `Complete OpenZalo login in this terminal (account: ${account.accountId}, profile: ${account.profile}).`
      );
      await runOpenzcaInteractive({
        binary: account.zcaBinary,
        profile: account.profile,
        args: ["auth", "login"]
      });
    }
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastEventAt: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      profile: null,
      zcaBinary: null
    },
    collectStatusIssues: collectOpenzaloStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      profile: snapshot.profile ?? null,
      zcaBinary: snapshot.zcaBinary ?? null,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? null,
      reconnectAttempts: snapshot.reconnectAttempts ?? null,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastEventAt: snapshot.lastEventAt ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null
    }),
    probeAccount: async ({ account, timeoutMs }) => await probeOpenzaloAuth({ account, timeoutMs }),
    buildAccountSnapshot: ({ account, runtime: runtime2, probe }) => {
      const mergedRuntime = mergeOpenzaloRuntimeState(account.accountId, runtime2);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        profile: account.profile,
        zcaBinary: account.zcaBinary,
        running: runtime2?.running ?? false,
        connected: mergedRuntime.connected,
        reconnectAttempts: mergedRuntime.reconnectAttempts,
        lastConnectedAt: mergedRuntime.lastConnectedAt,
        lastEventAt: mergedRuntime.lastEventAt,
        lastStartAt: runtime2?.lastStartAt ?? null,
        lastStopAt: runtime2?.lastStopAt ?? null,
        lastError: mergedRuntime.lastError,
        probe,
        lastInboundAt: runtime2?.lastInboundAt ?? null,
        lastOutboundAt: runtime2?.lastOutboundAt ?? null
      };
    },
    resolveAccountState: ({ enabled, configured }) => resolveOpenzaloAccountState({ enabled, configured })
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        profile: account.profile,
        zcaBinary: account.zcaBinary,
        connected: false,
        reconnectAttempts: 0,
        lastConnectedAt: null,
        lastEventAt: null,
        lastError: null
      });
      ctx.log?.info(
        `[${account.accountId}] starting provider (profile=${account.profile}, binary=${account.zcaBinary})`
      );
      return await monitorOpenzaloProvider({
        account,
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch })
      });
    },
    logoutAccount: async ({ cfg, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      const result = await probeOpenzaloAuth({ account, timeoutMs: 5e3, forceRefresh: true });
      if (!result.ok) {
        return { cleared: false, loggedOut: true };
      }
      try {
        await runOpenzcaCommand({
          binary: account.zcaBinary,
          profile: account.profile,
          args: ["auth", "logout"],
          timeoutMs: 1e4
        });
        return { cleared: true, loggedOut: true };
      } catch {
        return { cleared: false, loggedOut: false };
      }
    }
  }
};

// src/subagent-hooks.ts
import fs5 from "node:fs";
import fsp2 from "node:fs/promises";
import path9 from "node:path";
var DEFAULT_THREAD_BINDING_TTL_HOURS = 24;
var BINDINGS_STORE_VERSION = 1;
var STORE_LOCK_OPTIONS = {
  retries: {
    retries: 8,
    factor: 1.5,
    minTimeout: 10,
    maxTimeout: 400,
    randomize: true
  },
  stale: 3e4
};
function computeLockDelayMs(retries, attempt) {
  const base = Math.min(
    retries.maxTimeout,
    Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt)
  );
  const jitter = retries.randomize ? 1 + Math.random() : 1;
  return Math.min(retries.maxTimeout, Math.round(base * jitter));
}
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function isStaleLock(lockPath, staleMs) {
  try {
    const raw = await fsp2.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.createdAt) {
      const createdAt = Date.parse(parsed.createdAt);
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) {
        return true;
      }
    }
  } catch {
  }
  try {
    const stat = await fsp2.stat(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return true;
  }
}
async function withStoreFileLock(filePath, options, fn) {
  const normalizedPath = path9.resolve(filePath);
  const lockPath = `${normalizedPath}.lock`;
  await fsp2.mkdir(path9.dirname(normalizedPath), { recursive: true });
  const attempts = Math.max(1, options.retries.retries + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let handle = null;
    try {
      handle = await fsp2.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2),
        "utf8"
      );
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => void 0);
        await fsp2.rm(lockPath, { force: true }).catch(() => void 0);
      }
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => void 0);
      }
      const code = err.code;
      if (code !== "EEXIST") {
        throw err;
      }
      if (await isStaleLock(lockPath, options.stale)) {
        await fsp2.rm(lockPath, { force: true }).catch(() => void 0);
        continue;
      }
      if (attempt >= attempts - 1) {
        break;
      }
      await sleep(computeLockDelayMs(options.retries, attempt));
    }
  }
  throw new Error(`file lock timeout for ${normalizedPath}`);
}
async function writeJsonFileAtomically(filePath, payload) {
  const normalizedPath = path9.resolve(filePath);
  await fsp2.mkdir(path9.dirname(normalizedPath), { recursive: true });
  const tmpPath = `${normalizedPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fsp2.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}
`, "utf8");
    await fsp2.rename(tmpPath, normalizedPath);
  } finally {
    await fsp2.rm(tmpPath, { force: true }).catch(() => void 0);
  }
}
function summarizeError3(err) {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}
function resolveThreadBindingTtlMs(ttlHours) {
  if (typeof ttlHours !== "number" || !Number.isFinite(ttlHours) || ttlHours <= 0) {
    return void 0;
  }
  return Math.max(1, Math.floor(ttlHours * 60 * 60 * 1e3));
}
function resolveBindingsStorePath(api) {
  const stateDir = api.runtime.state.resolveStateDir(process.env);
  return path9.join(stateDir, "openzalo", "subagent-bindings.json");
}
function loadBindingsFromDiskSync(api, storePath) {
  const logger = api.runtime.logging.getChildLogger({ plugin: "openzalo", scope: "subagent-hooks" });
  try {
    const raw = fs5.readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    const bindings = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bindings) ? parsed.bindings : [];
    replaceOpenzaloSubagentBindings(bindings);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT") {
      replaceOpenzaloSubagentBindings([]);
      return;
    }
    logger.warn(`openzalo subagent bindings restore failed: ${summarizeError3(err)}`);
    replaceOpenzaloSubagentBindings([]);
  }
}
async function persistBindingsToDisk(api, storePath) {
  const logger = api.runtime.logging.getChildLogger({ plugin: "openzalo", scope: "subagent-hooks" });
  try {
    await withStoreFileLock(storePath, STORE_LOCK_OPTIONS, async () => {
      const payload = {
        version: BINDINGS_STORE_VERSION,
        bindings: snapshotOpenzaloSubagentBindings()
      };
      await writeJsonFileAtomically(storePath, payload);
    });
  } catch (err) {
    logger.warn(`openzalo subagent bindings persist failed: ${summarizeError3(err)}`);
  }
}
function registerOpenzaloSubagentHooks(api) {
  const storePath = resolveBindingsStorePath(api);
  loadBindingsFromDiskSync(api, storePath);
  let persistQueue = Promise.resolve();
  const persistBindings = async () => {
    persistQueue = persistQueue.catch(() => void 0).then(() => persistBindingsToDisk(api, storePath));
    await persistQueue;
  };
  const resolveThreadBindingFlags = (accountId) => {
    const cfg = api.config;
    const account = resolveOpenzaloAccount({
      cfg,
      accountId
    });
    const baseThreadBindings = cfg.channels?.openzalo?.threadBindings;
    const accountThreadBindings = cfg.channels?.openzalo?.accounts?.[account.accountId]?.threadBindings;
    const ttlHoursRaw = accountThreadBindings?.ttlHours ?? baseThreadBindings?.ttlHours ?? cfg.session?.threadBindings?.ttlHours ?? DEFAULT_THREAD_BINDING_TTL_HOURS;
    const ttlHours = typeof ttlHoursRaw === "number" && Number.isFinite(ttlHoursRaw) ? Math.max(0, ttlHoursRaw) : DEFAULT_THREAD_BINDING_TTL_HOURS;
    return {
      enabled: accountThreadBindings?.enabled ?? baseThreadBindings?.enabled ?? cfg.session?.threadBindings?.enabled ?? true,
      spawnSubagentSessions: accountThreadBindings?.spawnSubagentSessions ?? baseThreadBindings?.spawnSubagentSessions ?? true,
      ttlHours
    };
  };
  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel2 = event.requester?.channel?.trim().toLowerCase();
    if (channel2 !== "openzalo") {
      return;
    }
    const threadBindingFlags = resolveThreadBindingFlags(event.requester?.accountId);
    if (!threadBindingFlags.enabled) {
      return {
        status: "error",
        error: "OpenZalo thread bindings are disabled (set channels.openzalo.threadBindings.enabled=true or session.threadBindings.enabled=true)."
      };
    }
    if (!threadBindingFlags.spawnSubagentSessions) {
      return {
        status: "error",
        error: "OpenZalo thread-bound subagent spawns are disabled (set channels.openzalo.threadBindings.spawnSubagentSessions=true)."
      };
    }
    try {
      const requesterTo = event.requester?.to?.trim();
      if (!requesterTo) {
        return {
          status: "error",
          error: "OpenZalo thread bind failed: requester target is missing."
        };
      }
      const binding = bindOpenzaloSubagentSession({
        accountId: event.requester?.accountId,
        to: requesterTo,
        childSessionKey: event.childSessionKey,
        agentId: event.agentId,
        label: event.label,
        ttlMs: resolveThreadBindingTtlMs(threadBindingFlags.ttlHours)
      });
      if (!binding) {
        return {
          status: "error",
          error: "Unable to bind this OpenZalo conversation for thread=true (invalid requester target context)."
        };
      }
      await persistBindings();
      return { status: "ok", threadBindingReady: true };
    } catch (err) {
      return {
        status: "error",
        error: `OpenZalo thread bind failed: ${summarizeError3(err)}`
      };
    }
  });
  api.on("subagent_ended", async (event) => {
    if (event.targetKind !== "subagent") {
      return;
    }
    const removed = unbindOpenzaloSubagentSessionByKey({
      childSessionKey: event.targetSessionKey,
      accountId: event.accountId
    });
    if (removed.length > 0) {
      await persistBindings();
    }
  });
  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== "openzalo") {
      return;
    }
    const binding = resolveOpenzaloBoundOriginBySession({
      childSessionKey: event.childSessionKey,
      accountId: event.requesterOrigin?.accountId
    });
    if (!binding) {
      return;
    }
    return {
      origin: {
        channel: "openzalo",
        accountId: binding.accountId,
        to: binding.to,
        threadId: binding.threadId
      }
    };
  });
}

// index.ts
var index_default = defineChannelPluginEntry({
  id: "openzalo",
  name: "OpenZalo",
  description: "OpenZalo channel plugin (personal account via openzca CLI)",
  plugin: openzaloPlugin,
  setRuntime: setOpenzaloRuntime,
  registerFull(api) {
    registerOpenzaloSubagentHooks(api);
  }
});
export {
  index_default as default
};
