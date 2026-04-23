# mcp-server.v1

File format for declaring MCP servers to connect to. Shape mirrors the existing `McpServerConfig` TypeScript interface, with the addition of a `schema_version` envelope and the transport-dependent required-field rules.

## Transport rules

- `stdio` transport requires `command` (and optionally `args`, `env`).
- `sse` and `http` transports require `url` (and optionally `headers`).
