"""FilesystemMemoryStore round-trip + Node-format parity."""
from __future__ import annotations

import pathlib

import pytest

from flash_agents.memory import FilesystemMemoryStore, Memory


@pytest.mark.asyncio
async def test_round_trip(tmp_path: pathlib.Path) -> None:
    store = FilesystemMemoryStore(root=tmp_path)
    m = Memory(
        name="Prefers Terse Responses",
        description="user likes short answers",
        type="user",
        content="body\nline2",
    )
    await store.save(m)
    loaded = await store.load()
    assert any(x.name == m.name and x.content.strip() == m.content.strip() for x in loaded)
    await store.remove(m.name)
    after = await store.load()
    assert all(x.name != m.name for x in after)


@pytest.mark.asyncio
async def test_sanitize_filename(tmp_path: pathlib.Path) -> None:
    store = FilesystemMemoryStore(root=tmp_path)
    m = Memory(name="Prefers Terse Responses!", description="d", type="user", content="b")
    await store.save(m)
    files = [p.name for p in tmp_path.iterdir()]
    assert "prefers-terse-responses.md" in files


@pytest.mark.asyncio
async def test_reads_node_written_fixture(tmp_path: pathlib.Path) -> None:
    (tmp_path / "my-note.md").write_text(
        "---\n"
        "name: my note\n"
        "description: a note\n"
        "type: user\n"
        "---\n\n"
        "body content\n"
    )
    store = FilesystemMemoryStore(root=tmp_path)
    loaded = await store.load()
    assert len(loaded) == 1
    assert loaded[0].name == "my note"
    assert loaded[0].description == "a note"
    assert loaded[0].type == "user"
    assert loaded[0].content.strip() == "body content"


@pytest.mark.asyncio
async def test_rejects_newlines_in_frontmatter_fields(tmp_path: pathlib.Path) -> None:
    store = FilesystemMemoryStore(root=tmp_path)
    with pytest.raises(ValueError, match="newlines"):
        await store.save(Memory(name="bad\nname", description="d", type="user", content="b"))
