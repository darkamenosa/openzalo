OpenClaw future fix note

Problem:
- The Control UI config form can render `Unsupported type: . Use Raw mode.` when a channel/plugin-specific schema node is missing and the renderer falls back to an untyped `{}` node.

Observed path:
- `ui/src/ui/views/channels.config.ts` resolves `["channels", channelId]` from the merged runtime schema.
- If the channel id is absent from `channels.properties`, resolution can fall through to a generic `additionalProperties` node.
- `ui/src/ui/views/config-form.analyze.ts` may normalize permissive object maps to `{}`.
- `ui/src/ui/views/config-form.node.ts` then reaches the fallback branch and prints an empty type.

Why this should be hardened in OpenClaw:
- Plugin-side fixes can restore the missing schema surface, but the UI should still degrade safely.
- Better fallback behavior would be to render unknown/untyped nodes as JSON textarea or a generic object editor instead of a hard error.

Suggested host-side fix:
- Treat empty schema objects as editable `any` nodes in the renderer, not unsupported scalar nodes.
- Or make `resolveSchemaNode(...)` return `null` for untyped fallbacks so the page can show a clearer schema-unavailable message.
