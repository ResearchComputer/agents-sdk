"""E2E fixtures: boot mock server, yield base URL."""
from __future__ import annotations

import socket
from typing import AsyncIterator

import pytest_asyncio
from aiohttp.web_runner import AppRunner, TCPSite

from tests.e2e.mock_server import make_mock_app, default_canned_chunks


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def mock_llm_base_url() -> AsyncIterator[str]:
    port = _find_free_port()
    app = make_mock_app(default_canned_chunks())
    runner = AppRunner(app)
    await runner.setup()
    site = TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        yield f"http://127.0.0.1:{port}/v1"
    finally:
        await runner.cleanup()
