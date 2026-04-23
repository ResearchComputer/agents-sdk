"""flash-agents — Python SDK wrapping the agents-sdk core via WebAssembly."""

from flash_agents.errors import (
    ConfigError,
    FlashAgentError,
    LlmError,
    ToolError,
    WasmHostError,
)
from flash_agents.tools import Tool, ToolContext, tool

__version__ = "0.1.0"

__all__ = [
    "Agent",
    "Tool",
    "ToolContext",
    "tool",
    "ConfigError",
    "FlashAgentError",
    "LlmError",
    "ToolError",
    "WasmHostError",
]


def __getattr__(name: str):
    if name == "Agent":
        from flash_agents.agent import Agent
        return Agent
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
