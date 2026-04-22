# flash-agents — Python SDK Design

**Status:** Approved for implementation planning
**Date:** 2026-04-22
**Scope:** First-class Python SDK for `@researchcomputer/agents-sdk` core, distributed as the `flash-agents` pip package, living at `src/python/` in this repo.

## 1. Goals and non-goals

### Goals

- Pure-Python SDK that embeds `src/core/` via `wasmtime-py`. No Rust extension, no native build step for end users.
- Clean async API on top of the existing WASM-componentized core.
- Functioning **tool execution** end-to-end: Python-defined tools run during an agent turn, invoked by the LLM through the core.
- Pluggable **memory** with a filesystem-backed default compatible with the Node host's on-disk format.
- **MCP registration API** exposed and validated in v1; backend wiring staged.
- Single universal wheel (`py3-none-any`) bundling `core.wasm` as package data.
- Multi-turn conversations on a single `Agent` instance.
- Multiple independent `Agent` instances run in parallel with no shared state.

### Non-goals (v1)

- Feature parity with the full Node host (no Node-built-in tools like Read/Write/Edit/Bash/Glob/Grep/WebFetch auto-shipped — users define their own).
- MCP call execution (accept + register only).
- Telemetry routed out of WASM to Python.
- Windows wheels (Linux + macOS only; deferred until requested).
- Embedding-based memory retrieval (keyword heuristic only, matching Node).
- Agent-initiated memory writes (no built-in `remember` tool; users write via `store.save(...)`).
- Real-provider LLM clients beyond OpenAI-compatible (Anthropic/Bedrock deferred).

## 2. Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime host | `wasmtime-py` (pure Python) | Eliminates Rust/PyO3 maintenance burden from the existing stub; single wheel |
| Extension depth | Option 3: tools wired through WIT now; memory Python-side; MCP staged | Tools are what make this "agent" vs "LLM client"; memory retrieval is cleanly doable without WIT changes; MCP transports are too large for v1 |
| Memory default | `FilesystemMemoryStore` at `~/.flash-agents/memory/`, pluggable | Matches Node's `NodeMemoryStore` on-disk format so directories can be shared across hosts |
| API style | async-only | Matches event-stream semantics; no sync wrapper until users ask |
| Tool definition | `@tool` decorator **and** explicit `Tool` class | Decorator covers the 80% Pythonic case; class form is an escape hatch for precise JSON Schema |
| Python baseline | 3.11+ | Matches existing stub; wasmtime-py + aiohttp support is clean |
| Build backend | `hatchling` | Modern, good `force-include` support for `core.wasm` as data |
| HTTP client | `aiohttp` | Matches existing stub's choice; avoids a second async HTTP stack |
| Tool error payload | Includes raw traceback | User asked for it explicitly; debug value outweighs token cost |
| Concurrency model | Per-agent `asyncio.Lock`; agents are otherwise independent | Wasmtime components are single-threaded per instance |
| Memory injection | Per-turn `extra-system` WIT parameter (clean boundary) | Explicit in the WIT; avoids user-message-prefix trickery |

## 3. Package layout

```
src/python/
├── pyproject.toml                 # name = "flash-agents"; package = flash_agents
├── README.md
├── flash_agents/
│   ├── __init__.py                # public re-exports
│   ├── agent.py                   # Agent (async context mgr); wasmtime host
│   ├── tools/
│   │   ├── __init__.py            # @tool decorator, Tool class, ToolContext
│   │   └── registry.py            # internal registry + schema extraction
│   ├── llm/
│   │   ├── __init__.py            # LlmClient Protocol, LlmRequest
│   │   └── openai_compat.py       # OpenAiCompatLlmClient (aiohttp-based)
│   ├── memory/
│   │   ├── __init__.py            # MemoryStore Protocol, MemoryEntry
│   │   ├── filesystem.py          # FilesystemMemoryStore
│   │   └── retrieve.py            # keyword scoring; parity with Node retrieve()
│   ├── mcp/
│   │   └── __init__.py            # McpServer dataclass; registration API
│   ├── wasm/
│   │   ├── host.py                # wasmtime-py Component loader + host imports
│   │   └── core.wasm              # bundled artifact (package data)
│   ├── _events.py                 # AgentEvent TypedDicts
│   └── errors.py                  # FlashAgentError hierarchy
├── wit/
│   └── world.wit                  # authoritative WIT; imports host-llm + host-tools
├── wasm-guest/
│   ├── entrypoint.ts              # replaces examples/python-stub/wasm/entrypoint.ts
│   ├── adapters.ts                # tool adapter routes to host-tools; memory/MCP no-op
│   ├── llm-bridge.ts              # host-llm binding (reused from stub)
│   └── bun-build.ts               # Bun.build bundler for componentize input
└── tests/
    ├── unit/                      # pure Python, no WASM
    └── e2e/                       # mock server + loaded core.wasm
```

