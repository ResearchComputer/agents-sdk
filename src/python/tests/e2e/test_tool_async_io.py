"""E2E: a tool that awaits aiohttp completes without deadlock.

Verifies the worker-thread <-> main-loop bridging does not block when a
tool suspends on network I/O mid-turn. If the Rust host's pyo3-async
integration regresses this, the test hangs.
"""
from __future__ import annotations

import asyncio
import socket
from typing import AsyncIterator

import aiohttp
import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.web_runner import AppRunner, TCPSite

from flash_agents import Agent, tool
from flash_agents.llm import OpenAiCompatLlmClient
from tests.e2e.mock_server import make_recording_app, tool_call_chunks


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def echo_server() -> AsyncIterator[str]:
    async def handler(request: web.Request) -> web.Response:
        return web.Response(text="pong")
    app = web.Application()
    app.router.add_get("/ping", handler)
    port = _find_free_port()
    runner = AppRunner(app)
    await runner.setup()
    site = TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        yield f"http://127.0.0.1:{port}/ping"
    finally:
        await runner.cleanup()


@pytest_asyncio.fixture
async def mock_llm_two_turns() -> AsyncIterator[str]:
    chunks1 = tool_call_chunks("fetch_ping", "{}")
    chunks2 = [
        {
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}],
            "id": "m", "object": "chat.completion.chunk", "created": 0, "model": "mock",
        }
    ]
    app, _ = make_recording_app([chunks1, chunks2])
    port = _find_free_port()
    runner = AppRunner(app)
    await runner.setup()
    site = TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        yield f"http://127.0.0.1:{port}/v1"
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_tool_awaits_aiohttp_without_deadlock(
    echo_server: str, mock_llm_two_turns: str,
) -> None:
    @tool
    async def fetch_ping() -> str:
        """GET the echo server and return its body."""
        async with aiohttp.ClientSession() as sess:
            async with sess.get(echo_server) as r:
                return await r.text()

    llm = OpenAiCompatLlmClient(base_url=mock_llm_two_turns)

    async def _run() -> None:
        async with await Agent.create(
            llm=llm,
            model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
            system_prompt="",
            tools=[fetch_ping],
        ) as agent:
            async for _ in agent.prompt("please ping"):
                pass

    await asyncio.wait_for(_run(), timeout=10.0)
