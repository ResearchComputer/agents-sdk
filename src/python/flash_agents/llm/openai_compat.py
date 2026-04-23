"""OpenAI-compatible LlmClient. Works against OpenAI, vLLM, Ollama,
llama.cpp server, LiteLLM, or any compatible mock."""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Optional

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

    The generator yields decoded events as SSE chunks arrive. If the
    consumer closes the generator early, aiohttp cleanup runs through the
    surrounding async context managers.
    """

    def __init__(self, base_url: str, api_key: Optional[str] = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key

    def stream(self, req: LlmRequest) -> AsyncIterator[str]:
        return _OpenAiCompatStream(self._base_url, self._api_key, req)


class _OpenAiCompatStream:
    def __init__(self, base_url: str, api_key: Optional[str], req: LlmRequest) -> None:
        self._payload = pi_ai_to_openai_request(req)
        self._url = f"{base_url}/chat/completions"
        self._headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        if api_key:
            self._headers["Authorization"] = f"Bearer {api_key}"
        self._decoder = OpenAiStreamDecoder(
            model_id=req.model_id,
            provider=req.provider,
            api=req.api,
        )
        self._session: aiohttp.ClientSession | None = None
        self._response: Any = None
        self._content_iter: Any = None
        self._pending: list[str] = []
        self._started = False
        self._closed = False

    def __aiter__(self) -> "_OpenAiCompatStream":
        return self

    async def __anext__(self) -> str:
        if self._pending:
            return self._pending.pop(0)
        if self._closed:
            raise StopAsyncIteration
        try:
            if not self._started:
                await self._start()
                if self._pending:
                    return self._pending.pop(0)
            while True:
                raw_line = await self._content_iter.__anext__()
                line = raw_line.decode("utf-8").rstrip("\n").rstrip("\r")
                if not line or line.startswith(":"):
                    continue
                if not line.startswith("data: "):
                    continue
                data = line[len("data: "):]
                if data == "[DONE]":
                    final = self._decoder.make_final_if_needed()
                    await self.aclose()
                    if final is not None:
                        return json.dumps(final)
                    raise StopAsyncIteration
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                self._pending.extend(
                    json.dumps(event) for event in self._decoder.consume_chunk(chunk)
                )
                if self._pending:
                    return self._pending.pop(0)
        except StopAsyncIteration:
            final = self._decoder.make_final_if_needed()
            await self.aclose()
            if final is not None:
                return json.dumps(final)
            raise
        except aiohttp.ClientError as err:
            await self.aclose()
            return json.dumps(self._decoder.make_error_event(f"connect error: {err}"))
        except Exception as err:  # noqa: BLE001 - contract: never raise
            await self.aclose()
            return json.dumps(self._decoder.make_error_event(f"unexpected error: {err}"))

    async def _start(self) -> None:
        self._started = True
        self._session = aiohttp.ClientSession()
        self._response = await self._session.post(
            self._url,
            json=self._payload,
            headers=self._headers,
        )
        if self._response.status != 200:
            body = await self._response.text()
            self._pending.append(
                json.dumps(self._decoder.make_error_event(f"HTTP {self._response.status}: {body[:200]}"))
            )
            await self.aclose()
            return
        self._content_iter = self._response.content.__aiter__()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._response is not None and hasattr(self._response, "release"):
            self._response.release()
        if self._session is not None and hasattr(self._session, "close"):
            await self._session.close()
