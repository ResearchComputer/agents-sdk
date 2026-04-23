# trajectory-event.v1

One JSONL-encoded event in an agent trajectory. The authoritative schema is [`../schemas/trajectory-event.v1.schema.json`](../schemas/trajectory-event.v1.schema.json); the required/optional `event_type` values and payload shape per event are defined there.

## Event ordering

- Events MUST be written in `event_id` ULID order within a trajectory.
- Monotonically increasing `event_id` is a property of a single writer; out-of-order writes across writers (e.g., a swarm where teammates append concurrently) MUST be serialized by the writer before flush.

## Turn correlation

`turn_id` is present on `llm_api_call`, `llm_turn`, and `agent_message` payloads. Tool-related events (`tool_call`, `tool_result`, `permission_decision`, `hook_fire`) correlate to a turn via `parent_event_id` chained back to the originating `llm_api_call`. A reader that wants all events for a given turn walks the parent chain; there is no direct `turn_id` on those events.
