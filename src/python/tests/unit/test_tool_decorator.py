"""Unit tests for @tool schema inference and Tool class."""
from __future__ import annotations

from typing import Literal, Optional, TypedDict
from dataclasses import dataclass

import pytest

from flash_agents import ConfigError, Tool, tool


class _Point(TypedDict):
    x: int
    y: int


@dataclass
class _Box:
    w: int
    h: int


class _Opaque:
    """Unsupported-by-schema sentinel (module-scope so get_type_hints resolves)."""


def test_decorator_infers_primitive_args() -> None:
    @tool
    async def read_file(path: str, *, max_bytes: int = 65536) -> str:
        """Read a file.

        Args:
            path: Absolute path to the file.
            max_bytes: Truncate after this many bytes.
        """
        return ""

    schema = read_file.canonical.input_schema
    assert schema["type"] == "object"
    assert schema["properties"]["path"]["type"] == "string"
    assert schema["properties"]["max_bytes"]["type"] == "integer"
    assert schema["properties"]["max_bytes"]["default"] == 65536
    assert "path" in schema["required"]
    assert "max_bytes" not in schema["required"]
    assert read_file.canonical.description.startswith("Read a file")


def test_decorator_handles_optional_and_literal_and_list() -> None:
    @tool
    async def fn(
        tags: list[str],
        mode: Literal["r", "w"] = "r",
        note: Optional[str] = None,
    ) -> None:
        """Do stuff."""

    s = fn.canonical.input_schema
    assert s["properties"]["tags"]["type"] == "array"
    assert s["properties"]["tags"]["items"]["type"] == "string"
    assert s["properties"]["mode"]["enum"] == ["r", "w"]
    note_type = s["properties"]["note"]["type"]
    assert "string" in note_type if isinstance(note_type, list) else note_type == "string"


def test_decorator_typeddict_and_dataclass() -> None:
    @tool
    async def plot(point: _Point, box: _Box) -> None:
        """Plot point in box."""

    s = plot.canonical.input_schema
    assert s["properties"]["point"]["type"] == "object"
    assert s["properties"]["point"]["properties"]["x"]["type"] == "integer"
    assert s["properties"]["box"]["type"] == "object"


def test_unsupported_type_raises_configerror() -> None:
    with pytest.raises(ConfigError, match="unsupported"):
        @tool
        async def bad(x: _Opaque) -> None:
            """no schema possible."""


def test_multi_arm_union_emits_anyOf() -> None:
    @tool
    async def numeric_or_text(x: int | str) -> str:
        """accepts an int or a string."""
        return str(x)

    schema = numeric_or_text.canonical.input_schema
    prop = schema["properties"]["x"]
    assert "anyOf" in prop
    types = sorted(s["type"] for s in prop["anyOf"])
    assert types == ["integer", "string"]


def test_nullable_multi_arm_union_includes_null_branch() -> None:
    @tool
    async def maybe_int_or_str(x: int | str | None) -> str:
        """accepts an int, a string, or None."""
        return str(x)

    schema = maybe_int_or_str.canonical.input_schema
    prop = schema["properties"]["x"]
    assert "anyOf" in prop
    types = sorted(s["type"] for s in prop["anyOf"])
    assert types == ["integer", "null", "string"]


def test_tool_class_form() -> None:
    class WebFetch(Tool):
        name = "web_fetch"
        description = "fetch url"
        input_schema = {
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
        }

        async def execute(self, args, ctx):
            return {"fetched": args["url"]}

    t = WebFetch()
    assert t.canonical.name == "web_fetch"
    assert t.canonical.input_schema["required"] == ["url"]


def test_tool_class_missing_fields_raises() -> None:
    with pytest.raises(ConfigError):
        class Bad(Tool):
            description = "x"
            input_schema = {"type": "object"}
            async def execute(self, args, ctx): return None
        Bad()
