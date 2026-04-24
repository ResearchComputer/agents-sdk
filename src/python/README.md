# flash-agents

Python SDK for `@researchcomputer/agents-sdk`. Runs the TypeScript agent
core as a WebAssembly Component via a Rust+PyO3+wasmtime host — no Node
runtime on the user's machine, just Python.

## Install (from source)

```bash
# From repo root — builds core.wasm
bun install
bun run build:wasm:python

# Build the Rust extension (PyO3/wasmtime)
cd src/python/wasm-host
maturin develop --release

# Install the flash-agents Python package
cd ../ && pip install -e ".[dev]"
pytest
```

## Quickstart

```python
import asyncio
from flash_agents import Agent, tool
from flash_agents.llm import OpenAiCompatLlmClient

@tool
async def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b

async def main():
    llm = OpenAiCompatLlmClient(base_url="https://api.openai.com/v1", api_key="...")
    async with await Agent.create(
        llm=llm,
        model={"id": "gpt-4o", "provider": "openai", "api": "openai-completions"},
        system_prompt="You are a helpful assistant.",
        tools=[add],
    ) as agent:
        async for event in agent.prompt("What is 2+3?"):
            if event["type"] == "message_update":
                for b in event["message"].get("content", []):
                    if b.get("type") == "text":
                        print(b["text"], end="", flush=True)

asyncio.run(main())
```

## Features (v1)

- Async multi-turn agent runs.
- User-defined Python tools via `@tool` decorator or `Tool` subclass.
- Filesystem-backed memory (`FilesystemMemoryStore`) — default path is
  `~/.rc-agents/memory`, matching the Node SDK, so memories round-trip
  across hosts. Override with `FLASH_AGENTS_MEMORY_DIR` or `root=`.
- MCP server **registration** (dispatch lands in a future release; v1
  warns when registrations are supplied).
- OpenAI-compatible LLM client built in; `LlmClient` Protocol for custom
  transports.

## Node SDK Parity Matrix (v1)

`flash-agents` v1 implements a subset of the Node SDK surface. This
matrix is the authoritative list of what currently works vs. what is
silently dropped by `parseConfig` in the WASM guest. Passing unsupported
fields to `Agent.create()` does not fail, but the feature is unavailable.

| Feature                        | Node SDK | flash-agents v1 | Notes                                |
|--------------------------------|----------|-----------------|--------------------------------------|
| Multi-turn `prompt()`          | Yes      | Yes             |                                      |
| Custom `@tool` / `Tool`        | Yes      | Yes             |                                      |
| Filesystem memory store        | Yes      | Yes             | `~/.rc-agents/memory` default (matches Node) |
| MCP server registration        | Yes      | Accepted, not dispatched | Wiring in a future release |
| OpenAI-compat LLM client       | Indirect | Yes             |                                      |
| Sessions (persist/restore)     | Yes      | No              | `sessionStore` is a no-op stub       |
| Snapshot / fork / autoFork     | Yes      | No              | `parseConfig` drops these fields     |
| Skills                         | Yes      | No              | Dropped by `parseConfig`             |
| Hooks (before/after turn)      | Yes      | No              | Dropped by `parseConfig`             |
| Permission rules               | Yes      | No (`allowAll`) | Dropped by `parseConfig`             |
| Swarm / multi-agent            | Yes      | No              | `SwarmManager` not exposed           |
| MCP tool dispatch              | Yes      | No              | Host stub throws on connect          |
| Telemetry                      | Yes      | No              | `telemetryOptOut: true`              |
| Auth token resolver            | Yes      | Stub            | Returns a fixed token                |
| `allowedRoots` sandbox         | Yes      | No              | Dropped by `parseConfig`             |

## Architecture

```
Python user code
   │
   ▼
flash_agents.Agent  (async context manager, asyncio.Lock)
   │
   ▼
flash_agents_wasm  (PyO3 + wasmtime-43 Rust extension, async via tokio)
   │
   ▼
core.wasm  (agents-sdk TypeScript core, WebAssembly Component)
   │
   ├─ host-llm     — Python LlmClient drives this
   ├─ host-tools   — Python @tool functions handle this
   └─ agent / event-stream — exported back to Python
```

## Spec + plan

- Spec: `docs/superpowers/specs/2026-04-22-flash-agents-python-sdk-design.md`
- Plan: `docs/superpowers/plans/2026-04-22-flash-agents-python-sdk.md`
