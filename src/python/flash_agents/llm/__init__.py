"""LlmClient Protocol, LlmRequest, and OpenAiCompatLlmClient."""

from flash_agents.llm.client import LlmClient, LlmRequest
from flash_agents.llm.openai_compat import OpenAiCompatLlmClient

__all__ = ["LlmClient", "LlmRequest", "OpenAiCompatLlmClient"]
