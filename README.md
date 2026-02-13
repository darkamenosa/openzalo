# @openclaw/openzalo

OpenClaw extension for Zalo Personal Account messaging via [openzca](https://openzca.com/).

> **Warning:** Using Zalo automation may result in account suspension or ban. Use at your own risk. This is an unofficial integration.

## Features

- **Always-On Gateway Listener**: Uses `openzca listen -r -k` with auto-restart on listener failures.
- **Reply Messaging**: End-to-end inbound -> agent -> outbound reply flow for direct and group chats.
- **Per-Chat Reply Ordering**: Messages are processed sequentially per conversation to avoid collapsing queued replies.
- **Typing Indicator**: Sends typing events while OpenClaw is processing/replying.
- **Media Sending**: Supports image/video/voice style media send via `openzca msg <type> -u <url-or-path>`.
- **Group Reply Modes**: Supports open groups and mention-required groups (`groupRequireMention`), with group allowlist policy support.
- **Recent Group Context**: In mention-required groups, the bot loads recent group messages on-demand before replying to a tagged turn.
- **Human Pass Mode**: `human pass on/off` to pause/resume bot replies per chat while still ingesting messages for context.
- **Failure Notice Fallback**: Optional user-facing fallback message when reply dispatch fails.
- **Interactive Message Actions**: Supports OpenClaw actions (`send`, `read`, `react`, `edit`, `unsend`, `delete`, `pin`, `unpin`, `list-pins`, `member-info`) using `openzca` commands.
- **Live Directory Queries**: `listPeersLive`/`listGroupsLive` adapters return fresh contact/group data on each query.
- **Config-Driven Outbound Limits**: Supports `textChunkLimit`, `chunkMode`, and `mediaMaxMb` with account-level overrides.
- **Multi-Account Support**: Manage multiple Zalo personal accounts.
- **Agent Tool**: AI agent integration for messaging and directory/status actions.

## Feature Matrix

| Capability | `zalouser` baseline | `openzalo` |
|---|---|---|
| Always-on listener | Yes | Yes |
| Reply text message | Yes | Yes |
| Typing indicator during thinking | Usually missing | Yes |
| Error notice on reply failure | Often silent | Yes (`sendFailureNotice`) |
| Send files/media (image/video/voice/link) | Yes | Yes |
| Group reply all messages | Yes | Yes (configurable) |
| Group mention-required mode | Inconsistent by setup | Yes (`groupRequireMention`) |
| Human pass (pause bot replies) | No | Yes |
| Keep ingesting context while paused/untagged | Partial | Yes |
| Interactive actions (`send/read/react/edit/unsend/delete/pin/unpin/list-pins/member-info`) | Limited | Yes |
| Live directory refresh (`listPeersLive` / `listGroupsLive`) | Limited | Yes |
| Config-driven limits (`textChunkLimit`, `chunkMode`, `mediaMaxMb`) | Partial | Yes |
| Backend compatibility with `openzca` | Yes | Yes |

## Prerequisites

Install `openzca` and ensure it's in your PATH:

**macOS / Linux:**

```bash
npm i -g openzca

# Or install via official installer script
curl -fsSL https://openzca.com/install.sh | bash
```

**Windows (PowerShell):**

```powershell
# Install via official installer script
irm https://openzca.com/install.ps1 | iex
```

### Run without install

```bash
npx openzca --help
```

See [openzca docs](https://openzca.com/) for installation and usage details.

## Quick Start

### Option 1: Onboarding Wizard (Recommended)

```bash
openclaw onboard
# Select "Zalo Personal" from channel list
# Follow QR code login flow
```

### Option 2: Login (QR, on the Gateway machine)

```bash
openclaw channels login --channel openzalo
# Scan QR code with Zalo app
```

### Send a Message

```bash
openclaw message send --channel openzalo --target <threadId> --message "Hello from OpenClaw!"
```

## Configuration

After onboarding, your config will include:

```yaml
channels:
  openzalo:
    enabled: true
    dmPolicy: pairing # pairing | allowlist | open | disabled
    groupRequireMention: true # require @mention in group chats
    groupMentionDetectionFailure: deny # allow | deny | allow-with-warning
    historyLimit: 50 # max recent group messages loaded for context on tagged turns
    sendFailureNotice: true # send fallback message on dispatch failure
    sendFailureMessage: Some problem occurred, could not send a reply.
    textChunkLimit: 2000 # max supported by openzca/openzalo
    chunkMode: length # length | newline
    mediaMaxMb: 50 # outbound media limit
    actions:
      messages: true # read/delete/unsend
      reactions: true # react
```

For multi-account:

```yaml
channels:
  openzalo:
    enabled: true
    defaultAccount: default
    accounts:
      default:
        enabled: true
        profile: default
      work:
        enabled: true
        profile: work
```

### Default Behavior (When `channels.openzalo` Is Missing)

If plugin `openzalo` is enabled but `channels.openzalo` is not set in config, runtime defaults are:

- `dmPolicy: pairing`
- `groupPolicy: open`
- `groupRequireMention: true`
- `groupMentionDetectionFailure: deny`
- `sendFailureNotice: true`
- `historyLimit: 50`

Behavior summary:

- Direct chat (DM): unknown users do not get normal bot replies; they receive pairing flow first.
- Group chat: bot replies only when explicitly mentioned.
- Group chat context: when mention is required, the bot fetches recent group messages and includes up to `historyLimit` entries before replying.
- Mention detection: uses structured mention IDs from inbound payload (`mentionIds` / `mentions[].uid`) matched against bot user id.
- If mention detection is unavailable while mention is required: message is denied by default.
- Authorized control commands can bypass mention gating.

Recommended explicit config (to avoid cross-machine ambiguity):

```yaml
channels:
  openzalo:
    dmPolicy: pairing
    groupPolicy: open
    groupRequireMention: true
    groupMentionDetectionFailure: deny
```

## Commands

### Authentication

```bash
openclaw channels login --channel openzalo              # Login via QR
openclaw channels login --channel openzalo --account work
openclaw channels status --probe
openclaw channels logout --channel openzalo
```

### Directory (IDs, contacts, groups)

```bash
openclaw directory self --channel openzalo
openclaw directory peers list --channel openzalo --query "name"
openclaw directory groups list --channel openzalo --query "work"
openclaw directory groups members --channel openzalo --group-id <id>
```

### Account Management

```bash
openzca account list      # List all profiles
openzca account current   # Show active profile
openzca account switch <profile>
openzca account remove <profile>
openzca account label <profile> "Work Account"
```

### Messaging

```bash
# Text
openclaw message send --channel openzalo --target <threadId> --message "message"

# Media (URL or file path supported by openzca -u)
openclaw message send --channel openzalo --target <threadId> --message "caption" --media-url "https://example.com/img.jpg"

# Video/voice are auto-detected by extension in openzalo send helpers
# (e.g. .mp4 -> video, .mp3/.wav/.ogg/.m4a -> voice)
```

### Human Pass Mode

Human pass mode lets a human take over the conversation temporarily.

- `human pass on`: bot stops replying in that chat/session.
- `human pass off`: bot resumes replying in that chat/session.
- While enabled, inbound messages are still ingested into session context.
- In groups with mention-required mode, untagged messages are still recorded for context, but bot replies remain mention-gated.

### Listener

The listener runs inside the Gateway when the channel is enabled. For debugging,
use `openclaw channels logs --channel openzalo` or run `openzca listen` directly.

### Data Access

```bash
# Friends
openzca friend list
openzca friend list -j    # JSON output
openzca friend find "name"
openzca friend online

# Groups
openzca group list
openzca group info <groupId>
openzca group members <groupId>

# Profile
openzca me info
openzca me id
```

## Multi-Account Support

Use `--profile` or `-p` to work with multiple accounts:

```bash
openclaw channels login --channel openzalo --account work
openclaw message send --channel openzalo --account work --target <id> --message "Hello"
openzca --profile work listen
```

Profile resolution order: CLI `--profile` flag > default profile.

## Agent Tool

The extension registers a `openzalo` tool for AI agents:

```json
{
  "action": "send",
  "threadId": "123456",
  "message": "Hello from AI!",
  "isGroup": false,
  "profile": "default"
}
```

Available actions: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`

## Troubleshooting

- **Login Issues:** Run `openzca auth logout` then `openzca auth login`
- **API Errors:** Try `openzca auth cache-refresh` or re-login
- **File Uploads:** Check size (max 100MB) and path accessibility

## Credits

Built on [openzca](https://openzca.com/) which uses [zca-js](https://github.com/RFS-ADRENO/zca-js).
