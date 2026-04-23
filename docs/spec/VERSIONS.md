# Shipped schema versions

Every record type in the protocol is listed here with its current version and status. Status values: `active` (current), `deprecated` (still supported, new writers SHOULD NOT produce), `sunset` (readers no longer required to support).

| Record | Version | Status | Schema | Docs |
|---|---|---|---|---|
| memory | 1 | active | [schemas/memory.v1.schema.json](schemas/memory.v1.schema.json) | [prose/memory.md](prose/memory.md) |
| session | 1 | active | [schemas/session.v1.schema.json](schemas/session.v1.schema.json) | [prose/session.md](prose/session.md) |
| permissions | 1 | active | [schemas/permissions.v1.schema.json](schemas/permissions.v1.schema.json) | [prose/permissions.md](prose/permissions.md) |
| trajectory-event | 1 | active | [schemas/trajectory-event.v1.schema.json](schemas/trajectory-event.v1.schema.json) | [prose/trajectory-event.md](prose/trajectory-event.md) |
| mcp-server | 1 | active | [schemas/mcp-server.v1.schema.json](schemas/mcp-server.v1.schema.json) | [prose/mcp-server.md](prose/mcp-server.md) |
| tool-schema | 1 | active | [schemas/tool-schema.v1.schema.json](schemas/tool-schema.v1.schema.json) | [prose/tool-schema.md](prose/tool-schema.md) |
| hook-result | 1 | active | [schemas/hook-result.v1.schema.json](schemas/hook-result.v1.schema.json) | [prose/hook-result.md](prose/hook-result.md) |
| hook-pre-tool-use | 1 | active | [schemas/hook-pre-tool-use.v1.schema.json](schemas/hook-pre-tool-use.v1.schema.json) | [prose/hooks.md](prose/hooks.md) |
| hook-post-tool-use | 1 | active | [schemas/hook-post-tool-use.v1.schema.json](schemas/hook-post-tool-use.v1.schema.json) | [prose/hooks.md](prose/hooks.md) |
| hook-session-start | 1 | active | [schemas/hook-session-start.v1.schema.json](schemas/hook-session-start.v1.schema.json) | [prose/hooks.md](prose/hooks.md) |
| hook-session-end | 1 | active | [schemas/hook-session-end.v1.schema.json](schemas/hook-session-end.v1.schema.json) | [prose/hooks.md](prose/hooks.md) |
| hook-stop | 1 | active | [schemas/hook-stop.v1.schema.json](schemas/hook-stop.v1.schema.json) | [prose/hooks.md](prose/hooks.md) |
| hook-pre-compact | 1 | active | [schemas/hook-pre-compact.v1.schema.json](schemas/hook-pre-compact.v1.schema.json) | [prose/hooks.md](prose/hooks.md) |
| hook-post-compact | 1 | active | [schemas/hook-post-compact.v1.schema.json](schemas/hook-post-compact.v1.schema.json) | [prose/hooks.md](prose/hooks.md) |
| hook-subagent-start | 1 | active | [schemas/hook-subagent-start.v1.schema.json](schemas/hook-subagent-start.v1.schema.json) | [prose/hooks.md](prose/hooks.md) |
| hook-subagent-stop | 1 | active | [schemas/hook-subagent-stop.v1.schema.json](schemas/hook-subagent-stop.v1.schema.json) | [prose/hooks.md](prose/hooks.md) |
