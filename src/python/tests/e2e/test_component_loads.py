"""Smoke: one prompt() turn against a mocked LlmClient drains a full
AgentEvent sequence from the Rust-backed host."""
from __future__ import annotations

import json

import pytest

from flash_agents import Agent


class _MockLlmClient:
    """Yields one `done` event with a canned assistant message."""
    def stream(self, req):
        async def gen():
            yield json.dumps({
                "type": "done",
                "reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "hi"}],
                    "api": "openai-completions",
                    "provider": "openai",
                    "model": "test",
                    "timestamp": 0,
                    "usage": {
                        "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                        "totalTokens": 0,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0,
                                 "cacheWrite": 0, "total": 0},
                    },
                    "stopReason": "stop",
                },
            })
        return gen()


@pytest.mark.asyncio
async def test_one_turn_drains_full_event_sequence() -> None:
    async with await Agent.create(
        llm=_MockLlmClient(),
        model={"id": "test", "provider": "openai", "api": "openai-completions"},
        system_prompt="SYS",
    ) as agent:
        types_seen: list[str] = []
        async for event in agent.prompt("hello"):
            types_seen.append(event["type"])
    assert "agent_start" in types_seen
    assert "turn_end" in types_seen
    assert "agent_end" in types_seen
