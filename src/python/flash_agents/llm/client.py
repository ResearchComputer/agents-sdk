"""LlmClient Protocol and LlmRequest record."""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator, Protocol


@dataclass(frozen=True)
class LlmRequest:
    """Mirrors the host-llm.llm-request WIT record.

    Field names are snake_case in Python; the Rust host converts between
    these and the camelCase kwargs used across the Rust/Python boundary.
    """
    model_id: str
    provider: str
    api: str
    system_prompt: str
    messages_json: str
    tools_json: str
    options_json: str


class LlmClient(Protocol):
    """Python-side counterpart to the core's TypeScript LlmClient.

    Contract: stream() MUST NOT raise. Transport failures encode as a
    final event with stopReason="error" (see pi-agent-core's StreamFn
    contract).
    """
    def stream(self, req: LlmRequest) -> AsyncIterator[str]: ...
