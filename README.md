# @openclaw/openzalo

OpenClaw channel plugin for Zalo personal accounts via `openzca` CLI.

> Warning: this is an unofficial personal-account automation integration. Use at your own risk.

## AI Install Metadata

- Plugin id: `openzalo`
- Channel id: `openzalo`
- Package name: `@openclaw/openzalo`
- Required external binary: `openzca`
- Optional external binary for `/acp` support: `acpx`

## Bundled Skills

This plugin now bundles optional skills (auto-discovered from `./skills`):

- `openzalo`: action playbook for OpenZalo via `message` tool.
- `openzca`: advanced `openzca` CLI workflows for tasks not yet exposed as OpenZalo actions.

### Owner/Admin Usage Guidance for `openzca` Skill

`openzca` is installed at workspace/plugin level, not per-sender.  
So "owner-only" should be enforced by runtime policy, not by skill installation.

Recommended setup:

1. Keep general agents on `tools.profile: "messaging"` (no `exec`).
2. Grant `exec` only to a dedicated admin agent.
3. In OpenZalo group config, use `allowFrom` + `skills` filter to expose advanced skills only in admin-controlled groups.
4. Use `openzalo` skill/actions for normal operations; reserve `openzca` for explicit advanced/admin tasks.

## Prerequisites

- OpenClaw Gateway is installed and running.
- `openzca` is installed and available in `PATH` (or configure `channels.openzalo.zcaBinary`).
- If you want OpenZalo ACP-local sessions via `/acp`, install `acpx` too.
- You can authenticate with your Zalo account on the gateway machine.

Example direct login with `openzca`:

```bash
openzca --profile default auth login
```

Example `acpx` install for `/acp` support:

```bash
npm i -g acpx
```

Verify:

```bash
which acpx
acpx --help
```

## Install (npm)

Use this after `@openclaw/openzalo` is approved/published to npm:

