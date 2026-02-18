# @openclaw/openzalo

OpenClaw extension for Zalo Personal messaging via [openzca](https://openzca.com/).

Warning: this is an unofficial automation integration. Using automation with Zalo may risk account restrictions.

## What the extension provides

This package registers both:

- Channel plugin `openzalo` (onboarding, auth, gateway listener, directory, message actions, status)
- Agent tool `openzalo` (direct tool actions for send/query/status)

## Implemented behavior (from code)

- Listener process: runs `openzca listen -r -k`, parses JSON lines, and auto-restarts in 5 seconds on listener failure.
- Inbound dedupe: suppresses duplicate inbound events within a TTL window.
- Reply pipeline: inbound -> OpenClaw reply dispatcher -> outbound text/media delivery.
- Typing signals: sends `msg typing` while generating replies (throttled per chat).
- Text chunking: markdown-aware chunking with configurable `textChunkLimit`/`chunkMode`.
- Media send:
  - Image/video/audio sent with matching openzca subcommands.
  - Generic files use `msg upload`.
  - Optional local file-size precheck using `mediaMaxMb`.
- Group context preload: recent group messages are auto-injected into context when enabled.
- Adaptive history expansion: context window expands for quote/context-dependent turns.
- Mention gating in groups: supports required mention mode with failure strategy.
- Human pass mode: `human pass on|off` (also accepts `humanpass` and `bot on|off`).
- Failure notice fallback: optional user-facing message when dispatch fails and no reply was sent.
- Message-action support: `send`, `read`, `react`, `edit`, `delete`, `unsend`, `pin`, `unpin`, `list-pins`, `member-info`.
- Unsend recovery flow for channel actions: resolves IDs from reply context, in-memory undo cache, or recent messages.
- Dedicated `openzalo` tool actions: `send`, `unsend`, `image`, `link`, `friends`, `groups`, `group-members`, `me`, `status`.
- Multi-account support with per-account override config.

## Prerequisites

Install `openzca` and make sure it is in `PATH`:

```bash
npm i -g openzca
# or installer script from https://openzca.com/
```

Optional environment variables used by this extension:

- `OPENZCA_BINARY`: custom openzca binary name/path (default: `openzca`)
- `OPENZCA_PROFILE` / `ZCA_PROFILE`: default profile for openzca commands

## Quick start

```bash
openclaw onboard
# choose "Zalo Personal"
```

or login directly:

```bash
openclaw channels login --channel openzalo
```

## Target formats

Preferred thread targets:

- `user:<id>`
- `group:<id>`

Also accepted:

- `u-<id>` / `g-<id>`
- `openzalo:user:<id>` / `openzalo:group:<id>`
- bare numeric IDs (ambiguous without `isGroup` in some action paths)

## Configuration

Example:

```yaml
channels:
  openzalo:
    enabled: true

    # account/profile
    profile: default
    defaultAccount: default

    # direct message access
    dmPolicy: pairing # pairing | allowlist | open | disabled
    allowFrom: ["123456789"]

    # group access
    groupPolicy: allowlist # allowlist | open | disabled
    groupRequireMention: true
    groupMentionDetectionFailure: deny # allow | deny | allow-with-warning
    groups:
      "5316386947725214403":
        allow: true
        enabled: true
        requireMention: true # per-group override
        allowFrom: ["123456789"] # optional sender gate
        tools:
          deny: ["message", "openzalo"]
        toolsBySender:
          "123456789":
            alsoAllow: ["message", "openzalo"]

    # reply behavior
    historyLimit: 6
    sendFailureNotice: true
    sendFailureMessage: Some problem occurred, could not send a reply.

    # outbound limits
    textChunkLimit: 2000
    chunkMode: length # length | newline
    mediaMaxMb: 50

    # action gating
    actions:
      messages: true
      reactions: true

    # optional multi-account overrides
    accounts:
      work:
        enabled: true
        profile: work
        dmPolicy: allowlist
        allowFrom: ["987654321"]
```

`historyLimit` fallback order:

1. `channels.openzalo[.accounts.<id>].historyLimit`
2. `messages.groupChat.historyLimit`
3. built-in default `6`

Set `historyLimit: 0` to disable group recent-history preload.

## Access-control semantics

DM policy:

- `pairing` (default): unknown senders receive pairing flow; only approved senders can trigger replies.
- `allowlist`: only `allowFrom` senders can trigger replies.
- `open`: any sender can trigger replies.
- `disabled`: no DM replies.

Group policy:

- `allowlist` (default): only configured groups are processed.
- `open`: any group can be processed.
- `disabled`: group replies disabled.

Group sender restriction:

- `groups.<group>.allowFrom` restricts who can trigger replies in that group.
- Using `"*"` in group `allowFrom` is treated as insecure and is surfaced in status warnings.

## Human pass mode

Per session/chat control commands:

- `human pass on`
- `human pass off`

Aliases accepted by parser:

- `/human pass on|off`
- `humanpass on|off`
- `bot on|off`

When enabled, inbound messages are still ingested for context, but bot replies are skipped.

## Message actions (channel)

Available action set depends on `actions.messages` / `actions.reactions`:

- Always: `send`
- When `actions.messages` is enabled (default): `read`, `edit`, `delete`, `unsend`, `pin`, `unpin`, `list-pins`, `member-info`
- When `actions.reactions` is enabled (default): `react`

`unsend` action in channel path supports fallback ID recovery from:

1. explicit params / reply IDs
2. cached undo refs from recent sends
3. recent message scan in target thread

## Dedicated `openzalo` agent tool

Tool name: `openzalo`

Supported actions:

- `send`: text or media/file (`media`/`path`/`filePath`)
- `unsend`: requires `msgId` + `cliMsgId`
- `image`, `link`
- `friends`, `groups`, `group-members`
- `me`, `status`

Example:

```json
{
  "action": "send",
  "threadId": "group:5316386947725214403",
  "message": "Hello",
  "isGroup": true,
  "profile": "default"
}
```

## Directory and auth operations

Implemented in channel plugin:

- Directory: self, peers, groups, group members
- Auth: login via QR, login-with-QR start/wait API, logout
- Pairing approval notification message

## Status and diagnostics

Account snapshots include:

- runtime state: `running`, `lastStartAt`, `lastStopAt`, `lastError`
- activity: `lastInboundAt`, `lastOutboundAt`
- counters: `dispatchFailures`, `typingFailures`, `textChunkFailures`, `mediaFailures`, `failureNoticesSent`, `failureNoticeFailures`, `humanPassSkips`

Status issue collector flags misconfiguration such as:

- missing `openzca` binary
- unauthenticated account
- unsafe DM/group policy combinations
- empty allowlist for `groupPolicy: allowlist`
- wildcard group `allowFrom`
- disabled failure notices

## Development

```bash
npm install
npm run typecheck
```

Key files:

- `index.ts`: plugin registration
- `src/channel.ts`: channel plugin, actions, auth, directory, gateway hooks
- `src/monitor.ts`: listener loop + inbound processing + reply dispatch
- `src/send.ts`: openzca command wrappers for send/action operations
- `src/tool.ts`: dedicated agent tool schema and executor
- `src/config-schema.ts`: config validation schema

## Credits

Built on [openzca](https://openzca.com/) and [zca-js](https://github.com/RFS-ADRENO/zca-js).
