"""Unit: retrieve() is a literal port of src/core/memory/retrieve.ts."""
from __future__ import annotations

from flash_agents.memory import Memory
from flash_agents.memory.retrieve import retrieve, _tokenize


def test_tokenizer_matches_word_non_word_split() -> None:
    # Node: text.toLowerCase().split(/\W+/).filter(t => t.length > 0)
    assert _tokenize("Hello, World! foo_bar") == ["hello", "world", "foo_bar"]


def test_scoring_tokenizes_description_and_content_only() -> None:
    mems = [
        Memory(name="python", description="about web frameworks", type="reference", content="flask and django"),
        Memory(name="x",      description="python testing",       type="reference", content="pytest fixtures"),
    ]
    out = retrieve(mems, query="python")
    assert len(out) == 1
    assert out[0].memory.name == "x"


def test_empty_query_returns_all_up_to_max_items() -> None:
    mems = [Memory(name=f"m{i}", description="d", type="user", content="c") for i in range(15)]
    out = retrieve(mems, query="", max_items=10)
    assert len(out) == 10
    assert all(s.relevance_score == 1.0 for s in out)


def test_max_items_caps_result_count() -> None:
    mems = [Memory(name=f"m{i}", description="python", type="user", content="pytest") for i in range(5)]
    out = retrieve(mems, query="python pytest", max_items=2)
    assert len(out) == 2


def test_stops_at_zero_score() -> None:
    mems = [
        Memory(name="a", description="python", type="user", content="py"),
        Memory(name="b", description="unrelated", type="user", content="nope"),
    ]
    out = retrieve(mems, query="python", max_items=10)
    assert len(out) == 1
    assert out[0].memory.name == "a"


def test_dedup_query_terms() -> None:
    mems = [Memory(name="m", description="python python python", type="user", content="")]
    score_once = retrieve(mems, query="python")[0].relevance_score
    score_repeated = retrieve(mems, query="python python python")[0].relevance_score
    assert score_once == score_repeated
