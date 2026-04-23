# permissions.v1

A file containing a set of permission rules for a single source (`user`, `project`, or `session`). Matching and specificity rules are runtime behavior, not schema-level; see the runtime implementation in `src/middleware/permissions.ts`.

## Target types

- `tool` — matches a tool by name, optionally filtered by `pattern` (glob applied to tool args, tool-specific).
- `capability` — matches any tool that declares the capability.
- `mcp` — matches an MCP server, optionally narrowed to a single tool.
- `all` — matches everything.
