"""Mock OpenAI-compatible chat completions server for e2e tests.

Serves POST /v1/chat/completions with streaming SSE replaying canned
chunks. Deterministic — no real LLM, no network, no API key.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Iterable

from aiohttp import web


def default_canned_chunks() -> list[dict]:
    """A minimal successful streaming response: 'Hello, world.' in 3 deltas."""
    base = {
        "id": "chatcmpl-mock",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "mock-gpt",
    }
    return [
        {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hello"}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {"content": ", "}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {"content": "world."}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
    ]


def make_mock_app(
    chunks: Iterable[dict],
    *,
    delay_between_ms: int = 0,
    status: int = 200,
    error_body: str = "",
) -> web.Application:
    chunks_list = list(chunks)

    async def handler(request: web.Request) -> web.StreamResponse | web.Response:
        if status != 200:
            return web.Response(status=status, text=error_body)
        resp = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )
        await resp.prepare(request)
        for chunk in chunks_list:
            await resp.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
            if delay_between_ms > 0:
                await asyncio.sleep(delay_between_ms / 1000)
        await resp.write(b"data: [DONE]\n\n")
        await resp.write_eof()
        return resp

    app = web.Application()
    app.router.add_post("/v1/chat/completions", handler)
    return app


def tool_call_chunks(tool_name: str, arguments_json: str, call_id: str = "call_1") -> list[dict]:
    """Canned SSE chunks representing an assistant turn that invokes one tool."""
    base = {
        "id": "chatcmpl-mock-tool",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "mock-gpt",
    }
    return [
        {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [
            {"index": 0, "id": call_id, "type": "function", "function": {"name": tool_name, "arguments": ""}}
        ]}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": arguments_json}}
        ]}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
    ]


def make_recording_app(
    chunks_per_turn: list[list[dict]],
) -> tuple[web.Application, list[dict]]:
    """Each POST pops the next canned chunks and records the incoming payload."""
    recorded: list[dict] = []
    queue = list(chunks_per_turn)

    async def handler(request: web.Request) -> web.StreamResponse:
        body = await request.json()
        recorded.append(body)
        chunks = queue.pop(0) if queue else default_canned_chunks()
        resp = web.StreamResponse(
            status=200,
            headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"},
        )
        await resp.prepare(request)
        for chunk in chunks:
            await resp.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
        await resp.write(b"data: [DONE]\n\n")
        await resp.write_eof()
        return resp

    app = web.Application()
    app.router.add_post("/v1/chat/completions", handler)
    return app, recorded
