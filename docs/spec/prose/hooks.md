# hook-*.v1

Wire-format projections of runtime state passed to hook handlers. Each event has its own schema (`hook-<kebab-case-event>.v1`). Every schema shares a base set of fields — `schema_version`, `session_id`, `trace_id`, `cwd`, `agent_name` — plus event-specific fields.

## Events

| Event | Schema | Extra required fields |
|---|---|---|
| PreToolUse | hook-pre-tool-use.v1 | tool_name, tool_args |
| PostToolUse | hook-post-tool-use.v1 | tool_name, tool_args, tool_result |
| SessionStart | hook-session-start.v1 | — |
| SessionEnd | hook-session-end.v1 | reason |
| Stop | hook-stop.v1 | — |
| PreCompact | hook-pre-compact.v1 | strategy, messages_before |
| PostCompact | hook-post-compact.v1 | strategy, messages_before, messages_after (summary optional) |
| SubagentStart | hook-subagent-start.v1 | teammate_name, task_id |
| SubagentStop | hook-subagent-stop.v1 | teammate_name, task_id, termination_reason |

## Hook result

Every handler returns a `hook-result.v1`. See `hook-result.md`.

## Why no shared base schema

Each file repeats the base fields inline rather than `$ref`-ing a shared fragment. This keeps every schema self-contained so external consumers in other languages can read one file at a time without resolving cross-file references.
