"""OpenAI-compatible LlmClient. Works against OpenAI, vLLM, Ollama,
llama.cpp server, LiteLLM, or any compatible mock."""

from __future__ import annotations

import json
from typing import AsyncIterator, Optional

import aiohttp

from flash_agents.llm.client import LlmRequest
from flash_agents.llm.message_translate import (
    pi_ai_to_openai_request,
    OpenAiStreamDecoder,
)


class OpenAiCompatLlmClient:
    """LlmClient that talks OpenAI Chat Completions over HTTP.

    Opens a fresh aiohttp session per stream() call. Sharing a session
    across a long-lived agent is a future optimization.

    Implementation note: the generator drains the HTTP response into a
    buffer inside the `async with` scope, then yields the buffered
    strings. This avoids "async generator ignored GeneratorExit" warnings
    when the generator is consumed across the Rust/Python FFI boundary
    where the consumer may abandon iteration without running aiohttp's
    session cleanup on the correct event loop.
    """

    def __init__(self, base_url: str, api_key: Optional[str] = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key

    async def stream(self, req: LlmRequest) -> AsyncIterator[str]:
        openai_payload = pi_ai_to_openai_request(req)
        url = f"{self._base_url}/chat/completions"
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        decoder = OpenAiStreamDecoder(
            model_id=req.model_id,
            provider=req.provider,
            api=req.api,
        )

        events: list[str] = []
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=openai_payload, headers=headers) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        events.append(json.dumps(
                            decoder.make_error_event(f"HTTP {resp.status}: {body[:200]}")
                        ))
                    else:
                        async for raw_line in resp.content:
                            line = raw_line.decode("utf-8").rstrip("\n").rstrip("\r")
                            if not line or line.startswith(":"):
                                continue
                            if not line.startswith("data: "):
                                continue
                            data = line[len("data: "):]
                            if data == "[DONE]":
                                final = decoder.make_final_if_needed()
                                if final is not None:
                                    events.append(json.dumps(final))
                                break
                            try:
                                chunk = json.loads(data)
                            except json.JSONDecodeError:
                                continue
                            for event in decoder.consume_chunk(chunk):
                                events.append(json.dumps(event))
        except aiohttp.ClientError as err:
            events.append(json.dumps(decoder.make_error_event(f"connect error: {err}")))
        except Exception as err:  # noqa: BLE001 - contract: never raise
            events.append(json.dumps(decoder.make_error_event(f"unexpected error: {err}")))

        for event in events:
            yield event
