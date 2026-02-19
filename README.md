# @openclaw/openzalo

OpenClaw channel plugin for Zalo personal accounts via `openzca` CLI.

> Warning: this is an unofficial personal-account automation integration. Use at your own risk.

## AI Install Metadata

- Plugin id: `openzalo`
- Channel id: `openzalo`
- Package name: `@openclaw/openzalo`
- Required external binary: `openzca`

## Prerequisites

- OpenClaw Gateway is installed and running.
- `openzca` is installed and available in `PATH` (or configure `channels.openzalo.zcaBinary`).
- You can authenticate with your Zalo account on the gateway machine.

Example direct login with `openzca`:

```bash
openzca --profile default auth login
```

## Install (local checkout)

From the OpenClaw repo root:

```bash
openclaw plugins install ./extensions/openzalo
```

Or from this plugin directory:

```bash
openclaw plugins install .
```

Restart Gateway after installation.

## Quick Start

1. Login account for this channel:

```bash
openclaw channels login --channel openzalo
# optional multi-account
openclaw channels login --channel openzalo --account work
```

2. Add channel config:

```json5
{
  channels: {
    openzalo: {
      enabled: true,
      profile: "default",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      groupAllowFrom: ["<GROUP_ID>"],
    },
  },
}
```

3. Send test message:

```bash
openclaw message send --channel openzalo --target <userId> --message "Hello from OpenClaw"
openclaw message send --channel openzalo --target group:<groupId> --message "Hello group"
```

## Configuration

```json5
{
  channels: {
    openzalo: {
      enabled: true,
      profile: "default", // default: account id
      zcaBinary: "openzca", // or full path

      // DM access: pairing | allowlist | open | disabled
      dmPolicy: "pairing",
      allowFrom: ["<OWNER_USER_ID>"],

      // Group access: allowlist | open | disabled
      groupPolicy: "allowlist",
      groupAllowFrom: ["<GROUP_ID>"],

      // Optional per-group overrides
      groups: {
        "<GROUP_ID>": {
          enabled: true,
          requireMention: true, // default true
          allowFrom: ["<ALLOWED_SENDER_ID>"],
          tools: {
            allow: ["group:messaging"],
            deny: ["group:fs", "group:runtime"],
          },
          toolsBySender: {
            "<OWNER_USER_ID>": { allow: ["group:runtime", "group:fs"] },
          },
          skills: ["skill-id"],
          systemPrompt: "Custom prompt for this group.",
        },
      },

      historyLimit: 12,
      textChunkLimit: 1800,
      chunkMode: "length", // length | newline
      blockStreaming: false,

      mediaLocalRoots: [
        "/Users/<you>/.openclaw/workspace",
        "/Users/<you>/.openclaw/media",
      ],
      sendTypingIndicators: true,

      actions: {
        reactions: true,
        messages: true, // read/edit/unsend
        groups: true, // rename/add/remove/leave
        pins: true, // pin/unpin/list-pins
        memberInfo: true,
      },
    },
  },
}
```

## Multi-Account

`channels.openzalo.accounts.<accountId>` overrides top-level fields:

```yaml
channels:
  openzalo:
    enabled: true
    accounts:
      default:
        profile: default
      work:
        profile: work
        enabled: true
```

Profile resolution is per account. If `zcaBinary` is not set, plugin uses:

1. `channels.openzalo[.accounts.<id>].zcaBinary`
2. `OPENZCA_BINARY` env var
3. `openzca`

## Target Format

- DM target: `<userId>`
- Group target: `group:<groupId>`
- Also accepted: `g-<groupId>`, `g:<groupId>`

Use `group:` for explicit group sends.

## Notes

- Inbound listener uses `openzca listen --raw --keep-alive`.
- Group messages require mention by default (`requireMention: true`) unless overridden.
- Pairing mode sends approval code for unknown DM senders.
- Local media is restricted to allowed roots for safety.

Default safe media roots (under `OPENCLAW_STATE_DIR` or `~/.openclaw`):

- `workspace`
- `media`
- `agents`
- `sandboxes`

## Troubleshooting

- `openzca not found`: install `openzca` or set `channels.openzalo.zcaBinary`.
- Auth check fails: run `openclaw channels login --channel openzalo` (or `openzca --profile <id> auth login`).
- Group message dropped: verify `groupPolicy`, `groupAllowFrom`, and `groups.<groupId>` allowlist.
- Local media blocked: add absolute paths to `channels.openzalo.mediaLocalRoots`.
