# Portable Core Protocols — `docs/spec/`

The cross-language contract surface of `@researchcomputer/agents-sdk`. This directory is the authoritative place to look when:

- you are writing code in another language that consumes agent outputs (session snapshots, trajectories, hook payloads), or
- you are building a non-Node host that embeds the SDK's core runtime, or
- you are generating typed bindings from our schemas.

## Two kinds of contracts

| Contract | Artifact | Consumers |
|---|---|---|
| **Wire-format JSON** — session snapshots, trajectory events, hook payloads, MCP server descriptors, permission rules, memory records, tool schemas | [`schemas/*.json`](schemas/) (JSON Schema draft-07) | External systems that read or write agent output files |
| **WASM Component embedding ABI** — the contract between a host and the `core.wasm` component | [`wasm.md`](wasm.md) + [`../../examples/python-stub/wasm/world.wit`](../../examples/python-stub/wasm/world.wit) | Non-JS hosts embedding the core (Rust, Python, Go, …) |

For the language-agnostic factory that produces this contract, see [`../embedding-core.md`](../embedding-core.md).

## Wire-format schemas

| Record | Purpose | Schema | Prose |
|---|---|---|---|
| `session` | Resumable conversation snapshot (messages, model, memory refs, compaction state) | [`schemas/session.v1.schema.json`](schemas/session.v1.schema.json) | [`prose/session.md`](prose/session.md) |
| `trajectory-event` | One JSONL-encoded event in an agent run (session_start, llm_api_call, tool_call, …) | [`schemas/trajectory-event.v1.schema.json`](schemas/trajectory-event.v1.schema.json) | [`prose/trajectory-event.md`](prose/trajectory-event.md) |
| `memory` | A single memory entry (user/feedback/project/reference) | [`schemas/memory.v1.schema.json`](schemas/memory.v1.schema.json) | [`prose/memory.md`](prose/memory.md) |
| `permissions` | A single permission rule | [`schemas/permissions.v1.schema.json`](schemas/permissions.v1.schema.json) | [`prose/permissions.md`](prose/permissions.md) |
| `mcp-server` | An MCP server descriptor (transport, command/url, trust level) | [`schemas/mcp-server.v1.schema.json`](schemas/mcp-server.v1.schema.json) | [`prose/mcp-server.md`](prose/mcp-server.md) |
| `tool-schema` | A tool's input schema descriptor | [`schemas/tool-schema.v1.schema.json`](schemas/tool-schema.v1.schema.json) | [`prose/tool-schema.md`](prose/tool-schema.md) |
| `hook-result` and nine `hook-*` event variants | Hook payload envelopes for lifecycle and tool-use events | [`schemas/hook-*.json`](schemas/) | [`prose/hooks.md`](prose/hooks.md), [`prose/hook-result.md`](prose/hook-result.md) |

The authoritative version table (which version of each record is `active`, `deprecated`, or `sunset`) lives in [`VERSIONS.md`](VERSIONS.md). This table is **not** duplicated there — `VERSIONS.md` is the single source of truth.

## Conventions

- **Identifiers:** 26-character Crockford Base32 ULIDs. Sortable by creation time within a single writer.
- **Timestamps:** ISO-8601 UTC strings with millisecond precision (`YYYY-MM-DDTHH:MM:SS.sssZ`).
- **Hashes:** `sha256:` prefix followed by the hex digest (e.g., `sha256:e3b0c44298fc1c...`).
- **Versioning:** every record carries a `schema_version` string (`"1"` today). A breaking change bumps the major; a superset-only change adds optional fields without bumping. `VERSIONS.md` records the current status.

## Worked example: validating a trajectory

A minimal trajectory is provided at [`examples/trajectory-event/valid-trajectory.jsonl`](examples/trajectory-event/valid-trajectory.jsonl). It covers a full session: `session_start` → `llm_api_call` → `agent_message` → `permission_decision` → `tool_call` → `hook_fire` → `tool_result` → `session_end`.

Each line is a separate JSON object that validates against `schemas/trajectory-event.v1.schema.json`.

```bash
# Using ajv-cli (Node)
npx ajv-cli validate \
  -s docs/spec/schemas/trajectory-event.v1.schema.json \
  -d docs/spec/examples/trajectory-event/valid-trajectory.jsonl \
  --all-errors
```

## Consuming from other languages

The schemas are standard JSON Schema and work with any conforming validator. Minimal loading patterns:

**Python** (`jsonschema`):

```python
import json, jsonschema
schema = json.load(open("docs/spec/schemas/trajectory-event.v1.schema.json"))
for line in open("trajectory.jsonl"):
    jsonschema.validate(json.loads(line), schema)
```

**Go** (`github.com/xeipuuv/gojsonschema`):

```go
loader := gojsonschema.NewReferenceLoader("file://docs/spec/schemas/trajectory-event.v1.schema.json")
doc := gojsonschema.NewStringLoader(eventLine)
result, _ := gojsonschema.Validate(loader, doc)
```

**Rust** (`jsonschema`):

```rust
let schema: serde_json::Value = serde_json::from_str(include_str!("./docs/spec/schemas/trajectory-event.v1.schema.json"))?;
let validator = jsonschema::validator_for(&schema)?;
// quick yes/no
assert!(validator.is_valid(&event_json));
// or, for detailed errors
for error in validator.iter_errors(&event_json) {
    eprintln!("validation error: {error}");
}
```

For typed bindings, any JSON-Schema-to-language generator works (`quicktype`, `datamodel-code-generator`, `schemars`, etc.). Generating and publishing language-specific bindings is out of scope for this repository.

## Reporting contract drift

If you find a mismatch between what the SDK produces and what a schema here says, open an issue with:

- the schema version and record type,
- the offending JSON excerpt,
- the SDK version that produced it.

Schema changes follow the versioning rules above; a fix is either an additive optional field (no version bump) or a new major version with `VERSIONS.md` entries for both during the deprecation window.
