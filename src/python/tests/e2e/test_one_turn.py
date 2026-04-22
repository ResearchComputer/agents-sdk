"""E2E: one prompt() turn against the default mock streams 'Hello, world.'"""
from __future__ import annotations

import pytest

from flash_agents import Agent
from flash_agents.llm import OpenAiCompatLlmClient


@pytest.mark.asyncio
async def test_one_turn(mock_llm_base_url: str) -> None:
    llm = OpenAiCompatLlmClient(base_url=mock_llm_base_url)
    async with await Agent.create(
        llm=llm,
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        system_prompt="You are helpful.",
    ) as agent:
        final_text = ""
        types_seen: list[str] = []
        async for event in agent.prompt("Hello"):
            types_seen.append(event["type"])
            if event["type"] == "message_update":
                blocks = event["message"].get("content", []) or []
                for b in blocks:
                    if isinstance(b, dict) and b.get("type") == "text":
                        final_text = b.get("text", "")
    assert "agent_start" in types_seen
    assert "turn_end" in types_seen
    assert "agent_end" in types_seen
    assert final_text == "Hello, world."
