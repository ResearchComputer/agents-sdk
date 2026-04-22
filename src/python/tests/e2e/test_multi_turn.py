"""E2E: two sequential prompts preserve message history in the core."""
from __future__ import annotations

import socket
from typing import AsyncIterator

import pytest
import pytest_asyncio
from aiohttp.web_runner import AppRunner, TCPSite

from flash_agents import Agent
from flash_agents.llm import OpenAiCompatLlmClient
from tests.e2e.mock_server import make_recording_app, default_canned_chunks


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def recording_mock() -> AsyncIterator[tuple[str, list[dict]]]:
    port = _find_free_port()
    app, recorded = make_recording_app([default_canned_chunks(), default_canned_chunks()])
    runner = AppRunner(app)
    await runner.setup()
    site = TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        yield (f"http://127.0.0.1:{port}/v1", recorded)
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_multi_turn_preserves_history(
    recording_mock: tuple[str, list[dict]],
) -> None:
    base_url, recorded = recording_mock
    llm = OpenAiCompatLlmClient(base_url=base_url)
    async with await Agent.create(
        llm=llm,
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        system_prompt="SYS",
    ) as agent:
        async for _ in agent.prompt("first"):
            pass
        async for _ in agent.prompt("second"):
            pass
    assert len(recorded) == 2
    msgs_turn2 = recorded[1]["messages"]
    roles_turn2 = [m["role"] for m in msgs_turn2]
    assert "assistant" in roles_turn2, f"turn 2 missing prior assistant reply; got {roles_turn2}"
    assert roles_turn2.count("user") >= 2, f"turn 2 missing prior user msg; got {roles_turn2}"
