import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  promptAccountId,
  promptChannelAccessConfig,
} from "openclaw/plugin-sdk";
import type {
  OpenzaloGroupMentionDetectionFailureMode,
  ZcaFriend,
  ZcaGroup,
} from "./types.js";
import {
  listOpenzaloAccountIds,
  resolveDefaultOpenzaloAccountId,
  resolveOpenzaloAccountSync,
  checkZcaAuthenticated,
} from "./accounts.js";
import { runOpenzca, runOpenzcaInteractive, checkOpenzcaInstalled, parseJsonOutput } from "./openzca.js";
import { OPENZALO_DEFAULT_FAILURE_NOTICE_MESSAGE } from "./constants.js";

const channel = "openzalo" as const;

function setOpenzaloDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): OpenClawConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.openzalo?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      openzalo: {
        ...cfg.channels?.openzalo,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as OpenClawConfig;
}

async function noteOpenzaloHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Zalo Personal Account login via QR code.",
      "",
      "Prerequisites:",
      "1) Install openzca",
      "2) You'll scan a QR code with your Zalo app",
      "",
      "Docs: https://openzca.com/",
    ].join("\n"),
    "Zalo Personal Setup",
  );
}

function parseAllowFromEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function resolveOpenzaloAllowFromEntries(params: {
  profile: string;
  inputs: string[];
  prompter: WizardPrompter;
  noteTitle: string;
}): Promise<{ resolved: string[]; unresolved: string[] }> {
  const { profile, inputs, prompter, noteTitle } = params;
  const openzcaInstalled = await checkOpenzcaInstalled();
  const resolved: string[] = [];
  const unresolved: string[] = [];

  for (const input of inputs) {
    const trimmed = input.trim();
    if (!trimmed) {
      continue;
    }
    if (/^\d+$/.test(trimmed)) {
      resolved.push(trimmed);
      continue;
    }
    if (!openzcaInstalled) {
      unresolved.push(trimmed);
      continue;
    }
    const result = await runOpenzca(["friend", "find", trimmed], {
      profile,
      timeout: 15000,
    });
    if (!result.ok) {
      unresolved.push(trimmed);
      continue;
    }
    const parsed = parseJsonOutput<ZcaFriend[]>(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [];
    const match = rows[0];
    if (!match?.userId) {
      unresolved.push(trimmed);
      continue;
    }
    if (rows.length > 1) {
      await prompter.note(
        `Multiple matches for "${trimmed}", using ${match.displayName ?? match.userId}.`,
        noteTitle,
      );
    }
    resolved.push(String(match.userId));
  }

  return {
    resolved: [...new Set(resolved)],
    unresolved: [...new Set(unresolved)],
  };
}

async function promptOpenzaloAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveOpenzaloAccountSync({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];

  while (true) {
    const entry = await prompter.text({
      message: "Openzalo allowFrom (username or user id)",
      placeholder: "Alice, 123456789",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseAllowFromEntries(String(entry));
    const { resolved: resolvedIds, unresolved } = await resolveOpenzaloAllowFromEntries({
      profile: resolved.profile,
      inputs: parts,
      prompter,
      noteTitle: "Zalo Personal allowlist",
    });
    if (unresolved.length > 0) {
      await prompter.note(
        `Could not resolve: ${unresolved.join(", ")}. Use numeric user ids or ensure openzca is available.`,
        "Zalo Personal allowlist",
      );
      continue;
    }
    const merged = [
      ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
      ...resolvedIds,
    ];
    const unique = [...new Set(merged)];
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          openzalo: {
            ...cfg.channels?.openzalo,
            enabled: true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      } as OpenClawConfig;
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
              dmPolicy: "allowlist",
              allowFrom: unique,
            },
          },
        },
      },
    } as OpenClawConfig;
  }
}

function setOpenzaloGroupPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  groupPolicy: "open" | "allowlist" | "disabled",
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        openzalo: {
          ...cfg.channels?.openzalo,
          enabled: true,
          groupPolicy,
        },
      },
    } as OpenClawConfig;
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
            groupPolicy,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function setOpenzaloGroupAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  groupKeys: string[],
): OpenClawConfig {
  const groups = Object.fromEntries(groupKeys.map((key) => [key, { allow: true }]));
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        openzalo: {
          ...cfg.channels?.openzalo,
          enabled: true,
          groups,
        },
      },
    } as OpenClawConfig;
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
            groups,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function setOpenzaloGroupsAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFromEntries: string[],
): OpenClawConfig {
  const account = resolveOpenzaloAccountSync({ cfg, accountId });
  const groups = account.config.groups ?? {};
  if (Object.keys(groups).length === 0) {
    return cfg;
  }

  const additions = allowFromEntries.map((entry) => entry.trim()).filter(Boolean);
  if (additions.length === 0) {
    return cfg;
  }

  const nextGroups = Object.fromEntries(
    Object.entries(groups).map(([groupKey, groupConfig]) => {
      const existingAllowFrom = (groupConfig.allowFrom ?? [])
        .map((entry) => String(entry).trim())
        .filter(Boolean);
      const allowFrom = [...new Set([...existingAllowFrom, ...additions])];
      return [
        groupKey,
        {
          ...groupConfig,
          allowFrom,
        },
      ];
    }),
  );

  return patchOpenzaloAccountConfig(cfg, accountId, { groups: nextGroups });
}

function patchOpenzaloAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        openzalo: {
          ...cfg.channels?.openzalo,
          enabled: true,
          ...patch,
        },
      },
    } as OpenClawConfig;
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
            ...patch,
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function resolveOpenzaloGroups(params: {
  cfg: OpenClawConfig;
  accountId: string;
  entries: string[];
}): Promise<Array<{ input: string; resolved: boolean; id?: string }>> {
  const account = resolveOpenzaloAccountSync({ cfg: params.cfg, accountId: params.accountId });
  const result = await runOpenzca(["group", "list", "-j"], {
    profile: account.profile,
    timeout: 15000,
  });
  if (!result.ok) {
    throw new Error(result.stderr || "Failed to list groups");
  }
  const groups = (parseJsonOutput<ZcaGroup[]>(result.stdout) ?? []).filter((group) =>
    Boolean(group.groupId),
  );
  const byName = new Map<string, ZcaGroup[]>();
  for (const group of groups) {
    const name = group.name?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const list = byName.get(name) ?? [];
    list.push(group);
    byName.set(name, list);
  }

  return params.entries.map((input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      return { input, resolved: false };
    }
    if (/^\d+$/.test(trimmed)) {
      return { input, resolved: true, id: trimmed };
    }
    const matches = byName.get(trimmed.toLowerCase()) ?? [];
    const match = matches[0];
    return match?.groupId
      ? { input, resolved: true, id: String(match.groupId) }
      : { input, resolved: false };
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zalo Personal",
  channel,
  policyKey: "channels.openzalo.dmPolicy",
  allowFromKey: "channels.openzalo.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.openzalo?.dmPolicy ?? "pairing") as "pairing",
  setPolicy: (cfg, policy) => setOpenzaloDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultOpenzaloAccountId(cfg);
    return promptOpenzaloAllowFrom({
      cfg: cfg,
      prompter,
      accountId: id,
    });
  },
};

