"""Agent — async facade over flash_agents_wasm (Rust/wasmtime host).

Lifecycle:
    async with await Agent.create(...) as agent:
        async for event in agent.prompt("..."):
            ...

Concurrency:
- Per-agent asyncio.Lock serializes concurrent prompt() calls on the same
  agent. Separate Agent instances own independent wasmtime stores and run
  in parallel with no shared state.
- Every call into the Rust extension is already async (future_into_py on
  the Rust side), so the asyncio event loop is not blocked.
"""

from __future__ import annotations

import asyncio
import json
import logging
import traceback
from typing import Any, AsyncIterator, Awaitable, Callable, Protocol

from flash_agents.errors import ConfigError, WasmHostError
from flash_agents.wasm.host import wasm_path


try:
    import flash_agents_wasm as _wasm_ext
except ModuleNotFoundError as err:
    if err.name == "flash_agents_wasm":
        raise ModuleNotFoundError(
            "flash_agents_wasm native extension not found. Build it first:\n"
            "    cd src/python/wasm-host && maturin develop --release"
        ) from err
    raise


_TOOL_LOGGER = logging.getLogger("flash_agents.tools")


class LlmClient(Protocol):
    """See flash_agents.llm.client.LlmClient."""
    def stream(self, req: Any) -> AsyncIterator[str]: ...


