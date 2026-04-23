"""Unit: mcp_servers registration emits warning once and rejects duplicates."""
from __future__ import annotations

import warnings

import pytest

from flash_agents import Agent, ConfigError
from flash_agents.mcp import McpServer


class _NoopLlm:
    def stream(self, req):
        async def gen():
            yield
        return gen()


@pytest.mark.asyncio
async def test_mcp_servers_emit_warning() -> None:
    pytest.importorskip("flash_agents_wasm")
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        agent = await Agent.create(
            llm=_NoopLlm(),
            model={"id": "m", "provider": "openai", "api": "openai-completions"},
            mcp_servers=[McpServer(name="git", command=["mcp-git"])],
            memory=None,
        )
        await agent.dispose()
    assert any("mcp_servers" in str(x.message) for x in w)


@pytest.mark.asyncio
async def test_duplicate_mcp_name_raises() -> None:
    with pytest.raises(ConfigError, match="duplicate"):
        await Agent.create(
            llm=_NoopLlm(),
            model={"id": "m", "provider": "openai", "api": "openai-completions"},
            mcp_servers=[
                McpServer(name="x", command=["a"]),
                McpServer(name="x", command=["b"]),
            ],
            memory=None,
        )
