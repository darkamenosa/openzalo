---
name: openzalo
description: Use when users ask to control Zalo chats from OpenClaw through the OpenZalo message tool, including text or media sends, reads, edits, unsends, reactions, pins, group member actions, and member lookups.
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
- For media sends, keep `action: "send"` and provide exactly one of `mediaPath` or `mediaUrl`.
- `.mp4` sends use native video delivery under the hood. If you also provide `message`, that caption stays attached to the video instead of being sent as a second text message.
- Group `send` supports native Zalo mentions in group chats: plain `@Name` or `@userId` in `message` is resolved by `openzca` into a real mention.
- For native mentions, do not guess. Only tag when you already have an exact unique member id or name from context or the user.
- If exact member identity is missing, switch to the bundled `openzca` skill and resolve the group member list there before sending the mention.
- Poll workflows are not exposed as OpenZalo `message` actions. If the user asks to create, inspect, vote on, close, or share a Zalo poll, switch to the bundled `openzca` skill.
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

## Not Exposed Here

Use the bundled `openzca` skill instead for:

- group poll create/detail/vote/lock/share
- friend management beyond `message` actions
- advanced profile/account/cache workflows

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

Send group message with native mentions:

```json
{
  "action": "send",
  "channel": "openzalo",
  "to": "group:987654321",
  "message": "Hi @Alice Nguyen and @123456789"
}
```

Send video from a local file with inline caption:

```json
{
  "action": "send",
  "channel": "openzalo",
  "to": "user:123456789",
  "message": "Please review this clip",
  "mediaPath": "/absolute/path/demo.mp4"
}
```

Send media from a URL:

```json
{
  "action": "send",
  "channel": "openzalo",
  "to": "group:987654321",
  "message": "Reference file",
  "mediaUrl": "https://example.com/demo.mp4"
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

## Notes

- `send` supports plain text and single-attachment media sends through `mediaPath` or `mediaUrl`.
- Video requests can stay on the OpenZalo `message` tool. `.mp4` sends preserve the caption on the video message itself.
- Native group mentions require an exact unique member id or name already known from context or provided by the user.
- Do not guess mentions.
- If exact member identity is missing, use the bundled `openzca` skill to resolve `group members` first, then send the native mention.
- Poll requests should be handled through the bundled `openzca` skill, not the `message` tool.
- `member-info` only needs `userId` (do not pass `to`).
- `react` currently supports adding reaction, not removing.
- Group `send` mention resolution fails on ambiguous member names instead of guessing.
- Group policy and action gates may block some actions based on `channels.openzalo.*` config.
