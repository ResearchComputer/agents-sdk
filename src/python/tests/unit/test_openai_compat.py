"""Unit: pi-ai Message[] <-> OpenAI chat-completions translation."""
from __future__ import annotations

import asyncio
import json

import pytest

import flash_agents
import flash_agents.llm.openai_compat as openai_compat_mod
from flash_agents.llm.client import LlmRequest
from flash_agents.llm.message_translate import (
    pi_ai_to_openai_request,
    OpenAiStreamDecoder,
)
from flash_agents.llm.openai_compat import OpenAiCompatLlmClient


def _basic_req() -> LlmRequest:
    return LlmRequest(
        model_id="gpt-4o",
        provider="openai",
        api="openai-completions",
        system_prompt="SYS",
        messages_json=json.dumps([{"role": "user", "content": "hi"}]),
        tools_json="[]",
        options_json="{}",
    )


def test_forward_translation_basic() -> None:
    req = _basic_req()
    payload = pi_ai_to_openai_request(req)
    assert payload["model"] == "gpt-4o"
    assert payload["stream"] is True
    assert payload["messages"][0] == {"role": "system", "content": "SYS"}
    assert payload["messages"][1] == {"role": "user", "content": "hi"}


def test_decoder_yields_start_text_done_sequence() -> None:
    dec = OpenAiStreamDecoder(model_id="gpt-4o", provider="openai", api="openai-completions")
    events = []
    events += list(dec.consume_chunk({"choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hi"}, "finish_reason": None}]}))
    events += list(dec.consume_chunk({"choices": [{"index": 0, "delta": {"content": ", world."}, "finish_reason": "stop"}]}))
    types = [e["type"] for e in events]
    assert types == ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]
    assert events[-1]["reason"] == "stop"
    assert events[-1]["message"]["content"][0]["text"] == "Hi, world."


def test_decoder_error_event() -> None:
    dec = OpenAiStreamDecoder(model_id="gpt-4o", provider="openai", api="openai-completions")
    ev = dec.make_error_event("connection refused")
    assert ev["type"] == "error"
    assert ev["reason"] == "error"
    assert ev["error"]["stopReason"] == "error"
    assert ev["error"]["errorMessage"] == "connection refused"


def test_top_level_package_does_not_import_native_extension_eagerly() -> None:
    assert flash_agents.ConfigError.__name__ == "ConfigError"


@pytest.mark.asyncio
async def test_openai_client_yields_before_stream_finishes(monkeypatch: pytest.MonkeyPatch) -> None:
    release_done = asyncio.Event()
    base = {
        "id": "chatcmpl-streaming",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-4o",
    }

    class _FakeContent:
        async def __aiter__(self):
            chunk = {
                **base,
                "choices": [
                    {"index": 0, "delta": {"role": "assistant", "content": "Hi"}, "finish_reason": None}
                ],
            }
            yield f"data: {json.dumps(chunk)}\n\n".encode("utf-8")
            await release_done.wait()
            done = {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            yield f"data: {json.dumps(done)}\n\n".encode("utf-8")
            yield b"data: [DONE]\n\n"

    class _FakeResponse:
        status = 200
        content = _FakeContent()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info: object) -> None:
            return None

    class _FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info: object) -> None:
            return None

        async def post(self, *args: object, **kwargs: object) -> _FakeResponse:
            return _FakeResponse()

    monkeypatch.setattr(openai_compat_mod.aiohttp, "ClientSession", _FakeSession)
    stream = OpenAiCompatLlmClient(base_url="http://example.test/v1").stream(_basic_req())
    try:
        first = await asyncio.wait_for(stream.__anext__(), timeout=1)
        assert json.loads(first)["type"] == "start"
    finally:
        release_done.set()
        await stream.aclose()