The existing `examples/python-stub/` is superseded by this layout. Migration of its useful pieces (wasm guest glue, mock server, LLM bridge) happens during implementation; the stub directory is removed in the final step.

## 4. WIT boundary

Authoritative WIT for v1. New interface is `host-tools`; `host-llm` is unchanged; `agent.prompt` adds an `extra-system: option<string>` parameter for per-turn memory/context injection.

```wit
package research-computer:flash-agents@0.1.0;

interface host-llm {
  record llm-request {
    model-id:      string,
    provider:      string,
    api:           string,
    system-prompt: string,
    messages-json: string,
    tools-json:    string,
    options-json:  string,
  }
  resource llm-stream { next: func() -> option<string>; }
  stream-llm: func(req: llm-request) -> llm-stream;
}

interface host-tools {
  record tool-call {
    call-id:    string,
    tool-name:  string,
    input-json: string,
  }
  record tool-result {
    call-id:    string,
    is-error:   bool,
    output-json: string,
  }
  /// Host returns JSON array of {name, description, inputSchema} objects.
  /// Called once at Agent construction time.
  list-tools: func() -> string;
  /// Called synchronously from the guest when the core invokes a tool.
  /// Sync-over-async at the WIT level; Python host bridges to its event loop.
  execute-tool: func(call: tool-call) -> tool-result;
}

interface agent {
  resource agent {
    constructor(config-json: string);
    prompt: func(message: string, extra-system: option<string>) -> event-stream;
  }
  resource event-stream { next: func() -> option<string>; }
}

world flash-agent-core {
  import host-llm;
  import host-tools;
  export agent;
}
```

**Why JSON blobs rather than structured WIT records:** matches the existing `messages-json` / `tools-json` convention, avoids re-declaring every pi-agent-core type in WIT, keeps componentize-js codegen small.

**Image input is deliberately omitted from the WIT `prompt`.** The core's `prompt(message, images?)` accepts image content, but Python image input is out of scope for v1 (see §10). When image support lands, `prompt` gains a third parameter (e.g., `images: option<list<u8>>` or `images-json: option<string>`); no other WIT changes required.

## 5. Core (`src/core/`) changes

Only one change is required in the core layer: the agent's existing `prompt(message, images?)` signature (see `src/core/factory.ts:813`) grows a third optional parameter `extraSystem?: string`. The returned Agent object shape (mcp, sessions, memory, swarm, costTracker, prompt, dispose, snapshot, fork, …) is otherwise unchanged.

- New signature: `prompt(message: string, images?: ImageContent[], extraSystem?: string): Promise<void>`.
- The internal turn loop in `src/core/factory.ts` concatenates `extraSystem` onto the assembled system prompt for that LLM call only. Not persisted into message history; does not mutate `config.systemPrompt`.
- Default parameter keeps existing callers (Node host, existing tests) unaffected.

**Migration note — WIT package rename.** The existing guest at `examples/python-stub/wasm/` uses `package research-computer:rc-agents@0.1.0` and imports from `research-computer:rc-agents/host-llm@0.1.0`. The new guest at `src/python/wasm-guest/` uses `research-computer:flash-agents@0.1.0`. Every `import * as … from "research-computer:rc-agents/…"` in `entrypoint.ts` / `llm-bridge.ts` changes to `research-computer:flash-agents/…` in lockstep with the WIT file. This only affects the new guest; the old stub's WIT is left alone during the transition and the stub directory is removed at the end.

