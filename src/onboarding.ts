import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  DmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  addWildcardAllowFrom,
  formatDocsLink,
  mergeAllowFromEntries,
  normalizeAccountId,
  promptAccountId,
} from "openclaw/plugin-sdk";
import {
  listOpenzaloAccountIds,
  resolveDefaultOpenzaloAccountId,
  resolveOpenzaloAccount,
} from "./accounts.js";
import { normalizeOpenzaloAllowEntry } from "./normalize.js";

const channel = "openzalo" as const;

function setOpenzaloDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
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
  };
}

function setOpenzaloAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        openzalo: {
          ...cfg.channels?.openzalo,
          allowFrom,
        },
      },
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
            allowFrom,
          },
        },
      },
    },
  };
}

function parseOpenzaloAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => normalizeOpenzaloAllowEntry(entry))
    .filter(Boolean);
}

async function promptOpenzaloAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultOpenzaloAccountId(params.cfg);
  const resolved = resolveOpenzaloAccount({ cfg: params.cfg, accountId });
  const existing = resolved.config.allowFrom ?? [];

  await params.prompter.note(
    [
      "Allowlist OpenZalo DM senders by user ID.",
      "Examples:",
      "- 123456789",
      "- 987654321",
      "Multiple entries: comma- or newline-separated.",
      `Docs: ${formatDocsLink("/channels/openzalo", "openzalo")}`,
    ].join("\n"),
    "OpenZalo allowlist",
  );

  const entry = await params.prompter.text({
    message: "OpenZalo allowFrom (user ids)",
    placeholder: "123456789, 987654321",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const parts = parseOpenzaloAllowFromInput(raw);
      if (parts.length === 0) {
        return "Invalid entries";
      }
      return undefined;
    },
  });

  const parts = parseOpenzaloAllowFromInput(String(entry));
  const unique = mergeAllowFromEntries(undefined, parts);
  return setOpenzaloAllowFrom(params.cfg, accountId, unique);
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "OpenZalo",
  channel,
  policyKey: "channels.openzalo.dmPolicy",
  allowFromKey: "channels.openzalo.allowFrom",
  getCurrent: (cfg) => cfg.channels?.openzalo?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setOpenzaloDmPolicy(cfg, policy),
  promptAllowFrom: promptOpenzaloAllowFrom,
};

function setOpenzaloProfileAndBinary(params: {
  cfg: OpenClawConfig;
  accountId: string;
  profile: string;
  zcaBinary: string;
}): OpenClawConfig {
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
          zcaBinary,
        },
      },
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
            zcaBinary,
          },
        },
      },
    },
  };
}

export const openzaloOnboardingAdapter: ChannelOnboardingAdapter = {
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
      quickstartScore: configured ? 1 : 0,
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
        defaultAccountId,
      });
    }

    const resolved = resolveOpenzaloAccount({ cfg, accountId });

    const profileInput = await prompter.text({
      message: "openzca profile",
      placeholder: accountId,
      initialValue: resolved.config.profile?.trim() || accountId,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const profile = String(profileInput).trim();

    const customBinary = await prompter.confirm({
      message: "Use custom openzca binary path?",
      initialValue: Boolean(
        resolved.config.zcaBinary?.trim() &&
          resolved.config.zcaBinary?.trim() !== "openzca",
      ),
    });

    let zcaBinary = resolved.config.zcaBinary?.trim() || "openzca";
    if (customBinary) {
      const binaryInput = await prompter.text({
        message: "openzca binary path",
        placeholder: "openzca",
        initialValue: zcaBinary,
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      });
      zcaBinary = String(binaryInput).trim();
    } else {
      zcaBinary = "openzca";
    }

    const next = setOpenzaloProfileAndBinary({
      cfg,
      accountId,
      profile,
      zcaBinary,
    });

    await prompter.note(
      [
        "Next steps:",
        `1. Login: openzca --profile ${profile} auth login`,
        "2. Restart gateway if needed.",
        "3. Send a DM to test pairing/access policy.",
        `Docs: ${formatDocsLink("/channels/openzalo", "openzalo")}`,
      ].join("\n"),
      "OpenZalo next steps",
    );

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      openzalo: { ...cfg.channels?.openzalo, enabled: false },
    },
  }),
};
