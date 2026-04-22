"""E2E: multiple Agent instances in parallel; one agent serializes prompts."""
from __future__ import annotations

import asyncio
import socket
from typing import AsyncIterator

import pytest
import pytest_asyncio
from aiohttp.web_runner import AppRunner, TCPSite

from flash_agents import Agent
from flash_agents.llm import OpenAiCompatLlmClient
from tests.e2e.mock_server import make_mock_app, default_canned_chunks


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def two_mocks() -> AsyncIterator[tuple[str, str]]:
    results: list[AppRunner] = []
    ports: list[int] = []
    for _ in range(2):
        app = make_mock_app(default_canned_chunks(), delay_between_ms=50)
        port = _find_free_port()
        runner = AppRunner(app)
        await runner.setup()
        await TCPSite(runner, "127.0.0.1", port).start()
        results.append(runner)
        ports.append(port)
    try:
        yield (f"http://127.0.0.1:{ports[0]}/v1", f"http://127.0.0.1:{ports[1]}/v1")
    finally:
        for runner in results:
            await runner.cleanup()


async def _drain(agent: Agent, msg: str) -> int:
    count = 0
    async for _ in agent.prompt(msg):
        count += 1
    return count


@pytest.mark.asyncio
async def test_two_agents_run_in_parallel(two_mocks: tuple[str, str]) -> None:
    a_url, b_url = two_mocks
    model = {"id": "mock-gpt", "provider": "openai", "api": "openai-completions"}
    a = await Agent.create(llm=OpenAiCompatLlmClient(base_url=a_url), model=model, memory=None)
    b = await Agent.create(llm=OpenAiCompatLlmClient(base_url=b_url), model=model, memory=None)
    try:
        ca, cb = await asyncio.gather(_drain(a, "hello"), _drain(b, "hello"))
        assert ca > 0 and cb > 0
    finally:
        await a.dispose()
        await b.dispose()


@pytest.mark.asyncio
async def test_same_agent_serializes(two_mocks: tuple[str, str]) -> None:
    a_url, _ = two_mocks
    agent = await Agent.create(
        llm=OpenAiCompatLlmClient(base_url=a_url),
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        memory=None,
    )
    try:
        c1, c2 = await asyncio.gather(_drain(agent, "one"), _drain(agent, "two"))
        assert c1 > 0 and c2 > 0
    finally:
        await agent.dispose()
