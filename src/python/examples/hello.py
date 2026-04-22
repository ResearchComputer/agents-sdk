"""Minimal flash-agents example.

Run:
    export OPENAI_API_KEY=...
    python src/python/examples/hello.py
"""
from __future__ import annotations

import asyncio
import os

from flash_agents import Agent, tool
from flash_agents.llm import OpenAiCompatLlmClient


@tool
async def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


async def main() -> None:
    llm = OpenAiCompatLlmClient(
        base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        api_key=os.environ.get("OPENAI_API_KEY"),
    )
    async with await Agent.create(
        llm=llm,
        model={"id": "gpt-4o-mini", "provider": "openai", "api": "openai-completions"},
        system_prompt="You are a helpful assistant.",
        tools=[add],
    ) as agent:
        async for event in agent.prompt("What is 2+3? Use the add tool."):
            if event["type"] == "message_update":
                for b in (event["message"].get("content") or []):
                    if isinstance(b, dict) and b.get("type") == "text":
                        print(b["text"], end="", flush=True)
        print()


if __name__ == "__main__":
    asyncio.run(main())
