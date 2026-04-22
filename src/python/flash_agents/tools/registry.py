"""Canonical tool record + Registry.

Every Python tool (decorator or class form) normalizes to the same
internal shape before being handed to the wasm guest via
host-tools.list-tools.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from flash_agents.errors import ConfigError
from flash_agents.tools.context import ToolContext


@dataclass(frozen=True)
class CanonicalTool:
    name: str
    description: str
    input_schema: dict
    execute: Callable[[dict, ToolContext], Awaitable[Any]]


class ToolRegistry:
    def __init__(self) -> None:
        self._by_name: dict[str, CanonicalTool] = {}

    def register(self, t: CanonicalTool) -> None:
        if t.name in self._by_name:
            raise ConfigError(f"duplicate tool name: {t.name!r}")
        self._by_name[t.name] = t

    def get(self, name: str) -> CanonicalTool | None:
        return self._by_name.get(name)

    def list_json(self) -> list[dict]:
        return [
            {"name": t.name, "description": t.description, "inputSchema": t.input_schema}
            for t in self._by_name.values()
        ]

    def __len__(self) -> int:
        return len(self._by_name)