**No other `src/core/` changes.** The wasm guest at `src/python/wasm-guest/entrypoint.ts` replaces the stub's `tools: []` with tools constructed from `host-tools.list-tools()` output. Each tool's `execute()` closure calls `host-tools.execute-tool(...)`. The new guest inherits the project-wide "no `node:*` imports in non-test core code" rule (CLAUDE.md); the guest is componentize-js input and must stay portable.

## 6. Python public API

### Agent

```python
from flash_agents import Agent

async with await Agent.create(
    llm=llm,
    model={"id": "gpt-4o", "provider": "openai", "api": "openai-completions"},
    system_prompt="You are a helpful assistant.",
    tools=[my_tool, WebFetch()],
    memory=FilesystemMemoryStore(),      # default if omitted
    mcp_servers=[McpServer(...)],         # registered but not dispatched in v1
    cwd="/home/me/project",
    memory_top_k=5,                       # default 5
) as agent:
    async for event in agent.prompt("Summarize README.md"):
        ...
    async for event in agent.prompt("Now refactor it."):
        ...
```

- `Agent.create(...)` is async; returns an async context manager that owns the wasmtime component.
- Exactly one `asyncio.Lock` per agent protects every guest call. Concurrent `prompt()` calls on the same agent serialize. Separate agents share no state.
- `dispose()` is idempotent and runs automatically on `__aexit__`.

### Tools

Decorator form:

```python
from flash_agents import tool

@tool
async def read_file(path: str, *, max_bytes: int = 65536) -> str:
    """Read a UTF-8 text file from disk.

    Args:
        path: Absolute path to the file.
        max_bytes: Truncate after this many bytes.
    """
    ...
```

- Schema derived from `typing.get_type_hints` + `inspect.signature` + docstring Args/Returns parsing.
- Supported arg types: `str`, `int`, `float`, `bool`, `list[...]`, `dict[str, ...]`, `Optional[...]`, `Literal[...]`, `TypedDict`, dataclasses.
- Unsupported types raise `ConfigError` at decoration time with a pointer to the `Tool` class form.
- No pydantic dependency.

Class form:

```python
from flash_agents import Tool, ToolContext

class WebFetch(Tool):
    name = "web_fetch"
    description = "Fetch a URL and return its text."
    input_schema = {
        "type": "object",
        "properties": {"url": {"type": "string", "format": "uri"}},
        "required": ["url"],
    }
    async def execute(self, args: dict, ctx: ToolContext) -> str: ...
```

`tools=[...]` accepts decorated callables, `Tool` subclasses, or `Tool` instances. Internally all normalize to a single canonical shape before being handed to the guest via `list-tools`.

