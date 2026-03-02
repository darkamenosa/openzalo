---
name: openzalo
description: OpenZalo operations via the message tool (channel=openzalo): send/read/edit/unsend/react, pins, group member actions, and member lookups. Use when users ask to control Zalo chats from OpenClaw.
metadata:
  {
    "openclaw":
      {
        "emoji": "💬",
        "requires": { "config": ["channels.openzalo.enabled"] },
      },
  }
allowed-tools: ["message"]
---

# OpenZalo (Via `message`)

Use the `message` tool with `channel: "openzalo"`.

## Musts

- Always set `channel: "openzalo"`.
- Prefer explicit targets:
  - DM: `user:<userId>` (or plain `<userId>`)
  - Group: `group:<groupId>`
- For message-specific actions (`react`, `edit`, `unsend`), provide `messageId`/`cliMsgId` when available.
- If refs are missing, run `action: "read"` first to get recent messages and references.

## Available Actions

- `send`
- `read`
- `react`
- `edit`
- `unsend`
- `renameGroup`
- `addParticipant`
- `removeParticipant`
- `leaveGroup`
- `pin`
- `unpin`
- `list-pins`
- `member-info`
- `list-group-members`

## Common Examples

Send message:

```json
{
  "action": "send",
  "channel": "openzalo",
  "to": "user:123456789",
  "message": "Hello from OpenClaw"
}
```

Read recent messages:

```json
{
  "action": "read",
  "channel": "openzalo",
  "to": "group:987654321",
  "limit": 20
}
```

React to message:

```json
{
  "action": "react",
  "channel": "openzalo",
  "to": "group:987654321",
  "messageId": "1234567890123456789",
  "reaction": "👍"
}
```

Edit message:

```json
{
  "action": "edit",
  "channel": "openzalo",
  "to": "user:123456789",
  "messageId": "1234567890123456789",
  "message": "Updated content"
}
```

Unsend message:

```json
{
  "action": "unsend",
  "channel": "openzalo",
  "to": "user:123456789",
  "messageId": "1234567890123456789"
}
```

Rename group:

```json
{
  "action": "renameGroup",
  "channel": "openzalo",
  "to": "group:987654321",
  "name": "Project Alpha"
}
```

Add/remove participants:

```json
{
  "action": "addParticipant",
  "channel": "openzalo",
  "to": "group:987654321",
  "participantIds": ["111", "222"]
}
```

```json
{
  "action": "removeParticipant",
  "channel": "openzalo",
  "to": "group:987654321",
  "participantIds": ["111"]
}
```

Pins:

```json
{
  "action": "pin",
  "channel": "openzalo",
  "to": "group:987654321"
}
```

```json
{
  "action": "list-pins",
  "channel": "openzalo"
}
```

Member lookups:

```json
{
  "action": "member-info",
  "channel": "openzalo",
  "userId": "123456789"
}
```

```json
{
  "action": "list-group-members",
  "channel": "openzalo",
  "groupId": "987654321"
}
```

## Notes

- `list-group-members` works best with group context; otherwise pass `groupId`.
- `member-info` only needs `userId` (do not pass `to`).
- `react` currently supports adding reaction, not removing.
- Group policy and action gates may block some actions based on `channels.openzalo.*` config.