export const openzaloOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const ids = listOpenzaloAccountIds(cfg);
    let configured = false;
    for (const accountId of ids) {
      const account = resolveOpenzaloAccountSync({ cfg: cfg, accountId });
      const isAuth = await checkZcaAuthenticated(account.profile);
      if (isAuth) {
        configured = true;
        break;
      }
    }
    return {
      channel,
      configured,
      statusLines: [`Zalo Personal: ${configured ? "logged in" : "needs QR login"}`],
      selectionHint: configured ? "recommended · logged in" : "recommended · QR login",
      quickstartScore: configured ? 1 : 15,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    // Check openzca is installed
    const openzcaInstalled = await checkOpenzcaInstalled();
    if (!openzcaInstalled) {
      await prompter.note(
        [
          "The `openzca` binary was not found in PATH.",
          "",
          "Install openzca, then re-run onboarding:",
          "Docs: https://openzca.com/",
        ].join("\n"),
        "Missing Dependency",
      );
      return { cfg, accountId: DEFAULT_ACCOUNT_ID };
    }

    const openzaloOverride = accountOverrides.openzalo?.trim();
    const defaultAccountId = resolveDefaultOpenzaloAccountId(cfg);
    let accountId = openzaloOverride ? normalizeAccountId(openzaloOverride) : defaultAccountId;

    if (shouldPromptAccountIds && !openzaloOverride) {
      accountId = await promptAccountId({
        cfg: cfg,
        prompter,
        label: "Zalo Personal",
        currentId: accountId,
        listAccountIds: listOpenzaloAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    const account = resolveOpenzaloAccountSync({ cfg: next, accountId });
    const alreadyAuthenticated = await checkZcaAuthenticated(account.profile);

    if (!alreadyAuthenticated) {
      await noteOpenzaloHelp(prompter);

      const wantsLogin = await prompter.confirm({
        message: "Login via QR code now?",
        initialValue: true,
      });

      if (wantsLogin) {
        await prompter.note(
          "A QR code will appear in your terminal.\nScan it with your Zalo app to login.",
          "QR Login",
        );

        // Run interactive login
        const result = await runOpenzcaInteractive(["auth", "login"], {
          profile: account.profile,
        });

        if (!result.ok) {
          await prompter.note(`Login failed: ${result.stderr || "Unknown error"}`, "Error");
        } else {
          const isNowAuth = await checkZcaAuthenticated(account.profile);
          if (isNowAuth) {
            await prompter.note("Login successful!", "Success");
          }
        }
      }
    } else {
      const keepSession = await prompter.confirm({
        message: "Zalo Personal already logged in. Keep session?",
        initialValue: true,
      });
      if (!keepSession) {
        await runOpenzcaInteractive(["auth", "logout"], { profile: account.profile });
        await runOpenzcaInteractive(["auth", "login"], { profile: account.profile });
      }
    }

    // Enable the channel
    if (accountId === DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          openzalo: {
            ...next.channels?.openzalo,
            enabled: true,
            profile: account.profile !== "default" ? account.profile : undefined,
          },
        },
      } as OpenClawConfig;
    } else {
      next = {
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
                profile: account.profile,
              },
            },
          },
        },
      } as OpenClawConfig;
    }

    if (forceAllowFrom) {
      next = await promptOpenzaloAllowFrom({
        cfg: next,
        prompter,
        accountId,
      });
    }

    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Zalo groups",
      currentPolicy: account.config.groupPolicy ?? "allowlist",
      currentEntries: Object.keys(account.config.groups ?? {}),
      placeholder: "Family, Work, 123456789",
      updatePrompt: Boolean(account.config.groups),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setOpenzaloGroupPolicy(next, accountId, accessConfig.policy);
      } else {
        let keys = accessConfig.entries;
        if (accessConfig.entries.length > 0) {
          try {
            const resolved = await resolveOpenzaloGroups({
              cfg: next,
              accountId,
              entries: accessConfig.entries,
            });
            const resolvedIds = resolved
              .filter((entry) => entry.resolved && entry.id)
              .map((entry) => entry.id as string);
            const unresolved = resolved
              .filter((entry) => !entry.resolved)
              .map((entry) => entry.input);
            keys = [...resolvedIds, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
            if (resolvedIds.length > 0 || unresolved.length > 0) {
              await prompter.note(
                [
                  resolvedIds.length > 0 ? `Resolved: ${resolvedIds.join(", ")}` : undefined,
                  unresolved.length > 0
                    ? `Unresolved (kept as typed): ${unresolved.join(", ")}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
                "Zalo groups",
              );
            }
          } catch (err) {
            await prompter.note(
              `Group lookup failed; keeping entries as typed. ${String(err)}`,
              "Zalo groups",
            );
          }
        }
        next = setOpenzaloGroupPolicy(next, accountId, "allowlist");
        next = setOpenzaloGroupAllowlist(next, accountId, keys);
      }
    }

    const groupAccessAccount = resolveOpenzaloAccountSync({ cfg: next, accountId });
    const effectiveGroupPolicyAfterAccess = groupAccessAccount.config.groupPolicy ?? "allowlist";
    const configuredGroups = groupAccessAccount.config.groups ?? {};
    const configuredGroupKeys = Object.keys(configuredGroups);
    const existingGroupAllowFrom = [
      ...new Set(
        Object.values(configuredGroups).flatMap((groupConfig) =>
          (groupConfig.allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean),
        ),
      ),
    ];
    if (effectiveGroupPolicyAfterAccess !== "disabled" && configuredGroupKeys.length > 0) {
      const restrictGroupSenders = await prompter.confirm({
        message: "Restrict sender IDs that can trigger replies in configured groups?",
        initialValue: existingGroupAllowFrom.length > 0,
      });
      if (restrictGroupSenders) {
        while (true) {
          const rawEntries = await prompter.text({
            message: "Group allowFrom (username or user id)",
            placeholder: "Alice, 123456789",
            initialValue:
              existingGroupAllowFrom.length > 0 ? existingGroupAllowFrom.join(", ") : undefined,
            validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
          });
          const parts = parseAllowFromEntries(String(rawEntries));
          const { resolved: resolvedIds, unresolved } = await resolveOpenzaloAllowFromEntries({
            profile: groupAccessAccount.profile,
            inputs: parts,
            prompter,
            noteTitle: "Zalo groups sender allowlist",
          });
          if (unresolved.length > 0) {
            await prompter.note(
              `Could not resolve: ${unresolved.join(", ")}. Use numeric user ids or ensure openzca is available.`,
              "Zalo groups sender allowlist",
            );
            continue;
          }
          if (resolvedIds.length === 0) {
            await prompter.note(
              "No valid sender IDs found. Enter at least one username or numeric user id.",
              "Zalo groups sender allowlist",
            );
            continue;
          }
          next = setOpenzaloGroupsAllowFrom(next, accountId, resolvedIds);
          break;
        }
      }
    }

    const advanced = resolveOpenzaloAccountSync({ cfg: next, accountId }).config;
    const effectiveGroupPolicy = advanced.groupPolicy ?? "allowlist";
    let groupRequireMention = advanced.groupRequireMention ?? true;
    let mentionFailureMode: OpenzaloGroupMentionDetectionFailureMode =
      advanced.groupMentionDetectionFailure ?? "deny";

    if (effectiveGroupPolicy !== "disabled") {
      groupRequireMention = await prompter.confirm({
        message: "Require @mention before replying in group chats?",
        initialValue: groupRequireMention,
      });
      next = patchOpenzaloAccountConfig(next, accountId, { groupRequireMention });

      if (groupRequireMention) {
        const allowOnDetectionFailure = await prompter.confirm({
          message: "If mention detection fails, still allow processing?",
          initialValue: mentionFailureMode !== "deny",
        });

        if (!allowOnDetectionFailure) {
          mentionFailureMode = "deny";
        } else {
          const warnOnFallback = await prompter.confirm({
            message: "Log warning when mention detection fallback is used?",
            initialValue: mentionFailureMode === "allow-with-warning",
          });
          mentionFailureMode = warnOnFallback ? "allow-with-warning" : "allow";
        }

        next = patchOpenzaloAccountConfig(next, accountId, {
          groupMentionDetectionFailure: mentionFailureMode,
        });
      }
    }

    const sendFailureNoticeCurrent = advanced.sendFailureNotice !== false;
    const sendFailureNotice = await prompter.confirm({
      message: "Send fallback error message when reply dispatch fails?",
      initialValue: sendFailureNoticeCurrent,
    });

    let sendFailureMessage =
      advanced.sendFailureMessage?.trim() || OPENZALO_DEFAULT_FAILURE_NOTICE_MESSAGE;
    if (sendFailureNotice) {
      const enteredMessage = await prompter.text({
        message: "Fallback error message text",
        placeholder: OPENZALO_DEFAULT_FAILURE_NOTICE_MESSAGE,
        initialValue: sendFailureMessage,
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      });
      sendFailureMessage = String(enteredMessage).trim();
    }

    next = patchOpenzaloAccountConfig(next, accountId, {
      sendFailureNotice,
      ...(sendFailureNotice ? { sendFailureMessage } : {}),
    });

    return { cfg: next, accountId };
  },
};
