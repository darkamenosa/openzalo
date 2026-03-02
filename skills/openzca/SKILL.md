---
name: openzca
description: Advanced Zalo operations through the openzca CLI for tasks not exposed by OpenZalo message actions (friend ops, advanced group admin, profile/account/cache management). Use only when explicitly requested.
metadata:
  {
    "openclaw":
      {
        "emoji": "🛠️",
        "requires": { "bins": ["openzca"], "config": ["channels.openzalo.enabled"] },
      },
  }
allowed-tools: ["exec"]
---

# openzca CLI

Use `openzca` for advanced operations that are not exposed through OpenZalo `message` actions.

## Safety

- Confirm before destructive operations:
  - friend remove/block
  - group transfer/disperse/block/unblock/review
  - auth logout/cache-clear
- For ambiguous targets (name/phone/group), resolve first with list/find commands.
- Prefer `--json` when parsing output in automation.

## Preflight

Check binary and login state first:

```bash
openzca --version
openzca --profile <profile> auth status
```

## Prefer OpenZalo Actions First

If the request can be handled by OpenZalo `message` actions, use those instead of raw CLI:

- send/read/react/edit/unsend
- renameGroup/addParticipant/removeParticipant/leaveGroup
- pin/unpin/list-pins
- member-info/list-group-members

Use raw `openzca` only for unsupported workflows.

## High-Value Advanced Commands

### Friend management

```bash
openzca --profile <profile> friend list --json
openzca --profile <profile> friend find "<query>" --json
openzca --profile <profile> friend add <userId>
openzca --profile <profile> friend accept <userId>
openzca --profile <profile> friend reject <userId>
openzca --profile <profile> friend remove <userId>
openzca --profile <profile> friend block <userId>
openzca --profile <profile> friend unblock <userId>
```

### Advanced group admin

```bash
openzca --profile <profile> group list --json
openzca --profile <profile> group info <groupId>
openzca --profile <profile> group create "<name>" <userId1> <userId2>
openzca --profile <profile> group settings <groupId> --help
openzca --profile <profile> group add-deputy <groupId> <userId>
openzca --profile <profile> group remove-deputy <groupId> <userId>
openzca --profile <profile> group transfer <groupId> <newOwnerId>
openzca --profile <profile> group pending <groupId> --json
openzca --profile <profile> group review <groupId> <userId> <approve|deny>
openzca --profile <profile> group disperse <groupId>
```

### Message flows not exposed in OpenZalo actions

```bash
openzca --profile <profile> msg sticker <threadId> <stickerId>
openzca --profile <profile> msg link <threadId> <url>
openzca --profile <profile> msg card <threadId> <contactId>
openzca --profile <profile> msg forward "<message>" <target1> <target2>
openzca --profile <profile> msg delete <msgId> <cliMsgId> <uidFrom> <threadId>
```

Add `--group` when operating on group threads.

### Profile/account/cache operations

```bash
openzca --profile <profile> me info --json
openzca --profile <profile> me update --help
openzca --profile <profile> me status <online|offline>
openzca --profile <profile> auth cache-info
openzca --profile <profile> auth cache-refresh
openzca --profile <profile> auth cache-clear
openzca account list
openzca account current
openzca account switch <name>
```

## Notes

- Prefer stable IDs (`userId`, `groupId`, `msgId`, `cliMsgId`) over names.
- Use `--help` on subcommands for exact flags before executing admin operations.
- If the user asks for repeated advanced workflows, consider adding a first-class OpenZalo action instead of repeated raw CLI calls.
