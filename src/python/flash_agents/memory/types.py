"""Memory dataclass + MemoryStore Protocol. Mirrors core's Memory shape."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

MemoryType = Literal["user", "feedback", "project", "reference"]


@dataclass(frozen=True)
class Memory:
    """Mirrors core's Memory (src/core/types.ts:72) — same fields, same semantics."""
    name: str
    description: str
    type: MemoryType
    content: str


class MemoryStore(Protocol):
    async def load(self) -> list[Memory]: ...
    async def save(self, memory: Memory) -> None: ...
    async def remove(self, name: str) -> None: ...
