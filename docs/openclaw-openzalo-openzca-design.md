# OpenClaw + Openzalo + openzca: Architecture Notes and Design

## 1) OpenClaw architecture (from trace)

### Inbound -> Agent -> Outbound flow
- Channel monitor builds inbound context (`ctxPayload`) and sends it to core reply pipeline.
- Core dispatch path:
  - `openclaw/src/auto-reply/reply/dispatch-from-config.ts`
  - `openclaw/src/auto-reply/reply/get-reply.ts`
- Agent run path builds system prompt + tools from:
  - `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
  - `openclaw/src/agents/system-prompt.ts`
  - `openclaw/src/agents/channel-tools.ts`
  - `openclaw/src/agents/tools/message-tool.ts`

### Plugin extension points that matter here
- `agentPrompt.messageToolHints`: guides model behavior at run-time prompt layer.
- `actions.handleAction`: actual implementation of `send/read/unsend/...`.
- `threading.buildToolContext`: provides reply context IDs (`ReplyToId`, `ReplyToIdFull`), useful for `unsend`.
- `groups.resolveRequireMention`: gating behavior in group chats.

### Message action dispatch
- `message` tool schema is built from supported actions and routed via:
  - `openclaw/src/infra/outbound/message-action-runner.ts`
  - `openclaw/src/channels/plugins/message-actions.ts`
- Plugin `handleAction` result is returned to model as tool result payload.

## 2) Problem analyzed: send works, unsend fails in natural follow-up

Observed behavior:
- Bot can send image to group successfully.
- On user follow-up like "thu hồi tin nhắn đó", bot often cannot unsend because `unsend` needs both:
  - `msgId`
  - `cliMsgId`

Root causes:
- `unsend` command is strict by API/CLI contract.
- Natural language follow-up may not include explicit target thread/group.
- Prior send responses may not expose enough undo metadata for the model to reliably chain actions.

## 3) openzca CLI constraints and capabilities (from `/Users/tuyenhx/Workspace/cli/openzca`)

### Constraints
- Undo command requires full tuple:
  - `openzca msg undo <msgId> <cliMsgId> <threadId> [-g]`

### Useful capability already available
- `msg recent` returns rows that include undo-ready fields:
  - `msgId`, `cliMsgId`, and `undo { msgId, cliMsgId, threadId, group }`

Implication:
- Plugin can auto-recover missing undo IDs via recent history lookup when needed.

## 4) Plugin design for reliable unsend

### Implemented direction in `openzalo` plugin
- Return undo metadata from send action:
  - include `messageId` and `msgId` (same value, alias) + `cliMsgId` + `undo` object in tool result.
- Maintain in-memory undo reference cache keyed by account/thread.
- `unsend` fallback order:
  1. explicit params / reply context IDs
  2. cached undo ref for same target thread
  3. cached latest undo ref (when target is implicit)
  4. `read recent` + pick latest own message with undo IDs

### Why this matches OpenClaw architecture
- Uses plugin action layer (`handleAction`) where tool failures are best recovered.
- Keeps model prompt concise while making execution robust.
- Works with current tool loop; no core framework changes required.

## 5) Recommended CLI design improvements (openzca)

These are recommended next steps for `/Users/tuyenhx/Workspace/cli/openzca`:
- Add `msg undo-last <threadId> [-g]`:
  - internally call `msg recent`, pick latest own message, run undo.
- Optional `msg send --json` stable output contract:
  - always include `{ msgId, cliMsgId, threadId, threadType }`.
- Keep `msg recent` undo block stable and documented as machine-friendly contract.

Rationale:
- Reduces complexity in each plugin/integration.
- Makes "unsend last" a first-class operation at CLI layer.

## 6) Suggested operational guidance for model behavior

- Prefer explicit target format:
  - `group:<id>` or `user:<id>`
- After `send`, store returned `undo` payload immediately.
- If user says "unsend that", first try stored `undo`; if missing, call `read` with limit and recover IDs.
- Group history default is tuned to `6` for prompt efficiency; if not enough context, call `action=read` with a higher `limit`.

## 7) Note on current CLI workspace state

- `/Users/tuyenhx/Workspace/cli/openzca` currently has local changes in `src/cli.ts`.
- Because of existing uncommitted work, CLI edits should be coordinated carefully before patching.
