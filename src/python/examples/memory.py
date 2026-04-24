"""Memory round-trip example.

Shows `FilesystemMemoryStore` outside of the agent loop:
  - save two memories into a scratch temp directory
  - load them back
  - score them against a query via `retrieve()`

No LLM calls, so no API key required.

Run:
    python src/python/examples/memory.py
"""
from __future__ import annotations

import asyncio
import shutil
import tempfile

from flash_agents.memory import FilesystemMemoryStore, Memory
from flash_agents.memory.retrieve import retrieve


async def main() -> None:
    scratch = tempfile.mkdtemp(prefix="flash-memory-")
    print(f"Scratch dir: {scratch}\n")

    try:
        store = FilesystemMemoryStore(root=scratch)

        await store.save(Memory(
            name="preferred-logger",
            description="Which logging library this codebase uses",
            type="project",
            content="This project uses pino for all logging.",
        ))
        await store.save(Memory(
            name="test-style",
            description="How tests are organized in this repo",
            type="feedback",
            content="Every feature ships with a Vitest file under the same directory.",
        ))

        # Reload from disk — these were persisted as .md files with frontmatter.
        loaded = await store.load()
        print(f"Loaded {len(loaded)} memories from disk:")
        for m in loaded:
            print(f"  - {m.name} [{m.type}]  {m.description}")
        print()

        # Relevance scoring against a query.
        query = "what logger should I use?"
        hits = retrieve(loaded, query=query, max_items=5)
        print(f'Top matches for "{query}":')
        for h in hits:
            print(f"  score={h.relevance_score:.4f}  {h.memory.name}")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
