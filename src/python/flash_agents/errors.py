"""flash_agents exception hierarchy.

Contract summary:
- ConfigError: raised synchronously during Agent.create() or @tool
  decoration. Never reaches the WASM boundary.
- WasmHostError: structural failures (component load, SHA mismatch,
  wrong event loop, wasmtime trap). Propagates out of agent.prompt().
- LlmError: a user-supplied LlmClient.stream() may raise; surfaces
  back to the agent as a terminal message_end with stopReason=error.
- ToolError: raised by a user tool at call time. Fed back to the LLM
  as a tool-result with is_error=true; does NOT propagate out of
  agent.prompt().
"""


class FlashAgentError(Exception):
    """Base class for all flash_agents errors."""


class ConfigError(FlashAgentError):
    """Invalid configuration, bad tool schema, or other setup-time problem."""


class WasmHostError(FlashAgentError):
    """Structural failure in the WASM host layer."""


class LlmError(FlashAgentError):
    """Error raised from a user-supplied LlmClient.stream()."""


class ToolError(FlashAgentError):
    """Raised by a tool at execution time."""
