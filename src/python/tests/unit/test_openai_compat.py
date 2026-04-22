"""Unit: pi-ai Message[] <-> OpenAI chat-completions translation."""
from __future__ import annotations

import json

from flash_agents.llm.client import LlmRequest
from flash_agents.llm.message_translate import (
    pi_ai_to_openai_request,
    OpenAiStreamDecoder,
)


def test_forward_translation_basic() -> None:
    req = LlmRequest(
        model_id="gpt-4o",
        provider="openai",
        api="openai-completions",
        system_prompt="SYS",
        messages_json=json.dumps([{"role": "user", "content": "hi"}]),
        tools_json="[]",
        options_json="{}",
    )
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
