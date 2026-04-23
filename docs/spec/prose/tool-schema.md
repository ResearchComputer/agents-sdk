# tool-schema.v1

Describes a tool's input shape for trajectory self-description. When a `tool_call` event is written, the tool's schema MAY be embedded in the trajectory (once per trajectory or per tool-first-use) under a custom `ext` namespace, or referenced externally. This schema constrains the declaration itself.

## Reserved meta keywords

- `x-capabilities` — REQUIRED. The capabilities the tool requires from the permission system. Must be a subset of the enum listed in the schema.
