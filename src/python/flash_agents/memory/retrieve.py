"""Keyword-scoring retrieval — literal port of src/core/memory/retrieve.ts.

Parity, not invention: for a given (memories, query, max_items,
max_tokens) input the output matches the Node implementation for
shared fixtures. Algorithm details (from the reference):
- tokenize: text.toLowerCase().split(/\\W+/) filtering empties
- scoring: sum over unique query terms of (term_freq / word_count) in
  description + " " + content (NOT name)
- empty query: return all memories with relevance_score=1.0, most recent
  first, respecting max_tokens budget
- tiebreaker on non-empty query: higher updated_at wins
- truncate by max_items AND by max_tokens where item_tokens = ceil(len(content)/4)
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass

from flash_agents.memory.types import Memory


@dataclass(frozen=True)
class MemorySelection:
    memory: Memory
    relevance_score: float
    source: str
    updated_at: int


_NON_WORD = re.compile(r"\W+")


def _tokenize(text: str) -> list[str]:
    return [t for t in _NON_WORD.split(text.lower()) if t]


def _build_index(memory: Memory) -> tuple[dict[str, int], int]:
    tokens = _tokenize(memory.description + " " + memory.content)
    term_freq: dict[str, int] = {}
    for t in tokens:
        term_freq[t] = term_freq.get(t, 0) + 1
    return term_freq, (len(tokens) or 1)


def retrieve(
    memories: list[Memory],
    *,
    query: str,
    max_items: int = 10,
    max_tokens: float | None = None,
) -> list[MemorySelection]:
    token_budget_cap = math.inf if max_tokens is None else float(max_tokens)
    query_terms = _tokenize(query)
    now_ms = int(time.time() * 1000)

    # Empty-query: return all up to max_items, most-recent first.
    if not query_terms:
        results: list[MemorySelection] = []
        token_budget = 0.0
        for i, m in enumerate(memories):
            if len(results) >= max_items:
                break
            item_tokens = math.ceil(len(m.content) / 4)
            if token_budget + item_tokens > token_budget_cap:
                break
            token_budget += item_tokens
            results.append(MemorySelection(
                memory=m, relevance_score=1.0, source="memory", updated_at=now_ms - i,
            ))
        return results

    unique_terms = list(dict.fromkeys(query_terms))

    scored: list[MemorySelection] = []
    for i, m in enumerate(memories):
        term_freq, word_count = _build_index(m)
        score = 0.0
        for term in unique_terms:
            count = term_freq.get(term, 0)
            if count:
                score += count / word_count
        scored.append(MemorySelection(
            memory=m, relevance_score=score, source="memory", updated_at=now_ms - i,
        ))

    scored.sort(key=lambda s: (-s.relevance_score, -s.updated_at))

    results = []
    token_budget = 0.0
    for item in scored:
        if item.relevance_score == 0:
            break
        if len(results) >= max_items:
            break
        item_tokens = math.ceil(len(item.memory.content) / 4)
        if token_budget + item_tokens > token_budget_cap:
            break
        token_budget += item_tokens
        results.append(item)
    return results
