"""JSON Schema inference from Python type hints.

Supported: str, int, float, bool, list[T], dict[str, V], Optional[T],
Literal[...], TypedDict, dataclass, PEP 604 unions (T | None). Anything
else -> ConfigError pointing users at the explicit Tool class form.
"""

from __future__ import annotations

import dataclasses
import inspect
import re
import types as _types
import typing
from typing import Any, get_args, get_origin, get_type_hints

from flash_agents.errors import ConfigError


_PRIMITIVES = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
}


def _is_typeddict(tp: Any) -> bool:
    return isinstance(tp, type) and typing.is_typeddict(tp)


def _is_union(origin: Any) -> bool:
    return origin is typing.Union or origin is getattr(_types, "UnionType", None)


def type_to_schema(tp: Any, path: str) -> dict:
    if tp in _PRIMITIVES:
        return {"type": _PRIMITIVES[tp]}
    origin = get_origin(tp)
    args = get_args(tp)
    if origin is list:
        if not args:
            return {"type": "array"}
        return {"type": "array", "items": type_to_schema(args[0], f"{path}[]")}
    if origin is dict:
        if len(args) == 2 and args[0] is str:
            return {
                "type": "object",
                "additionalProperties": type_to_schema(args[1], f"{path}{{}}"),
            }
        return {"type": "object"}
    if _is_union(origin):
        non_none = [a for a in args if a is not type(None)]
        nullable = any(a is type(None) for a in args)
        if len(non_none) == 1:
            inner = type_to_schema(non_none[0], path)
            if nullable:
                t = inner.get("type")
                if isinstance(t, str):
                    inner["type"] = [t, "null"]
                elif t is None:
                    inner["type"] = ["null"]
                elif "null" not in t:
                    inner["type"] = list(t) + ["null"]
            return inner
        raise ConfigError(
            f"unsupported type at {path}: Union with multiple non-None arms. "
            f"Use a Tool subclass with an explicit input_schema."
        )
    if origin is typing.Literal:
        return {"enum": list(args)}
    if _is_typeddict(tp):
        hints = get_type_hints(tp)
        required = list(getattr(tp, "__required_keys__", hints.keys()))
        return {
            "type": "object",
            "properties": {k: type_to_schema(v, f"{path}.{k}") for k, v in hints.items()},
            "required": required,
        }
    if dataclasses.is_dataclass(tp):
        fields = {f.name: f for f in dataclasses.fields(tp)}
        required = [
            n for n, f in fields.items()
            if f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING
        ]
        hints = get_type_hints(tp)
        return {
            "type": "object",
            "properties": {k: type_to_schema(hints[k], f"{path}.{k}") for k in fields},
            "required": required,
        }
    raise ConfigError(
        f"unsupported type at {path}: {tp!r}. "
        f"Use a Tool subclass with an explicit input_schema."
    )


def signature_to_schema(fn: Any, ignore: set[str]) -> tuple[dict, str]:
    sig = inspect.signature(fn)
    hints = get_type_hints(fn)
    properties: dict[str, dict] = {}
    required: list[str] = []
    for name, param in sig.parameters.items():
        if name in ignore:
            continue
        if name not in hints:
            raise ConfigError(
                f"parameter {name!r} in {fn.__name__} has no type hint. "
                f"All tool arguments must be annotated."
            )
        schema = type_to_schema(hints[name], name)
        if param.default is inspect.Parameter.empty:
            required.append(name)
        else:
            schema["default"] = param.default
        properties[name] = schema
    description = _parse_docstring(fn.__doc__ or fn.__name__)
    obj_schema: dict = {"type": "object", "properties": properties}
    if required:
        obj_schema["required"] = required
    return obj_schema, description


_ARGS_RE = re.compile(r"^\s*Args:\s*$", re.MULTILINE)


def _parse_docstring(doc: str) -> str:
    doc = inspect.cleandoc(doc or "")
    if not doc:
        return ""
    m = _ARGS_RE.search(doc)
    if m:
        return doc[: m.start()].strip()
    return doc.strip()
