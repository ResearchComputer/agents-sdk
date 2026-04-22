"""Unit: Tool class subclass validation, duplicate-name detection."""
from __future__ import annotations

import pytest

from flash_agents import ConfigError, Tool
from flash_agents.tools.registry import ToolRegistry


class _Ok(Tool):
    name = "ok"
    description = "ok tool"
    input_schema = {"type": "object"}

    async def execute(self, args, ctx):
        return None


def test_valid_subclass_has_canonical() -> None:
    t = _Ok()
    assert t.canonical.name == "ok"


def test_missing_class_attrs_raise() -> None:
    class _NoName(Tool):
        description = "x"
        input_schema = {"type": "object"}
        async def execute(self, args, ctx): return None
    with pytest.raises(ConfigError):
        _NoName()


def test_sync_execute_raises() -> None:
    class _Sync(Tool):
        name = "s"
        description = "sync"
        input_schema = {"type": "object"}
        def execute(self, args, ctx):  # sync, not async
            return None
    with pytest.raises(ConfigError, match="async def"):
        _Sync()


def test_registry_duplicate_rejected() -> None:
    reg = ToolRegistry()
    reg.register(_Ok().canonical)
    with pytest.raises(ConfigError, match="duplicate"):
        reg.register(_Ok().canonical)