class Agent:
    """One wasmtime-backed agent instance. Async context manager."""

    def __init__(
        self,
        *,
        inner: Any,
        llm: LlmClient,
        loop: asyncio.AbstractEventLoop,
        memory: Any,
        memory_top_k: int,
        mcp_servers: list,
    ) -> None:
        self._inner = inner
        self._llm = llm
        self._loop = loop
        self._call_lock = asyncio.Lock()
        self._disposed = False
        self._memory = memory
        self._memory_top_k = memory_top_k
        self._mcp_servers = mcp_servers

    _MEMORY_UNSET: Any = object()

    @classmethod
    async def create(
        cls,
        *,
        llm: LlmClient,
        model: dict,
        system_prompt: str = "",
        cwd: str | None = None,
        tools: list | None = None,
        memory: Any = _MEMORY_UNSET,
        memory_top_k: int = 5,
        mcp_servers: list | None = None,
    ) -> "Agent":
        if not isinstance(model, dict) or not {"id", "provider", "api"} <= set(model):
            raise ConfigError("model must be a dict with keys 'id', 'provider', 'api'")

        loop = asyncio.get_running_loop()
        effective_cwd = cwd or "/flash-agents"

        # Memory: default FilesystemMemoryStore; None disables; any other
        # object must implement MemoryStore Protocol (load/save/remove).
        if memory is cls._MEMORY_UNSET:
            from flash_agents.memory import FilesystemMemoryStore
            memory = FilesystemMemoryStore()
        elif memory is None:
            pass
        else:
            if not all(hasattr(memory, a) for a in ("load", "save", "remove")):
                raise ConfigError(
                    "memory must implement MemoryStore Protocol "
                    "(load/save/remove async methods), or be None"
                )

        # MCP: register + warn if any. Not dispatched in v1.
        from flash_agents.mcp import _warn_if_registered
        validated_mcp = _warn_if_registered(mcp_servers)

        from flash_agents.tools.base import _Decorated, Tool
        from flash_agents.tools.context import ToolContext
        from flash_agents.tools.registry import CanonicalTool, ToolRegistry

        registry = ToolRegistry()
        for t in (tools or []):
            if isinstance(t, _Decorated):
                registry.register(t.canonical)
            elif isinstance(t, Tool):
                registry.register(t.canonical)
            elif isinstance(t, CanonicalTool):
                registry.register(t)
            else:
                raise ConfigError(
                    f"tools[{len(registry)}] is not a recognized tool "
                    f"(got {type(t).__name__}). Use @tool, subclass Tool, "
                    f"or pass a CanonicalTool."
                )

        def _llm_stream_factory(
            *,
            model_id: str,
            provider: str,
            api: str,
            system_prompt: str,
            messages_json: str,
            tools_json: str,
            options_json: str,
        ) -> AsyncIterator[str]:
            from flash_agents.llm.client import LlmRequest
            req = LlmRequest(
                model_id=model_id,
                provider=provider,
                api=api,
                system_prompt=system_prompt,
                messages_json=messages_json,
                tools_json=tools_json,
                options_json=options_json,
            )
            return llm.stream(req)

        tools_list_json = json.dumps(registry.list_json())

        def _list_tools_callback() -> str:
            return tools_list_json

        async def _execute_tool_callback(
            *, callId: str, toolName: str, inputJson: str,
        ) -> dict:
            rec = registry.get(toolName)
            if rec is None:
                return {
                    "callId": callId,
                    "isError": True,
                    "outputJson": json.dumps({
                        "error": f"unknown tool: {toolName}",
                        "type": "ToolError",
                    }),
                }
            try:
                args = json.loads(inputJson)
            except json.JSONDecodeError as e:
                return {
                    "callId": callId,
                    "isError": True,
                    "outputJson": json.dumps({
                        "error": f"invalid JSON args: {e}",
                        "type": "ToolError",
                    }),
                }
            ctx = ToolContext(
                cwd=effective_cwd, call_id=callId, logger=_TOOL_LOGGER,
            )
            try:
                result = await rec.execute(args, ctx)
            except Exception as exc:  # noqa: BLE001 — tool boundary swallows all
                return {
                    "callId": callId,
                    "isError": True,
                    "outputJson": json.dumps({
                        "error": str(exc),
                        "type": type(exc).__name__,
                        "traceback": traceback.format_exc(),
                    }),
                }
            return {
                "callId": callId,
                "isError": False,
                "outputJson": json.dumps(result),
            }

        config_json = json.dumps({
            "model": model,
            "systemPrompt": system_prompt,
            "cwd": effective_cwd,
        })
        try:
            inner = await _wasm_ext.Agent.create(
                wasm_path=wasm_path(),
                llm_stream_factory=_llm_stream_factory,
                list_tools_callback=_list_tools_callback,
                execute_tool_callback=_execute_tool_callback,
                config_json=config_json,
            )
        except RuntimeError as err:
            raise WasmHostError(str(err)) from err
        return cls(
            inner=inner, llm=llm, loop=loop,
            memory=memory, memory_top_k=memory_top_k,
            mcp_servers=validated_mcp,
        )

    def _check_loop(self) -> None:
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is not self._loop:
            raise WasmHostError(
                "Agent is bound to a different event loop than the one calling it. "
                "Agents cannot be shared across event loops."
            )

    def prompt(self, message: str) -> AsyncIterator[dict]:
        """Run one turn. Returns an async iterator of AgentEvent dicts.

        Not declared `async def`: callers use `async for event in agent.prompt(...)`
        directly without an intervening `await`.
        """
        self._check_loop()
        if self._disposed:
            raise WasmHostError("agent has been disposed")

        memory = self._memory
        memory_top_k = self._memory_top_k

        async def iterator() -> AsyncIterator[dict]:
            async with self._call_lock:
                extra_system = await _compose_memory_block(memory, message, memory_top_k)
                try:
                    stream = await self._inner.prompt(message, extra_system)
                except RuntimeError as err:
                    raise WasmHostError(str(err)) from err
                try:
                    while True:
                        raw = await stream.next()
                        if raw is None:
                            return
                        yield json.loads(raw)
                finally:
                    try:
                        await stream.close()
                    except RuntimeError:
                        pass

        return iterator()

    async def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        try:
            await self._inner.dispose()
        except RuntimeError:
            # Already disposed; swallow.
            pass

    async def __aenter__(self) -> "Agent":
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.dispose()


async def _compose_memory_block(
    memory: Any, query: str, top_k: int,
) -> str | None:
    """Load memories, retrieve the top-k matches, render as an <memories>
    block suitable for the agent's extra_system slot. Returns None if the
    memory store is disabled or no matches are selected."""
    if memory is None:
        return None
    from flash_agents.memory.retrieve import retrieve as _retrieve
    memories = await memory.load()
    if not memories:
        return None
    selections = _retrieve(memories, query=query, max_items=top_k)
    if not selections:
        return None
    rendered = "\n\n".join(
        f"<memory name=\"{s.memory.name}\">\n{s.memory.content}\n</memory>"
        for s in selections
    )
    return f"<memories>\n{rendered}\n</memories>"
