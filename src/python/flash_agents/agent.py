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
    ) -> None:
        self._inner = inner
        self._llm = llm
        self._loop = loop
        self._call_lock = asyncio.Lock()
        self._disposed = False

    @classmethod
    async def create(
        cls,
        *,
        llm: LlmClient,
        model: dict,
        system_prompt: str = "",
        cwd: str | None = None,
        tools: list | None = None,
    ) -> "Agent":
        if not isinstance(model, dict) or not {"id", "provider", "api"} <= set(model):
            raise ConfigError("model must be a dict with keys 'id', 'provider', 'api'")
        # Tools are wired in Chunk 4; for now this parameter is accepted
        # but not yet plumbed through to registered Python tools.
        _ = tools

        loop = asyncio.get_running_loop()

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
            """Adapter: Rust calls us synchronously with kwargs; we return
            the async iterator produced by llm.stream(request)."""
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

        def _list_tools_callback() -> str:
            # No tools registered in Chunk 2.
            return "[]"

        async def _execute_tool_callback(
            *, callId: str, toolName: str, inputJson: str,
        ) -> dict:
            # Wired in Chunk 4. For now, all tool calls fail with a clear error.
            return {
                "callId": callId,
                "isError": True,
                "outputJson": json.dumps({
                    "error": f"tool {toolName!r} not registered",
                    "type": "ConfigError",
                }),
            }

        config_json = json.dumps({
            "model": model,
            "systemPrompt": system_prompt,
            "cwd": cwd or "/flash-agents",
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
        return cls(inner=inner, llm=llm, loop=loop)

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

        async def iterator() -> AsyncIterator[dict]:
            async with self._call_lock:
                try:
                    stream = await self._inner.prompt(message, None)
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
