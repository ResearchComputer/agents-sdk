"""pi-ai Message[] <-> OpenAI chat-completions translation."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional

from flash_agents.llm.client import LlmRequest


# --- forward: pi-ai -> OpenAI --------------------------------------------


def pi_ai_to_openai_request(req: LlmRequest) -> dict:
    """Build the OpenAI chat-completions payload from the LlmRequest."""
    pi_messages = json.loads(req.messages_json)
    openai_messages: list[dict] = []
    if req.system_prompt:
        openai_messages.append({"role": "system", "content": req.system_prompt})
    for msg in pi_messages:
        openai_messages.append(_translate_message(msg))

    options = json.loads(req.options_json or "{}")
    payload: dict[str, Any] = {
        "model": req.model_id,
        "messages": openai_messages,
        "stream": True,
    }
    for key in ("temperature", "top_p", "max_tokens", "seed"):
        if key in options:
            payload[key] = options[key]
    return payload


def _translate_message(msg: dict) -> dict:
    """One pi-ai Message -> one OpenAI message dict."""
    role = msg.get("role")
    content = msg.get("content")
    if role == "user":
        return {"role": "user", "content": _flatten_text_content(content)}
    if role == "assistant":
        out: dict = {"role": "assistant", "content": _flatten_text_content(content) or None}
        tool_calls = [c for c in (content or []) if isinstance(c, dict) and c.get("type") == "toolCall"]
        if tool_calls:
            out["tool_calls"] = [
                {
                    "id": tc.get("id"),
                    "type": "function",
                    "function": {
                        "name": tc.get("name"),
                        "arguments": json.dumps(tc.get("arguments", {})),
                    },
                }
                for tc in tool_calls
            ]
        return out
    if role == "toolResult":
        return {
            "role": "tool",
            "tool_call_id": msg.get("toolCallId") or msg.get("tool_call_id"),
            "content": _flatten_text_content(content),
        }
    return {"role": role, "content": _flatten_text_content(content)}


def _flatten_text_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(item.get("text", ""))
    return "".join(parts)


# --- reverse: OpenAI SSE chunks -> pi-ai AssistantMessageEvents ----------


@dataclass
class OpenAiStreamDecoder:
    """Stateful decoder across OpenAI SSE chunks.

    Emits events matching pi-ai's `AssistantMessageEvent` discriminated
    union. Text-only path covered; delta.tool_calls decoding is exercised
    separately in Chunk 4.
    """
    model_id: str
    provider: str
    api: str
    _started: bool = False
    _text_started: bool = False
    _text_ended: bool = False
    _done_emitted: bool = False
    _accumulated_text: str = ""
    _timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def consume_chunk(self, chunk: dict) -> Iterator[dict]:
        choices = chunk.get("choices") or []
        if not choices:
            return
        choice = choices[0]
        delta = choice.get("delta") or {}
        finish_reason = choice.get("finish_reason")

        if not self._started:
            self._started = True
            yield {"type": "start", "partial": self._snapshot_message()}

        if "content" in delta and delta["content"]:
            if not self._text_started:
                self._text_started = True
                yield {"type": "text_start", "contentIndex": 0, "partial": self._snapshot_message()}
            self._accumulated_text += delta["content"]
            yield {
                "type": "text_delta",
                "contentIndex": 0,
                "delta": delta["content"],
                "partial": self._snapshot_message(),
            }

        if finish_reason is not None and not self._done_emitted:
            reason = _map_finish_reason(finish_reason)
            if self._text_started and not self._text_ended:
                self._text_ended = True
                yield {
                    "type": "text_end",
                    "contentIndex": 0,
                    "content": self._accumulated_text,
                    "partial": self._snapshot_message(),
                }
            self._done_emitted = True
            yield {
                "type": "done",
                "reason": reason,
                "message": self._snapshot_message(final=True, stop_reason=reason),
            }

    def make_final_if_needed(self) -> Optional[dict]:
        if self._done_emitted:
            return None
        if self._text_started and not self._text_ended:
            self._text_ended = True
        self._done_emitted = True
        return {
            "type": "done",
            "reason": "stop",
            "message": self._snapshot_message(final=True, stop_reason="stop"),
        }

    def make_error_event(self, error_message: str) -> dict:
        """Build an error-shaped AssistantMessageEvent per pi-ai's union."""
        self._done_emitted = True
        return {
            "type": "error",
            "reason": "error",
            "error": self._snapshot_message(final=True, stop_reason="error", error_message=error_message),
        }

    def _snapshot_message(
        self,
        final: bool = False,
        stop_reason: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> dict:
        msg: dict[str, Any] = {
            "role": "assistant",
            "content": [{"type": "text", "text": self._accumulated_text}],
            "api": self.api,
            "provider": self.provider,
            "model": self.model_id,
            "timestamp": self._timestamp_ms,
            "usage": _zero_usage(),
            "stopReason": stop_reason if (final and stop_reason is not None) else "stop",
        }
        if error_message is not None:
            msg["errorMessage"] = error_message
        return msg


def _map_finish_reason(openai_reason: str) -> str:
    """Map OpenAI finish_reason to pi-ai stopReason."""
    return {
        "stop": "stop",
        "length": "length",
        "tool_calls": "toolUse",
        "content_filter": "error",
    }.get(openai_reason, "stop")


def _zero_usage() -> dict:
    return {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0},
    }
