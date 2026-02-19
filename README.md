# OpenZalo (newopenzalo)

OpenClaw channel plugin for personal Zalo accounts via `openzca` CLI.

## What is implemented

- Multi-account channel scaffold (`channels.openzalo.accounts.*`)
- Auth integration via `openzca auth login` and `auth logout`
- Outbound:
  - DM text
  - Group text (`group:<groupId>` target)
  - Media/file send (auto routes to `msg voice`/`msg image`/`msg video`/`msg upload`, supports local path + URL)
- Inbound monitor pipeline (`openzca listen --raw --keep-alive`):
  - Normalize message payload
  - Debounce/coalesce rapid multi-event inbound messages per sender+thread (merge text/media/mentions before routing)
  - Enforce DM/group security policies
  - Mention/command gating
  - Dispatch replies through OpenClaw runtime
- Directory helpers:
  - Self (`me info --json`)
  - Peers (`friend list --json`)
  - Groups (`group list --json`)
- Status probe via `openzca auth status`
- Message actions:
  - `react`, `read`, `edit`, `unsend`
  - `renameGroup`, `addParticipant`, `removeParticipant`, `leaveGroup`
  - `pin`, `unpin`, `list-pins`, `member-info`
- Typing indicator on reply start (`sendTypingIndicators`, enabled by default)

## Config

```json
{
  "channels": {
    "openzalo": {
      "enabled": true,
      "profile": "default",
      "zcaBinary": "openzca",
      "dmPolicy": "pairing",
      "allowFrom": ["<OWNER_USER_ID>"],
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["<GROUP_ID>"],
      "mediaLocalRoots": [
        "/Users/<you>/.openclaw/workspace",
        "/Users/<you>/.openclaw/media"
      ],
      "sendTypingIndicators": true,
      "actions": {
        "reactions": true,
        "messages": true,
        "groups": true,
        "pins": true,
        "memberInfo": true
      },
      "groups": {
        "<GROUP_ID>": {
          "requireMention": true,
          "allowFrom": ["<ALLOWED_SENDER_ID>"],
          "tools": {
            "allow": ["group:messaging"],
            "deny": ["group:fs", "group:runtime"]
          },
          "toolsBySender": {
            "<OWNER_USER_ID>": {
              "allow": ["group:runtime", "group:fs"]
            }
          }
        }
      }
    }
  }
}
```

## Target format

- DM target: `<userId>`
- Group target: `group:<groupId>`
- Group aliases accepted: `g-<groupId>`, `g:<groupId>`

`group:` prefix is important so outbound uses `--group` when calling `openzca`.

## Notes

- Requires `openzca` available in `PATH` (or set `channels.openzalo.zcaBinary`).
- This extension is designed around `openzca` streaming JSON payloads from `listen --raw`.
- Local outbound media paths must resolve under allowed roots (safe defaults under `~/.openclaw/*`; extend with `channels.openzalo.mediaLocalRoots` or per-account `mediaLocalRoots`).
- Group control commands are authorized only for explicit allowlists (`channels.openzalo.allowFrom` or `channels.openzalo.groups.<groupId>.allowFrom`) when `commands.useAccessGroups` is enabled (default).
- Group `requireMention` checks both mention text patterns and explicit `mentionIds` from `openzca`.
- Inbound self echoes are dropped (`senderId == selfId` or `senderId == "0"`) to avoid reply loops.