**`ToolContext` access:** `Tool` subclasses receive `ctx` as the second `execute()` parameter. For `@tool`-decorated functions, `ctx` is **opt-in** — if the function signature includes a parameter named `ctx` with annotation `ToolContext`, it is injected and excluded from the generated JSON Schema; otherwise it is not passed. This keeps the common case (tools that don't need context) clean while giving decorated tools a clear way to reach `cwd`, `call_id`, and the logger.

### LLM clients

```python
from typing import Protocol, AsyncIterator
from dataclasses import dataclass

@dataclass
class LlmRequest:
    model_id: str
    provider: str
    api: str
    system_prompt: str
    messages_json: str
    tools_json: str
    options_json: str

class LlmClient(Protocol):
    def stream(self, req: LlmRequest) -> AsyncIterator[str]: ...
```

- `OpenAiCompatLlmClient(base_url, api_key=None, ...)` is the one built-in. SSE streaming via `aiohttp`. Returns JSON-encoded pi-agent-core `AssistantMessageEvent`s matching the existing stub's contract.

### Memory

The Python `Memory` dataclass mirrors core's `Memory` interface (`src/core/types.ts:72`) verbatim — same field names, same types, same semantics — so a `retrieve()` scoring function can match Node's output for shared fixtures.

```python
from typing import Protocol, Literal
from dataclasses import dataclass

MemoryType = Literal["user", "feedback", "project", "reference"]

@dataclass
class Memory:
    name: str              # matches core Memory.name; used as remove() key
    description: str       # matches core Memory.description
    type: MemoryType       # matches core Memory.type
    content: str           # matches core Memory.content

class MemoryStore(Protocol):
    async def load(self) -> list[Memory]: ...
    async def save(self, memory: Memory) -> None: ...
    async def remove(self, name: str) -> None: ...
```

- `FilesystemMemoryStore(root="~/.flash-agents/memory")` is the default when `memory=` is omitted. On-disk format is **bit-compatible with `createNodeMemoryStore` in `src/node/memory/node-memory-store.ts`**: one `.md` file per memory, three-field frontmatter (`name`, `description`, `type`) — **not full YAML**, just line-regex-parseable — followed by `\n---\n\n{content}\n`. Filenames are `sanitizeFilename(name) + ".md"` where `sanitizeFilename` lowercases then maps `[^a-z0-9_-]` → `-`, collapses consecutive `-`, and trims leading/trailing `-`. Files are atomically written via tmp-and-rename. A directory written by Node can be read by Python and vice versa.
- We depend on `pyyaml` only to *defensively* parse a malformed/extended frontmatter cleanly; writes use the same three-line format Node writes.
- `Agent.create(memory=None)` disables memory entirely (no loads, no injection).
- Retrieval happens per-turn: `load()` → `retrieve(memories, query, top_k)` keyword scoring → serialized `<memory>...</memory>` block passed as `extra-system` on the WIT `prompt` call.
- No embedding retrieval; no agent-initiated writes; no cache beyond a single `load()`'s result.

### MCP (registration only in v1)

```python
from dataclasses import dataclass

@dataclass
class McpServer:
    name: str
    command: list[str]       # stdio transport (most common)
    args: list[str] | None = None
    env: dict[str, str] | None = None
```

- Accepted by `Agent.create(mcp_servers=[...])`; validated (duplicate names raise `ConfigError`).
- Non-empty list emits a one-time `UserWarning`: `"MCP server registration is accepted but not yet dispatched; wiring lands in a future release."` So users don't silently assume MCP is working.

### Events

`agent.prompt(...)` yields typed dicts matching **pi-agent-core's `AgentEvent` union** exactly (see `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts`, exported as `AgentEvent`). The variants and their fields are:

| `type` | Additional fields |
|---|---|
| `agent_start` | — |
| `agent_end` | `messages: AgentMessage[]` |
| `turn_start` | — |
| `turn_end` | `message: AgentMessage`, `toolResults: ToolResultMessage[]` |
| `message_start` | `message: AgentMessage` |
| `message_update` | `message: AgentMessage`, `assistantMessageEvent: AssistantMessageEvent` |
| `message_end` | `message: AgentMessage` |
| `tool_execution_start` | `toolCallId: string`, `toolName: string`, `args: any` |
| `tool_execution_update` | `toolCallId: string`, `toolName: string`, `args: any`, `partialResult: any` |
| `tool_execution_end` | `toolCallId: string`, `toolName: string`, `result: any`, `isError: bool` |

`flash_agents._events` exports one `TypedDict` per variant plus `AgentEvent` as a `typing.Union` for type hints. Field names are preserved in camelCase (matching the JSON coming out of the guest) rather than re-cased to snake_case — this keeps the Python-side shape drop-in compatible with the JSON each event is encoded as across the WIT boundary.

### Errors

```python
class FlashAgentError(Exception): ...
class ConfigError(FlashAgentError): ...
class WasmHostError(FlashAgentError): ...
class LlmError(FlashAgentError): ...
class ToolError(FlashAgentError): ...
```

- `ConfigError` raised synchronously during `Agent.create(...)` or `@tool` decoration.
- `LlmError` raised from `LlmClient.stream(...)` surfaces as a `message_end` event with `stopReason: "error"`.
- Tool exceptions become `tool-result { is_error: true, output_json: {"error", "type", "traceback"} }` and are fed back to the LLM for recovery. `tool_execution_end` events carry `isError: true`. Tool exceptions do **not** propagate out of `agent.prompt()`.
- `WasmHostError` is the only structural failure that escapes `agent.prompt()`.

## 7. Tool wiring — control flow

### At `Agent.create(...)`

1. Normalize `tools=[...]` into canonical `Tool` records (`{name, description, input_schema, execute}`). Decorator form runs schema inference here.
2. Capture `asyncio.get_running_loop()` on the `Agent` instance — the agent is **bound to the loop that created it**. Using the agent from a different loop raises `WasmHostError`. (Check at each public call: compare `get_running_loop()` to the captured loop.)
3. Instantiate the wasmtime Component with these imported interfaces:
   - `host-llm.stream_llm` → wraps the user's `LlmClient`.
   - `host-tools.list_tools` → returns `json.dumps([...])`.
   - `host-tools.execute_tool` → see below.
4. Guest constructor calls `host-tools.list-tools()`, builds `SdkTool[]` whose `execute()` closure calls back into `host-tools.execute-tool`, and passes them to `createAgentCore({ tools })`.

### Execution model — avoiding deadlock

Wasmtime guest calls are synchronous from WIT's perspective and block the calling thread until they return. If we invoke the component directly on the asyncio event loop and the guest then calls back into `execute-tool` which needs to await a Python coroutine, the loop is blocked inside the guest call and the tool coroutine can never progress → deadlock.

Fix: **all guest calls run in a worker thread via `asyncio.to_thread(...)`**, not directly on the loop. Concretely:

- `await agent.prompt(msg, extra)` is `await asyncio.to_thread(self._component_prompt, msg, extra)`. `_component_prompt` is a plain (non-async) function that calls the wasmtime component and returns an opaque event-stream handle. The event-stream `.next()` calls likewise run via `asyncio.to_thread(...)` so each event pull is offloaded.
- When the guest calls `host-tools.execute-tool` from inside that worker thread, the Python host implementation of `execute-tool` schedules the registered tool coroutine **back onto the captured main loop** via `asyncio.run_coroutine_threadsafe(tool(args), self._loop).result()` — this blocks the worker thread (safe; it is not the loop) while the loop runs the coroutine (including any async HTTP the tool makes). When the coroutine returns, the worker thread resumes, returns the `ToolResult` to the guest, and the guest resumes its turn.

This pattern is deadlock-free as long as the agent's captured loop is the one currently running when `agent.prompt(...)` is awaited — which is enforced by the loop-binding check in step 2 above.

### During a turn

1. `await agent.prompt("…", extra_system=<memory block>)` → dispatched to worker thread; wasmtime guest returns an `event-stream`; Python drains it via `async for`, each pull offloaded with `asyncio.to_thread`.
2. Core decides to invoke a tool → middleware runs the `SdkTool.execute(args, ctx)` closure → closure calls `host-tools.execute-tool({call_id, tool_name, input_json})`.
3. Python host impl (running on the worker thread):
   - Looks up the tool by name in the registry.
   - Parses `input_json`; coerces to the tool's typed arg shape.
   - `asyncio.run_coroutine_threadsafe(tool(args, ctx), self._loop).result()` — blocks the worker thread, runs the tool on the main loop.
   - Success → `ToolResult(call_id, is_error=False, output_json=json.dumps(result))`.
   - Exception → `ToolResult(call_id, is_error=True, output_json=json.dumps({"error": str(exc), "type": type(exc).__name__, "traceback": traceback.format_exc()}))`.
4. Core emits `tool_execution_start` / `tool_execution_update` / `tool_execution_end` events through the same event stream (names from pi-agent-core's `AgentEvent` union, see §6 Events).

### Concurrency

- Wasmtime Components are single-threaded per instance; the per-agent `asyncio.Lock` around every guest call enforces this.
- Separate `Agent` instances own independent wasmtime components and run in parallel without coordination. Each has its own worker-thread dispatch.
- The agent is bound to its creator loop; using it from another loop raises `WasmHostError`.

## 8. Build & distribution

### Wheel build

1. `bun run build:wasm:python` (new script in root `package.json`):
   - `Bun.build()` bundles `src/python/wasm-guest/entrypoint.ts` → `core.bundle.js`.
   - `jco componentize` wraps it against `src/python/wit/world.wit` → `src/python/flash_agents/wasm/core.wasm`.
2. `hatchling` custom build hook verifies `core.wasm` exists before packaging; fails fast if the bun step was skipped.
3. `core.wasm` ships as package data via `[tool.hatch.build.targets.wheel.force-include]`.
4. Output: one universal wheel (`flash_agents-X.Y.Z-py3-none-any.whl`).

### Runtime dependencies

- `wasmtime >= 25.0` — the `wasmtime-py` package on PyPI, which provides Python bindings to the `wasmtime` runtime. It ships **platform-specific prebuilt wheels** (Linux/macOS x86_64 + arm64, Windows x86_64 — we test only the first two). The flash-agents wheel itself is pure Python; the platform-specific artifact comes from this dependency. On an unsupported platform `pip install flash-agents` fails at the wasmtime-py wheel selection step with a clear error — we do not attempt to wrap that.
- `aiohttp >= 3.9`
- `pyyaml >= 6.0`

No pydantic, no numpy.

### Dev dependencies

- `pytest`, `pytest-asyncio`, `aiohttp` (mock OpenAI server for e2e).

### User install

```bash
pip install flash-agents
```

No Rust, no Node, no Bun needed on user machines. Only Python ≥ 3.11 and wasmtime-py's prebuilt wheel support (Linux/macOS x86_64 + arm64).

### Version coupling

Build script writes `flash_agents.__version__` and the bundled WIT package version from the TS package version, so users can see which core is bundled. The build also writes a `flash_agents.wasm.CORE_WASM_SHA256` constant — the SHA-256 of `core.wasm` at build time — and `flash_agents.wasm.host` verifies it against the file it loads at runtime. A mismatch (user upgraded TS core but kept an old wheel data file; or package data got corrupted) raises `WasmHostError` at `Agent.create()` time rather than failing silently deep inside a turn.

## 9. Testing

### Unit (`tests/unit/`) — pure Python, no WASM

- `test_tool_decorator.py` — schema inference per supported arg type; `ConfigError` for unsupported.
- `test_tool_class.py` — subclass validation; duplicate-name detection.
- `test_filesystem_memory.py` — round-trip save/load/remove; atomic write behavior; frontmatter parity with Node fixtures (three-line `name`/`description`/`type` block; not full YAML).
- `test_openai_compat.py` — message translation + SSE parsing against `mock_server.py`.
- `test_retrieve.py` — scoring heuristic outputs identical to Node `retrieve()` for shared fixtures.

### E2E (`tests/e2e/`) — mock server + real `core.wasm`

- `test_one_turn.py` — adapted from existing stub.
- `test_multi_turn.py` — two `prompt()` calls preserve message history.
- `test_tool_call.py` — LLM invokes a `@tool` function; covers success, raising tool, schema-mismatch input.
- `test_tool_async_io.py` — explicitly exercises the deadlock-prone path: the registered tool `await`s an `aiohttp` GET against the mock server. Must complete without timeout; if the worker-thread/main-loop bridging is wrong the test hangs.
- `test_memory_injection.py` — entries from `FilesystemMemoryStore` appear in the `extra-system` block; Node-written fixtures round-trip unchanged.
- `test_concurrent_agents.py` — two `Agent` instances run concurrently without interference; one agent with two concurrent `prompt()` calls serializes.
- `test_loop_binding.py` — calling `agent.prompt()` from a different event loop than the one that created the agent raises `WasmHostError`.
- `test_mcp_registration_warning.py` — `mcp_servers=[...]` emits the "wiring staged" warning once.

### CI

- Build `core.wasm` in the same CI job via `bun run build:wasm:python`.
- Lint + unit + e2e on Python 3.11, 3.12, 3.13.
- Linux + macOS runners. No Windows in v1.

## 10. Out of scope (deferred)

Tracked for later milestones, explicitly not in v1:

- MCP call dispatch (registration API is forward-compatible).
- Telemetry routed out of WASM to Python.
- Built-in tools library (Read/Write/Edit/Bash/etc.) shipped with the SDK.
- Anthropic / Bedrock / other non-OpenAI-compatible providers.
- Agent-initiated memory writes (no `remember` tool).
- Embedding-based memory retrieval.
- Sync API wrapper.
- Windows wheels.
- Session persistence (SessionStore adapter is no-op in the guest).
- Hosted-auth flow (Node's `src/node/auth/` has no Python equivalent; users supply their own LLM credentials).
