"""E2E: FilesystemMemoryStore entries appear in the system prompt per turn."""
from __future__ import annotations

import pathlib
import socket
from typing import AsyncIterator

import pytest
import pytest_asyncio
from aiohttp.web_runner import AppRunner, TCPSite

from flash_agents import Agent
from flash_agents.llm import OpenAiCompatLlmClient
from flash_agents.memory import FilesystemMemoryStore, Memory
from tests.e2e.mock_server import make_recording_app, default_canned_chunks


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def recording() -> AsyncIterator[tuple[str, list[dict]]]:
    app, recorded = make_recording_app([default_canned_chunks()])
    port = _find_free_port()
    runner = AppRunner(app)
    await runner.setup()
    await TCPSite(runner, "127.0.0.1", port).start()
    try:
        yield (f"http://127.0.0.1:{port}/v1", recorded)
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_memory_appears_in_system_prompt(
    recording: tuple[str, list[dict]], tmp_path: pathlib.Path,
) -> None:
    base_url, recorded = recording
    store = FilesystemMemoryStore(root=tmp_path)
    await store.save(Memory(
        name="Python testing preference",
        description="user prefers pytest for testing python",
        type="user",
        content="User prefers pytest and uses fixtures heavily when testing python.",
    ))

    llm = OpenAiCompatLlmClient(base_url=base_url)
    async with await Agent.create(
        llm=llm,
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        system_prompt="BASE",
        memory=store,
    ) as agent:
        async for _ in agent.prompt("how should I run pytest testing for python?"):
            pass

    system_msg = recorded[0]["messages"][0]
    assert system_msg["role"] == "system"
    assert "<memory" in system_msg["content"]
    assert "Python testing preference" in system_msg["content"]
    assert "pytest" in system_msg["content"]
