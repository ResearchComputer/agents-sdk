"""Filesystem-backed MemoryStore.

On-disk format matches Node's createNodeMemoryStore in
src/node/memory/node-memory-store.ts — the same three-field frontmatter
(name/description/type) and the same sanitize_filename rule — so a
directory written by one host reads cleanly from the other.
"""

from __future__ import annotations

import os
import pathlib
import re
from typing import cast

from flash_agents.memory.types import Memory, MemoryType


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)
_NAME_RE = re.compile(r"^name:\s*(.+)$", re.MULTILINE)
_DESC_RE = re.compile(r"^description:\s*(.+)$", re.MULTILINE)
_TYPE_RE = re.compile(r"^type:\s*(.+)$", re.MULTILINE)


def sanitize_filename(name: str) -> str:
    """Mirror of Node's sanitizeFilename in node-memory-store.ts."""
    s = name.lower()
    s = re.sub(r"[^a-z0-9_-]", "-", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


def _parse(content: str) -> Memory | None:
    m = _FRONTMATTER_RE.match(content)
    if not m:
        return None
    fm = m.group(1)
    body = m.group(2).strip()
    n = _NAME_RE.search(fm)
    d = _DESC_RE.search(fm)
    t = _TYPE_RE.search(fm)
    if not n or not d or not t:
        return None
    return Memory(
        name=n.group(1).strip(),
        description=d.group(1).strip(),
        type=cast(MemoryType, t.group(1).strip()),
        content=body,
    )


def _serialize(m: Memory) -> str:
    return (
        f"---\nname: {m.name}\ndescription: {m.description}\ntype: {m.type}\n"
        f"---\n\n{m.content}\n"
    )


def _assert_single_line(field: str, value: str) -> None:
    if "\n" in value or "\r" in value:
        raise ValueError(f"Memory {field} must not contain newlines: {value!r}")


class FilesystemMemoryStore:
    """One .md file per entry. Default root: ``~/.rc-agents/memory``.

    Matches the Node SDK default so memories round-trip across hosts
    without manual path configuration. Override with the
    ``FLASH_AGENTS_MEMORY_DIR`` env var or pass ``root=`` explicitly.
    """

    def __init__(self, root: str | pathlib.Path | None = None) -> None:
        if root is None:
            env = os.environ.get("FLASH_AGENTS_MEMORY_DIR")
            if env:
                root = pathlib.Path(env).expanduser()
            else:
                root = pathlib.Path("~/.rc-agents/memory").expanduser()
        self._root = pathlib.Path(root)

    async def load(self) -> list[Memory]:
        if not self._root.exists():
            return []
        out: list[Memory] = []
        for p in sorted(self._root.iterdir()):
            if not p.name.endswith(".md") or not p.is_file():
                continue
            parsed = _parse(p.read_text(encoding="utf-8"))
            if parsed is not None:
                out.append(parsed)
        return out

    async def save(self, memory: Memory) -> None:
        _assert_single_line("name", memory.name)
        _assert_single_line("description", memory.description)
        _assert_single_line("type", memory.type)
        self._root.mkdir(parents=True, exist_ok=True)
        filename = sanitize_filename(memory.name) + ".md"
        target = self._root / filename
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(_serialize(memory), encoding="utf-8")
        tmp.replace(target)

    async def remove(self, name: str) -> None:
        filename = sanitize_filename(name) + ".md"
        target = self._root / filename
        try:
            target.unlink()
        except FileNotFoundError:
            pass
