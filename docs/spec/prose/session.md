# session.v1

A session snapshot is a *checkpoint + pointer* into a trajectory. Messages are NOT stored here; they are reconstructed by replaying the referenced trajectory up to `last_event_id`. `context_state` captures non-replayable runtime state (cost totals, selected memories, interrupted tool calls) that cannot be derived from the trajectory.

## Resume algorithm

1. Load session snapshot.
2. Open the trajectory at `trajectory_id`.
3. Replay events whose `event_id > compaction_state.last_compacted_event_id` (or from the beginning if no compaction) up to and including `last_event_id`. Reconstruct message history from `agent_message` events; rebuild permission decisions from `permission_decision` events; accumulate cost from `llm_api_call` events.
4. Rehydrate non-replayable state from `context_state`: restore `cwd`, reuse `selected_memories` (if the embedder's memory resume strategy is `pin`), seed the cost tracker from `cost_state`, and carry `interrupted_tool_call_ids` forward.
5. For each `tool_call` event in the trajectory that has no matching `tool_result`, emit a synthetic "interrupted" `tool_result` event before handing control back to the agent, so the LLM sees the interruption in the transcript.

## Hard-failure conditions on resume

- Trajectory file does not exist.
- `last_event_id` not found within the trajectory file.
- `system_prompt_hash` does not match the hash of the current prompt (caller decides whether to proceed anyway).

## Memory refs

`memory_refs` is a list of memory names scoped to the session's configured memory directory. The session does not record the memory directory path — that is runtime configuration.

## Compaction state

`compaction_state` is OPTIONAL at the snapshot level. It is absent for sessions that have never been compacted. When present, it MUST include `last_compacted_event_id` (nullable ULID); `summary` is optional and only populated when the compaction strategy was `summarize`.

## Context state

`context_state` is OPTIONAL. It is absent for fresh sessions that have not yet accumulated runtime state. When present, it MUST include `selected_memories`, `cost_state`, and `interrupted_tool_call_ids`. `cwd`, `swarm_state`, and `ext` are optional. `cost_state.per_model` is a sorted array (not a map) to stay JSON-friendly across languages.