```bash
openclaw plugins install @openclaw/openzalo
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

Or via CLI:

```bash
openclaw channels add --channel openzalo --account default
```

3. Send test message:

```bash
openclaw message send --channel openzalo --target <userId> --message "Hello from OpenClaw"
openclaw message send --channel openzalo --target group:<groupId> --message "Hello group"
openclaw message send --channel openzalo --target group:<groupId> --message "Hi @Alice Nguyen and @123456789"
```

For group sends, plain `@Name` and `@userId` are forwarded to `openzca` and become native Zalo mentions.
For native mentions, do not guess. Only tag when you already have an exact unique member id or name from context or from the user.

## ACPX (`/acp`) Support

This plugin can bind the current OpenZalo conversation to a local ACPX session without changing OpenClaw core.

Install `acpx` first:

```bash
npm i -g acpx
```

If the gateway service cannot see your shell `PATH`, set `channels.openzalo.acpx.command` to the absolute path from `which acpx`.

Example config:

```json5
{
  channels: {
    openzalo: {
      acpx: {
        enabled: true,
        command: "/full/path/to/acpx", // or "acpx" if PATH is correct
        agent: "claude", // e.g. claude | codex
        cwd: "/Users/<you>/.openclaw/workspace",
        permissionMode: "approve-all", // approve-all | approve-reads | deny-all
        nonInteractivePermissions: "fail", // fail | deny
      },
    },
  },
}
```

Notes:

- `agent` is the ACPX agent id. For Claude Code, use `claude`. For Codex, use `codex`.
- `cwd` is the working directory ACPX will use for that conversation.
- `command` should be an absolute path if `/acp on` reports `acpx command not found`.

Supported OpenZalo ACP commands:

```text
/acp status
/acp on
/acp on claude cwd=/Users/<you>/.openclaw/workspace
/acp reset
/acp off
```

Behavior:

- `/acp on` binds the current conversation to a persistent ACPX session.
- `/acp status` shows whether the conversation is bound and reports session status.
- `/acp reset` recreates the ACPX session for the current conversation.
- `/acp off` unbinds the conversation and closes the ACPX session.

## Configuration

```json5
{
  channels: {
    openzalo: {
      enabled: true,
      profile: "default", // default: account id
      zcaBinary: "openzca", // or full path
      acpx: {
        enabled: true,
        command: "/full/path/to/acpx", // or "acpx" if PATH is correct
        agent: "claude", // e.g. claude | codex
        cwd: "/Users/<you>/.openclaw/workspace",
        permissionMode: "approve-all", // approve-all | approve-reads | deny-all
        nonInteractivePermissions: "fail", // fail | deny
      },

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
      dmHistoryLimit: 12, // optional (schema-supported)
      textChunkLimit: 1800,
      chunkMode: "length", // length | newline
      blockStreaming: false,
      mediaMaxMb: 25, // optional (schema-supported)
      markdown: {}, // optional (schema-supported)

      mediaLocalRoots: [
        "/Users/<you>/.openclaw/workspace",
        "/Users/<you>/.openclaw/media",
      ],
      sendTypingIndicators: true,

      threadBindings: {
        enabled: true,
        spawnSubagentSessions: true,
        ttlHours: 24,
      },

      actions: {
        reactions: true,
        messages: true, // read/edit/unsend
        groups: true, // rename/add/remove/leave
        pins: true, // pin/unpin/list-pins
        memberInfo: true, // member-info
        groupMembers: true, // reserved
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
    defaultAccount: default
    accounts:
      default:
        profile: default
        acpx:
          enabled: true
          command: /full/path/to/acpx
          agent: claude
          cwd: /Users/<you>/.openclaw/workspace
      work:
        profile: work
        enabled: true
```

Profile resolution is per account. If `zcaBinary` is not set, plugin uses:

1. `channels.openzalo[.accounts.<id>].zcaBinary`
2. `OPENZCA_BINARY` env var
3. `openzca`

If `acpx` is not set, OpenZalo ACP-local uses:

1. `channels.openzalo[.accounts.<id>].acpx.command`
2. `OPENZALO_ACPX_COMMAND` env var
3. `acpx`

## Target Format

- DM target: `<userId>`
- Group target: `group:<groupId>`
- Also accepted for groups: `g-<groupId>`, `g:<groupId>`
- Also accepted for DM/user targets: `user:<userId>`, `dm:<userId>`, `u:<userId>`, `u-<userId>`
- Channel prefixes like `openzalo:<target>` and `ozl:<target>` are normalized automatically.
- Legacy `zlu:<target>` remains accepted for backward compatibility.

Use `group:` for explicit group sends.

## Notes

- Inbound listener uses `openzca listen --raw --keep-alive`.
- Group messages require mention by default (`requireMention: true`) unless overridden.
- Authorized slash/bang control commands can still be processed in groups when access policy allows.
- Pairing mode sends approval code for unknown DM senders.
- Subagent session binding controls use `channels.openzalo.threadBindings.*` (or per-account overrides).
- Local media is restricted to allowed roots for safety.

Default safe media roots (under `OPENCLAW_STATE_DIR` or `CLAWDBOT_STATE_DIR`, fallback `~/.openclaw`):

- `workspace`
- `media`
- `agents`
- `sandboxes`

## Troubleshooting

- `openzca not found`: install `openzca` or set `channels.openzalo.zcaBinary`.
- `acpx command not found`: install `acpx` (for example `npm i -g acpx`) or set `channels.openzalo.acpx.command` to the absolute `acpx` path.
- Auth check fails: run `openclaw channels login --channel openzalo` (or `openzca --profile <id> auth login`).
- Group message dropped: verify `groupPolicy`, `groupAllowFrom`, and `groups.<groupId>` allowlist.
- Group message dropped with allowlist configured: check `requireMention` and mention detection.
- Local media blocked: add absolute paths to `channels.openzalo.mediaLocalRoots`.
