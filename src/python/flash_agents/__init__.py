"""flash-agents — Python SDK wrapping the agents-sdk core via WebAssembly."""

from flash_agents.agent import Agent
from flash_agents.errors import (
    ConfigError,
    FlashAgentError,
    LlmError,
    ToolError,
    WasmHostError,
)

__version__ = "0.1.0"

__all__ = [
    "Agent",
    "ConfigError",
    "FlashAgentError",
    "LlmError",
    "ToolError",
    "WasmHostError",
]
