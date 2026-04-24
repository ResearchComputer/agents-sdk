"""Tool-chaining example.

Wires three `@tool`-decorated Python functions into one agent run:
  - `list_files(dir)`   — return filenames in a directory
  - `read_file(path)`   — return a file's contents
  - `word_count(text)`  — count words in a string

The agent must compose them to answer a question about a tiny scratch
codebase that this script seeds, then cleans up.

Run:
    export OPENAI_API_KEY=...
    python src/python/examples/tool_chain.py
"""
from __future__ import annotations

import asyncio
import os
import pathlib
import shutil
import tempfile

from flash_agents import Agent, tool
from flash_agents.llm import OpenAiCompatLlmClient


@tool
async def list_files(dir: str) -> list[str]:
    """List the filenames (no paths) in the given directory."""
    p = pathlib.Path(dir)
    return sorted(entry.name for entry in p.iterdir() if entry.is_file())


@tool
async def read_file(path: str) -> str:
    """Return the full text contents of a file."""
    return pathlib.Path(path).read_text(encoding="utf-8")


@tool
async def word_count(text: str) -> int:
    """Count whitespace-separated words in a string."""
    return len(text.split())


async def main() -> None:
    scratch = tempfile.mkdtemp(prefix="flash-tool-chain-")
    print(f"Scratch dir: {scratch}\n")

    try:
        # Seed a tiny "project" the agent can inspect.
        pathlib.Path(scratch, "intro.md").write_text(
            "This is a short introduction to the project.\n"
            "It has three sentences. Each one is quite small.\n",
            encoding="utf-8",
        )
        pathlib.Path(scratch, "notes.md").write_text(
            "alpha beta gamma delta epsilon zeta eta theta\n",
            encoding="utf-8",
        )

        llm = OpenAiCompatLlmClient(
            base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            api_key=os.environ.get("OPENAI_API_KEY"),
        )
        async with await Agent.create(
            llm=llm,
            model={
                "id": os.environ.get("MODEL_ID", "gpt-4o-mini"),
                "provider": "openai",
                "api": "openai-completions",
            },
            system_prompt=(
                "You are a file analyst. Use the provided tools to answer "
                "questions about files on disk. Never guess file contents."
            ),
            cwd=scratch,
            tools=[list_files, read_file, word_count],
            memory=None,  # don't persist memory for this example
        ) as agent:
            prompt = (
                f"In the directory {scratch!r}, list every file, then for each "
                "file report its word count. Give the final answer as a bullet list."
            )
            async for event in agent.prompt(prompt):
                if event["type"] == "message_update":
                    for b in event["message"].get("content") or []:
                        if isinstance(b, dict) and b.get("type") == "text":
                            print(b["text"], end="", flush=True)
            print()
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
