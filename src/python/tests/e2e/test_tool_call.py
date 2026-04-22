"""E2E: LLM invokes a @tool; host executes it; turn continues with result."""
from __future__ import annotations

import socket
from typing import AsyncIterator

import pytest
import pytest_asyncio
from aiohttp.web_runner import AppRunner, TCPSite

from flash_agents import Agent, tool
from flash_agents.llm import OpenAiCompatLlmClient
from tests.e2e.mock_server import (
    make_recording_app,
    tool_call_chunks,
)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def two_turn_mock() -> AsyncIterator[tuple[str, list[dict]]]:
    """Turn 1: assistant invokes add(a=2, b=3). Turn 2: plain text reply."""
    chunks1 = tool_call_chunks("add", '{"a": 2, "b": 3}')
    chunks2 = [
        {
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "the result is 5"}, "finish_reason": "stop"}],
            "id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": 0, "model": "mock-gpt",
        }
    ]
    port = _find_free_port()
    app, recorded = make_recording_app([chunks1, chunks2])
    runner = AppRunner(app)
    await runner.setup()
    site = TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        yield (f"http://127.0.0.1:{port}/v1", recorded)
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_tool_call_success(two_turn_mock: tuple[str, list[dict]]) -> None:
    base_url, recorded = two_turn_mock

    @tool
    async def add(a: int, b: int) -> int:
        """Add two integers."""
        return a + b

    llm = OpenAiCompatLlmClient(base_url=base_url)
    tool_events = []
    async with await Agent.create(
        llm=llm,
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        system_prompt="",
        tools=[add],
    ) as agent:
        async for event in agent.prompt("what is 2+3?"):
            if event["type"] in {"tool_execution_start", "tool_execution_end"}:
                tool_events.append(event)

    starts = [e for e in tool_events if e["type"] == "tool_execution_start"]
    ends = [e for e in tool_events if e["type"] == "tool_execution_end"]
    assert len(starts) == 1
    assert len(ends) == 1
    assert ends[0]["isError"] is False
    assert ends[0]["toolName"] == "add"
    # Turn 2 request carries the tool_result in its messages history.
    turn2_roles = [m["role"] for m in recorded[1]["messages"]]
    assert "tool" in turn2_roles


@pytest.mark.asyncio
async def test_tool_call_raises_and_reports_traceback(
    two_turn_mock: tuple[str, list[dict]],
) -> None:
    base_url, recorded = two_turn_mock

    @tool
    async def add(a: int, b: int) -> int:
        """Intentionally fails."""
        raise ValueError("boom")

    llm = OpenAiCompatLlmClient(base_url=base_url)
    end_events = []
    async with await Agent.create(
        llm=llm,
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        system_prompt="",
        tools=[add],
    ) as agent:
        async for event in agent.prompt("what is 2+3?"):
            if event["type"] == "tool_execution_end":
                end_events.append(event)
    assert len(end_events) == 1
    assert end_events[0]["isError"] is True
    turn2_tool_msgs = [m for m in recorded[1]["messages"] if m["role"] == "tool"]
    assert len(turn2_tool_msgs) == 1
    content = turn2_tool_msgs[0]["content"]
    assert "ValueError" in content
    assert "boom" in content
    assert "Traceback" in content
