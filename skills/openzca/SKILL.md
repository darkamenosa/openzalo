---
name: openzca
description: Use when advanced Zalo workflows need the openzca CLI, especially DB-backed reads and summaries, plus friend ops, group admin, group polls, direct CLI media flows, and profile/account/cache management.
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

Use `openzca` for advanced operations that are not exposed cleanly through OpenZalo `message` actions.

## Prefer DB reads for summaries, search, and history

If the user wants to summarize chats, inspect history, search older messages, identify participants, or build context from prior conversations, prefer the local `openzca db ...` commands instead of ad hoc live reads.

Suggested workflow:

1. Check login and DB state first.
2. If DB is disabled, enable it.
3. If the DB is empty or stale for the target scope, run `db sync ...`.
4. Query `db` commands directly for the final task.

Preflight:

```bash
openzca --version
openzca --profile <profile> auth status
openzca --profile <profile> db status --json
```

Enable and sync:

```bash
openzca --profile <profile> db enable
openzca --profile <profile> db sync all --json
openzca --profile <profile> db sync group <groupId> --json
openzca --profile <profile> db sync chat <chatId> --json
openzca --profile <profile> db sync friends --json
```

Useful DB reads:

```bash
openzca --profile <profile> db me info --json
openzca --profile <profile> db group list --json
openzca --profile <profile> db group info <groupId> --json
openzca --profile <profile> db group members <groupId> --json
openzca --profile <profile> db group messages <groupId> --json
openzca --profile <profile> db friend list --json
openzca --profile <profile> db friend find "<query>" --json
openzca --profile <profile> db friend info <userId> --json
openzca --profile <profile> db friend messages <userId> --json
openzca --profile <profile> db chat list --json
openzca --profile <profile> db chat info <chatId> --json
openzca --profile <profile> db chat messages <chatId> --json
openzca --profile <profile> db message get <msgIdOrCliMsgId> --json
```

Time-range and ordering options for history queries:

```bash
openzca --profile <profile> db group messages <groupId> --since 24h --json
openzca --profile <profile> db group messages <groupId> --from 2026-03-20 --to 2026-03-22 --json
openzca --profile <profile> db group messages <groupId> --limit 200 --oldest-first --json
openzca --profile <profile> db group messages <groupId> --all --json

openzca --profile <profile> db friend messages <userId> --since 7d --json
openzca --profile <profile> db friend messages <userId> --from 1711000000000 --to 1712000000000 --json

openzca --profile <profile> db chat messages <chatId> --since 12h --json
openzca --profile <profile> db chat messages <chatId> --from 2026-03-21T09:00:00+07:00 --until 2026-03-21T18:00:00+07:00 --json
openzca --profile <profile> db chat <chatId> --limit 50 --json
```

Use these flags intentionally:

- `--since <duration>` for rolling windows like `30s`, `7m`, `24h`, `7d`, `2w`
- `--from <time>` and `--to`/`--until <time>` for explicit boundaries
- `--limit <count>` for bounded summaries
- `--all` only when the user explicitly wants full history
- `--oldest-first` when building chronological summaries or timelines

Do not mix:

- `--since` with `--from`
- `--all` with `--limit`

Prefer DB queries when the user asks for:

- conversation summaries
- "what happened in this group/chat"
- message search or recall
- who said what
- recent activity over a time range
- cached member/friend lookups

## Safety

- Confirm before destructive operations:
  - friend remove/block
  - group transfer/disperse/block/unblock/review
  - auth logout/cache-clear
  - db reset
- For ambiguous targets (name/phone/group), resolve first with list/find commands.
- Prefer `--json` when parsing output in automation.

## Preflight

Check binary and login state first:

```bash
openzca --version
openzca --profile <profile> auth status
```

## Use raw openzca only when it adds value

If the request can already be handled by normal OpenZalo `message` actions, do not force CLI usage just because this skill is available.

Use raw `openzca` when you need:

- DB-backed history/summaries/search
- group polls
- advanced friend management
- advanced group admin
- direct CLI-only message flows
- profile/account/cache maintenance

Poll workflows are one of those unsupported areas in OpenZalo `message` actions. If the user asks to create, inspect, vote on, close, or share a Zalo poll, use `openzca`.

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
openzca --profile <profile> group members <groupId> --json
openzca --profile <profile> group create "<name>" <userId1> <userId2>
openzca --profile <profile> group settings <groupId> --help
openzca --profile <profile> group add-deputy <groupId> <userId>
openzca --profile <profile> group remove-deputy <groupId> <userId>
openzca --profile <profile> group transfer <groupId> <newOwnerId>
openzca --profile <profile> group pending <groupId> --json
openzca --profile <profile> group review <groupId> <userId> <approve|deny>
openzca --profile <profile> group disperse <groupId>
```

### Group polls

```bash
openzca --profile <profile> group poll create <groupId> --question "<question>" --option "<option 1>" --option "<option 2>"
openzca --profile <profile> group poll detail <pollId>
openzca --profile <profile> group poll vote <pollId> --option <optionId>
openzca --profile <profile> group poll lock <pollId>
openzca --profile <profile> group poll share <pollId>
```

Create supports optional flags:

```bash
--multi --allow-add-option --hide-vote-preview --anonymous --expire-ms <ms>
```

### Message flows not exposed in OpenZalo actions

```bash
openzca --profile <profile> msg sticker <threadId> <stickerId>
openzca --profile <profile> msg send <threadId> "<reply text>" --reply-id <msgIdOrCliMsgIdOrMessageUid>
openzca --profile <profile> msg send <threadId> "<reply text>" --reply-message '<listenRawPayloadJson>'
openzca --profile <profile> msg video <threadId> <file> --message "<caption>"
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
- For summarize/search/history tasks, prefer `db` reads over live ad hoc fetches whenever the DB is enabled and synced.
- If the DB is not ready, enable it and run the narrowest `db sync ...` command that fits the task.
- For quote replies, prefer `msg send ... --reply-id <id>` when DB is enabled and the target message exists locally.
- If DB is disabled or the caller already has inbound payload JSON from `listen --raw`, use `msg send ... --reply-message '<json>'` instead of trying to reconstruct a reply from ids alone.
- `--reply-message` accepts either the original `zca-js` `message.data` object or the current `openzca listen --raw` payload.
- Do not guess a reply target from text alone. Use a concrete stored id or a concrete inbound payload object.
- For time-bounded summaries, default to `--since` for relative requests like "today", "last 24h", or "this week", and use `--from` plus `--to`/`--until` for exact boundary requests.
- Prefer `--limit` over `--all` unless the user explicitly asks for full history.
- Prefer `--oldest-first` when the output will be turned into a timeline or chronological summary.
- `msg video` accepts local files or `--url`; for a single `.mp4`, `openzca` attempts native video delivery and keeps `--message` as the inline video caption.
- For native mention prep, use `group members <groupId> --json` to resolve exact member ids/display names before sending `@Name`/`@userId`.
- Polls are group-only. For poll creation, gather the target `groupId`, the question, and at least two options before running the command.
- For poll voting, get the `pollId` and option ids first. If the user only describes the poll loosely, run `group poll detail <pollId>` after resolving the correct poll id.
- Use `--help` on subcommands for exact flags before executing admin operations.
- If the user asks for repeated advanced workflows, consider adding a first-class OpenZalo action instead of repeated raw CLI calls.
