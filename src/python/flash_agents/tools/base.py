"""@tool decorator and Tool base class."""

from __future__ import annotations

import inspect
from typing import Any, Awaitable, Callable, get_type_hints

from flash_agents.errors import ConfigError
from flash_agents.tools.context import ToolContext
from flash_agents.tools.registry import CanonicalTool
from flash_agents.tools.schema import signature_to_schema


class _Decorated:
    """Object returned by @tool. Callable like the original function; also
    carries a `.canonical` attribute holding the CanonicalTool."""

    def __init__(self, fn: Callable[..., Awaitable[Any]], canonical: CanonicalTool) -> None:
        self._fn = fn
        self.canonical = canonical
        self.__name__ = getattr(fn, "__name__", canonical.name)
        self.__doc__ = fn.__doc__

    async def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return await self._fn(*args, **kwargs)


def tool(fn: Callable[..., Awaitable[Any]]) -> _Decorated:
    """Decorate an async function as an agent tool.

    Supported arg types: str, int, float, bool, list[T], dict[str, V],
    Optional[T], Literal[...], TypedDict, dataclass, PEP 604 unions.
    Opt into ToolContext by adding a parameter named `ctx` with annotation
    `ToolContext`.
    """
    if not inspect.iscoroutinefunction(fn):
        raise ConfigError(
            f"@tool function {fn.__name__} must be declared `async def`."
        )
    hints = get_type_hints(fn)
    ctx_param_name: str | None = None
    for name, hint in hints.items():
        if hint is ToolContext:
            ctx_param_name = name
            break
    ignore = {ctx_param_name} if ctx_param_name else set()
    schema, description = signature_to_schema(fn, ignore=ignore)

    async def do_call(args: dict, ctx: ToolContext) -> Any:
        call_kwargs = dict(args)
        if ctx_param_name is not None:
            call_kwargs[ctx_param_name] = ctx
        return await fn(**call_kwargs)

    canonical = CanonicalTool(
        name=fn.__name__,
        description=description,
        input_schema=schema,
        execute=do_call,
    )
    return _Decorated(fn, canonical)


class Tool:
    """Base class for explicit tools with hand-written input_schema.

    Subclasses must set class attributes `name`, `description`,
    `input_schema`, and implement `async def execute(self, args, ctx) -> Any`.
    """

    name: str
    description: str
    input_schema: dict

    def __init__(self) -> None:
        for attr in ("name", "description", "input_schema"):
            if not getattr(self, attr, None):
                raise ConfigError(
                    f"Tool subclass {type(self).__name__} must define class attribute {attr!r}"
                )
        if not inspect.iscoroutinefunction(type(self).execute):
            raise ConfigError(
                f"Tool subclass {type(self).__name__}.execute must be `async def`"
            )

    async def execute(self, args: dict, ctx: ToolContext) -> Any:
        raise NotImplementedError

    @property
    def canonical(self) -> CanonicalTool:
        instance = self

        async def do_call(args: dict, ctx: ToolContext) -> Any:
            return await instance.execute(args, ctx)

        return CanonicalTool(
            name=self.name,
            description=self.description,
            input_schema=self.input_schema,
            execute=do_call,
        )
