"""MCP server registration (wiring staged — accepted but not dispatched in v1)."""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field


@dataclass(frozen=True)
class McpServer:
    """Declarative config for an MCP server. v1 accepts but does not dispatch."""
    name: str
    command: list[str]
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)


def _warn_if_registered(mcp_servers: list[McpServer] | None) -> list[McpServer]:
    if not mcp_servers:
        return []
    seen: set[str] = set()
    out: list[McpServer] = []
    for s in mcp_servers:
        if s.name in seen:
            from flash_agents.errors import ConfigError
            raise ConfigError(f"duplicate MCP server name: {s.name!r}")
        seen.add(s.name)
        out.append(s)
    warnings.warn(
        "flash-agents v1 accepts mcp_servers for forward compatibility but "
        "does not yet dispatch calls to them. MCP wiring lands in a future release.",
        UserWarning,
        stacklevel=3,
    )
    return out


__all__ = ["McpServer"]
