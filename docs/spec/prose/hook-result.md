# hook-result.v1

Returned by a hook handler. `updated_args` and `updated_result` substitute the original args or result for subsequent processing. Both are optional; a hook that does nothing returns an empty `{ "schema_version": "1" }`.

No explicit cancel signal is defined. A hook that wants to block a tool call raises an error or sets `updated_result` to an error value.
