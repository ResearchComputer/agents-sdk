# flash-agents Python SDK Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `flash-agents`, a pure-Python SDK at `src/python/` that embeds the agents-sdk core via `wasmtime-py`, supports multi-turn agent runs with user-defined Python tools, filesystem-backed pluggable memory, and an MCP registration surface.

**Architecture:** The TypeScript core (`src/core/`) is componentized to `core.wasm` via `jco componentize`. A Python host (`flash_agents.wasm.host`) loads it via `wasmtime-py`, runs all guest calls in a worker thread via `asyncio.to_thread` to avoid deadlocking the event loop, and bridges tool executions back to the agent's creator loop via `asyncio.run_coroutine_threadsafe`. Tools/memory/MCP are first-class Python APIs; memory entries are injected per-turn via a new optional `extra-system` WIT parameter.

**Tech Stack:** Python 3.11+, `wasmtime-py >= 25.0`, `aiohttp >= 3.9`, `pyyaml >= 6.0`, `hatchling` build backend, `pytest` + `pytest-asyncio`. Guest build uses Bun + `jco componentize` (already in the repo).

**Spec:** `docs/superpowers/specs/2026-04-22-flash-agents-python-sdk-design.md`

---

## Chunk 1: Bootstrap — core change, WIT, and guest build pipeline

This chunk gets `core.wasm` building out of `src/python/wasm-guest/` against the new WIT. After it, subsequent chunks have a working componentized artifact to load from Python.

### Task 1.1: Add `extraSystem?` parameter to core `prompt()`

**Files:**
- Modify: `src/core/factory.ts:813-815`

**Why:** The spec's memory injection design calls for per-turn system context. `src/core/factory.ts:813` currently exposes `async prompt(message: string, images?: ImageContent[]): Promise<void>`. We grow a third optional parameter and plumb it into the internal `agent.prompt()` call. The parameter stays optional so every existing caller in `src/node/`, tests, and `examples/python-stub/` continues to compile unchanged.

- [ ] **Step 1: Read current prompt signature**

Run: `sed -n '810,816p' src/core/factory.ts`
Expected output (approximate):
```
    async prompt(message: string, images?: ImageContent[]): Promise<void> {
      await agent.prompt(message, images);
    },
```

- [ ] **Step 2: Confirm the PiAgent API for per-turn system prompt injection**

Run: `grep -n "setSystemPrompt\|state\b\|prompt(" node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts | head -20`

Expected: `setSystemPrompt(v: string): void`, a `state` getter (exposing `systemPrompt`), and `prompt(input: string, images?: ImageContent[]): Promise<void>`. PiAgent does **not** accept an extra-system argument directly; the implementation temporarily swaps the system prompt via `setSystemPrompt` around the `prompt` call.

- [ ] **Step 3: Write a failing test for the new parameter**

Create `src/core/extra-system.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createAgentCore } from './factory.js';
import { createTelemetryCollector } from './telemetry/collector.js';
import type { CoreAdapters, Memory } from './index.js';

function mkStubAdapters(onSystemPrompt: (systemPrompt: string) => void): CoreAdapters {
  return {
    memoryStore: { load: async () => [], save: async () => {}, remove: async () => {} },
    sessionStore: { load: async () => null, save: async () => {}, list: async () => [] },
    telemetryCollector: createTelemetryCollector({ optOut: true }),
    telemetrySink: { flush: async () => {} },
    mcpManager: {
      connect: async () => { throw new Error('no mcp'); },
      disconnect: async () => {},
      getTools: () => [],
      getConnections: () => [],
    },
    authTokenResolver: { resolve: async () => 'test' },
    telemetryOptOut: true,
    llmClient: {
      stream: async function* (_req) {
        onSystemPrompt(_req.systemPrompt);
        yield JSON.stringify({
          type: 'done',
          reason: 'stop',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            api: 'openai-completions',
            provider: 'openai',
            model: 'test',
            timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
          },
        });
      },
    },
  };
}

describe('prompt extraSystem', () => {
  it('appends extraSystem to the system prompt for the turn only', async () => {
    const observed: string[] = [];
    const core = await createAgentCore(
      {
        model: { id: 'test', provider: 'openai', api: 'openai-completions' } as any,
        systemPrompt: 'BASE',
        cwd: '/tmp',
        enableMemory: false,
        permissionMode: 'allowAll',
        tools: [],
        systemPromptHash: 'sha256:test',
      },
      mkStubAdapters((sp) => observed.push(sp)),
    );
    await core.prompt('first', undefined, '<memory>M1</memory>');
    await core.prompt('second');
    await core.dispose();
    expect(observed[0]).toContain('BASE');
    expect(observed[0]).toContain('<memory>M1</memory>');
    expect(observed[1]).toContain('BASE');
    expect(observed[1]).not.toContain('<memory>M1</memory>');
  });
});
```

- [ ] **Step 4: Run the test; expect failure**

Run: `bun x vitest run src/core/extra-system.test.ts`
Expected: test fails.

- [ ] **Step 5: Implement the parameter**

Edit `src/core/factory.ts:813-815` to:

```typescript
    async prompt(message: string, images?: ImageContent[], extraSystem?: string): Promise<void> {
      if (extraSystem) {
        const original = agent.state.systemPrompt;
        agent.setSystemPrompt(`${original}\n\n${extraSystem}`);
        try {
          await agent.prompt(message, images);
        } finally {
          agent.setSystemPrompt(original);
        }
        return;
      }
      await agent.prompt(message, images);
    },
```

`agent.state` is a getter that exposes the current agent state (including `systemPrompt`); `agent.setSystemPrompt(v)` is the canonical mutator. Both are declared in `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts`. The `try`/`finally` swap ensures the base system prompt is restored even if `agent.prompt()` throws; the change is scoped to this one turn and does not mutate `config.systemPrompt`.

- [ ] **Step 6: Run the test; expect pass**

Run: `bun x vitest run src/core/extra-system.test.ts`
Expected: pass.

- [ ] **Step 7: Run the full core test suite**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/factory.ts src/core/extra-system.test.ts
git commit -m "feat(core): prompt() accepts optional extraSystem for per-turn context"
```

---

### Task 1.2: Create the new WIT world

**Files:**
- Create: `src/python/wit/world.wit`

**Why:** This is the authoritative WIT contract the new guest targets, with the `host-tools` import added and `prompt` growing the `extra-system` parameter.

- [ ] **Step 1: Create the directory**

Run: `mkdir -p src/python/wit`

- [ ] **Step 2: Write the WIT file**

Create `src/python/wit/world.wit` with exactly this content:

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

  resource llm-stream {
    next: func() -> option<string>;
  }

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

  list-tools: func() -> string;

  execute-tool: func(call: tool-call) -> tool-result;
}

interface agent {
  resource agent {
    constructor(config-json: string);
    prompt: func(message: string, extra-system: option<string>) -> event-stream;
  }

  resource event-stream {
    next: func() -> option<string>;
  }
}

world flash-agent-core {
  import host-llm;
  import host-tools;
  export agent;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/python/wit/world.wit
git commit -m "feat(python): add flash-agents WIT world (host-llm + host-tools + prompt extra-system)"
```

---

### Task 1.3: Create Python package scaffolding with hatchling

**Files:**
- Create: `src/python/pyproject.toml`
- Create: `src/python/README.md`
- Create: `src/python/flash_agents/__init__.py` (empty stub for now)
- Create: `src/python/flash_agents/wasm/__init__.py`
- Create: `src/python/.gitignore`

- [ ] **Step 1: Create directory structure**

Run:
```bash
mkdir -p src/python/flash_agents/wasm
mkdir -p src/python/flash_agents/tools
mkdir -p src/python/flash_agents/llm
mkdir -p src/python/flash_agents/memory
mkdir -p src/python/flash_agents/mcp
mkdir -p src/python/tests/unit
mkdir -p src/python/tests/e2e
```

- [ ] **Step 2: Write `src/python/pyproject.toml`**

```toml
[build-system]
requires = ["hatchling>=1.24"]
build-backend = "hatchling.build"

[project]
name = "flash-agents"
version = "0.1.0"
description = "Python SDK for researchcomputer/agents-sdk — runs the WASM-componentized agent core from pure Python."
readme = "README.md"
requires-python = ">=3.11"
license = { text = "MIT" }
authors = [{ name = "Research Computer" }]
dependencies = [
  "wasmtime>=25.0",
  "aiohttp>=3.9",
  "pyyaml>=6.0",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.0",
  "pytest-asyncio>=0.23",
]

[tool.hatch.build.targets.wheel]
packages = ["flash_agents"]

[tool.hatch.build.targets.wheel.force-include]
"flash_agents/wasm/core.wasm" = "flash_agents/wasm/core.wasm"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

- [ ] **Step 3: Write `src/python/flash_agents/__init__.py`**

```python
"""flash-agents — Python SDK wrapping the agents-sdk core via WebAssembly."""

__version__ = "0.1.0"
```

- [ ] **Step 4: Write `src/python/flash_agents/wasm/__init__.py`**

```python
"""WASM host: loads core.wasm via wasmtime-py and drives the component."""
```

- [ ] **Step 5: Write `src/python/README.md`**

```markdown
# flash-agents

Python SDK for `@researchcomputer/agents-sdk`. Runs the agent core as a
WebAssembly Component via `wasmtime-py` — no Rust extension, no Node at
runtime.

See the spec: `docs/superpowers/specs/2026-04-22-flash-agents-python-sdk-design.md`

## Install (development)

```bash
bun install
bun run build:wasm:python

cd src/python
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```
```

- [ ] **Step 6: Write `src/python/.gitignore`**

```
.venv/
__pycache__/
*.pyc
dist/
build/
*.egg-info/
flash_agents/wasm/core.wasm
flash_agents/wasm/core.bundle.js
flash_agents/wasm/CORE_WASM_SHA256.txt
```

**Note on build ordering:** `pyproject.toml` force-includes `flash_agents/wasm/core.wasm` as package data, so building a wheel (or doing `pip install -e .`) fails if `bun run build:wasm:python` has not been run first. That's the intended behavior — `core.wasm` is not checked in.

- [ ] **Step 7: Commit**

```bash
git add src/python/pyproject.toml src/python/README.md src/python/flash_agents/__init__.py src/python/flash_agents/wasm/__init__.py src/python/.gitignore
git commit -m "feat(python): scaffold flash_agents package (hatchling + wasmtime + aiohttp + pyyaml)"
```

---

### Task 1.4: Write the wasm guest (TypeScript)

**Files:**
- Create: `src/python/wasm-guest/entrypoint.ts`
- Create: `src/python/wasm-guest/adapters.ts`
- Create: `src/python/wasm-guest/llm-bridge.ts`
- Create: `src/python/wasm-guest/bun-build.ts`
- Create: `src/python/wasm-guest/tsconfig.wasm.json`

- [ ] **Step 1: Make the directory**

Run: `mkdir -p src/python/wasm-guest`

- [ ] **Step 2: Write `src/python/wasm-guest/llm-bridge.ts`**

Copy the stub's bridge verbatim except the import path. Current file: `examples/python-stub/wasm/llm-bridge.ts`. Read it first with `cat examples/python-stub/wasm/llm-bridge.ts`. Only the WIT package URL in the imports needs updating to `research-computer:flash-agents/host-llm@0.1.0`.

- [ ] **Step 3: Write `src/python/wasm-guest/adapters.ts`**

```typescript
import type {
  CoreAdapters,
  MemoryStore,
  SessionStore,
  TelemetrySink,
  McpManager,
  AuthTokenResolver,
  LlmClient,
  SdkTool,
} from "../../core/index.js";
import { createTelemetryCollector } from "../../core/index.js";
import * as hostTools from "research-computer:flash-agents/host-tools@0.1.0";

const memoryStore: MemoryStore = {
  load: async () => [],
  save: async () => {},
  remove: async () => {},
};

const sessionStore: SessionStore = {
  load: async () => null,
  save: async () => {},
  list: async () => [],
};

const telemetrySink: TelemetrySink = { flush: async () => {} };

const mcpManager: McpManager = {
  connect: async () => { throw new Error("mcp not wired in flash-agents v1"); },
  disconnect: async () => {},
  getTools: () => [],
  getConnections: () => [],
};

const authTokenResolver: AuthTokenResolver = {
  resolve: async () => "flash-agents-token",
};

export function makeHostTools(): SdkTool[] {
  const listJson = hostTools.listTools();
  const decls = JSON.parse(listJson) as Array<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
  return decls.map((d): SdkTool => ({
    name: d.name,
    description: d.description,
    parameters: d.inputSchema as any, // typebox / JSON Schema; core does not validate structure here
    // SdkTool extends AgentTool from pi-agent-core. The execute signature
    // (see node_modules/@mariozechner/pi-agent-core/dist/types.d.ts:237) is:
    //   execute(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult<TDetails>>
    // Result must wrap in { output, details? } per AgentToolResult.
    async execute(
      toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
      _onUpdate?: (partial: unknown) => void,
    ): Promise<{ output: string; details?: unknown }> {
      const result = hostTools.executeTool({
        callId: toolCallId,
        toolName: d.name,
        inputJson: JSON.stringify(params ?? {}),
      });
      const parsed = JSON.parse(result.outputJson);
      if (result.isError) {
        // Core's afterToolCall middleware turns thrown errors into tool-result
        // messages with is_error=true for the LLM to see and recover from.
        const e: Error & { detail?: unknown } = new Error(
          typeof parsed === "object" && parsed && "error" in parsed
            ? String((parsed as any).error)
            : "tool error",
        );
        e.detail = parsed;
        throw e;
      }
      // AgentToolResult wants output as a string; if the tool returned a
      // structured value, stringify it. The core forwards `output` verbatim
      // as the tool-result message content.
      const output = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      return { output, details: parsed };
    },
  }));
}

export function makeStubAdapters(llmClient: LlmClient): CoreAdapters {
  return {
    memoryStore,
    sessionStore,
    telemetryCollector: createTelemetryCollector({ optOut: true }),
    telemetrySink,
    mcpManager,
    authTokenResolver,
    llmClient,
    telemetryOptOut: true,
  };
}
```

Note: in `src/core/types.ts`, the `SdkTool` callback property is named `execute` (matching the TS core). If your core's type names it differently, adjust the method name in the returned tool objects to match — this code wires the host-tools bridge to whatever callback shape the core's `SdkTool` requires.

- [ ] **Step 4: Write `src/python/wasm-guest/entrypoint.ts`**

```typescript
import {
  createAgentCore,
  type AgentCoreConfig,
} from "../../core/index.js";
import type { Model } from "@researchcomputer/ai-provider";
import { makeStubAdapters, makeHostTools } from "./adapters.js";
import { makeHostLlmClient } from "./llm-bridge.js";
import { createAgentEventCursor, type AgentEventCursor } from "./agent-events.js";
import * as hostLlm from "research-computer:flash-agents/host-llm@0.1.0";

class Agent {
  private _initPromise: Promise<Awaited<ReturnType<typeof createAgentCore>>>;

  constructor(configJson: string) {
    const parsed = parseConfig(configJson);
    const llmClient = makeHostLlmClient(hostLlm);
    const tools = makeHostTools();
    this._initPromise = createAgentCore(
      {
        model: parsed.model,
        systemPrompt: parsed.systemPrompt,
        cwd: parsed.cwd ?? "/wasm-stub",
        enableMemory: false,
        permissionMode: "allowAll",
        tools,
        systemPromptHash: "sha256:flash-agents",
      } as AgentCoreConfig,
      makeStubAdapters(llmClient),
    );
  }

  prompt(message: string, extraSystem: string | undefined): EventStream {
    return new EventStream(async (self) => {
      const core = await self._initPromise;
      const cursor = createAgentEventCursor(core.agent);
      const donePromise = core.prompt(message, undefined, extraSystem);
      return { cursor, donePromise };
    }, this);
  }

  async dispose(): Promise<void> {
    const core = await this._initPromise;
    await core.dispose();
  }
}

class EventStream {
  private _cursor: Promise<AgentEventCursor>;
  private _donePromise: Promise<unknown>;
  private _closed = false;

  constructor(
    init: (self: Agent) => Promise<{ cursor: AgentEventCursor; donePromise: Promise<unknown> }>,
    self: Agent,
  ) {
    const initialized = init(self);
    this._cursor = initialized.then((x) => x.cursor);
    this._donePromise = initialized.then((x) => x.donePromise);
  }

  async next(): Promise<string | undefined> {
    if (this._closed) return undefined;
    const cursor = await this._cursor;
    const event = await cursor.next();
    if (event === undefined) {
      try { await this._donePromise; } catch { /* noop */ }
      this._closed = true;
      return undefined;
    }
    return JSON.stringify(event);
  }
}

function parseConfig(json: string): {
  model: Model<any>;
  systemPrompt?: string;
  cwd?: string;
} {
  const raw = JSON.parse(json) as {
    model: Model<any>;
    systemPrompt?: string;
    "system-prompt"?: string;
    cwd?: string;
  };
  if (!raw.model?.id || !raw.model?.provider || !raw.model?.api) {
    throw new Error("config-json must include { model: { id, provider, api, ... } }");
  }
  return {
    model: raw.model,
    systemPrompt: raw.systemPrompt ?? raw["system-prompt"],
    cwd: raw.cwd,
  };
}

export const agent = { Agent, EventStream };
```

- [ ] **Step 5: Copy `agent-events.ts` from the stub**

Run: `cp examples/python-stub/wasm/agent-events.ts src/python/wasm-guest/agent-events.ts`

- [ ] **Step 6: Write `src/python/wasm-guest/tsconfig.wasm.json`**

Run: `cp examples/python-stub/wasm/tsconfig.wasm.json src/python/wasm-guest/tsconfig.wasm.json`

Verify paths; if the stub's config has `../../../src/core` (three levels up), the new file at `src/python/wasm-guest/tsconfig.wasm.json` needs `../../core` (two levels up) — adjust.

- [ ] **Step 7: Write `src/python/wasm-guest/bun-build.ts`**

Read `examples/python-stub/wasm/bun-build.ts`, copy to `src/python/wasm-guest/bun-build.ts`, changing:
- Input: `examples/python-stub/wasm/entrypoint.ts` → `src/python/wasm-guest/entrypoint.ts`.
- Output: → `src/python/flash_agents/wasm/core.bundle.js`.

- [ ] **Step 8: Commit**

```bash
git add src/python/wasm-guest/
git commit -m "feat(python): wasm guest (entrypoint, adapters with host-tools, llm-bridge, bun build)"
```

---

### Task 1.5: Wire the build into the root `package.json`

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Read current scripts**

Run: `grep -A 30 '"scripts":' package.json`

- [ ] **Step 2: Add three new scripts**

Edit `package.json` and add under `"scripts"`:

```json
"build:wasm:python": "bun run build:wasm:python:bundle && bun run build:wasm:python:componentize && bun run build:wasm:python:sha",
"build:wasm:python:bundle": "bun src/python/wasm-guest/bun-build.ts",
"build:wasm:python:componentize": "jco componentize src/python/flash_agents/wasm/core.bundle.js --wit src/python/wit/world.wit --world-name flash-agent-core --out src/python/flash_agents/wasm/core.wasm --enable-stdout",
"build:wasm:python:sha": "bun scripts/build-sha256.ts"
```

Then create `scripts/build-sha256.ts` (kept **outside** `src/python/wasm-guest/` so `tsconfig.wasm.json`'s WASM-targeted typecheck does not reject its `node:*` imports):

```typescript
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const wasmPath = "src/python/flash_agents/wasm/core.wasm";
const shaPath = "src/python/flash_agents/wasm/CORE_WASM_SHA256.txt";
const hex = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
writeFileSync(shaPath, hex + "\n");
console.log("core.wasm sha256:", hex);
```

- [ ] **Step 3: Run the new build**

Run: `bun run build:wasm:python`
Expected: files `src/python/flash_agents/wasm/core.wasm` and `CORE_WASM_SHA256.txt` exist. Final console line: `core.wasm sha256: <64-hex-chars>`.

- [ ] **Step 4: Inspect the component's exposed WIT to confirm**

Run: `bun x jco wit src/python/flash_agents/wasm/core.wasm | head -40`
Expected: output mentions `package research-computer:flash-agents@0.1.0`, `world flash-agent-core`, `import host-llm`, `import host-tools`, `export agent`.

- [ ] **Step 5: Commit**

```bash
mkdir -p scripts
git add package.json scripts/build-sha256.ts
git commit -m "build(wasm): add build:wasm:python pipeline (bundle + componentize + sha)"
```

---

### Task 1.6: Chunk 1 integration verification

- [ ] **Step 1: Full core test run**

Run: `bun run test`
Expected: all tests pass, including `src/core/extra-system.test.ts`.

- [ ] **Step 2: Build core.wasm from a clean state**

Run:
```bash
rm -f src/python/flash_agents/wasm/core.wasm src/python/flash_agents/wasm/core.bundle.js src/python/flash_agents/wasm/CORE_WASM_SHA256.txt
bun run build:wasm:python
```
Expected: `core.wasm` and `CORE_WASM_SHA256.txt` are produced with no warnings about missing WIT imports.

- [ ] **Step 3: Git status — only uncommitted artifacts are core.wasm/sha (gitignored)**

Run: `git status`
Expected: working tree clean.

---

## Chunk 2: Python package skeleton — Agent, WASM host, events, errors

This chunk produces a working one-turn-no-tools Python agent driven purely by `wasmtime-py`. It intentionally defers tools, memory, and MCP.

### Task 2.1: Write error hierarchy

**Files:**
- Create: `src/python/flash_agents/errors.py`

- [ ] **Step 1: Write the file**

```python
"""flash_agents exception hierarchy.

Contract summary:
- ConfigError: raised synchronously during Agent.create() or @tool
  decoration. Never reaches the WASM boundary.
- WasmHostError: structural failures (component load, SHA mismatch,
  wrong event loop, wasmtime trap). Propagates out of agent.prompt().
- LlmError: a user-supplied LlmClient.stream() may raise; surfaces
  back to the agent as a terminal message_end with stopReason=error.
- ToolError: raised by a user tool at call time. Fed back to the LLM
  as a tool-result with is_error=true; does NOT propagate out of
  agent.prompt().
"""


class FlashAgentError(Exception):
    """Base class for all flash_agents errors."""


class ConfigError(FlashAgentError):
    """Invalid configuration, bad tool schema, or other setup-time problem."""


class WasmHostError(FlashAgentError):
    """Structural failure in the WASM host layer."""


class LlmError(FlashAgentError):
    """Error raised from a user-supplied LlmClient.stream()."""


class ToolError(FlashAgentError):
    """Raised by a tool at execution time."""
```

- [ ] **Step 2: Commit**

```bash
git add src/python/flash_agents/errors.py
git commit -m "feat(python): error hierarchy"
```

---

### Task 2.2: Write typed event definitions

**Files:**
- Create: `src/python/flash_agents/_events.py`

**Why:** Users type-check their `async for event in agent.prompt(...)` loops against this. Names and fields mirror `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts:248`.

- [ ] **Step 1: Write the file**

```python
"""AgentEvent TypedDicts mirroring pi-agent-core's AgentEvent union.

Field names are camelCase because the events arrive as JSON from the
guest and we don't re-case at the boundary.

Canonical reference:
  node_modules/@mariozechner/pi-agent-core/dist/types.d.ts:248
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union


class _AgentStart(TypedDict):
    type: Literal["agent_start"]


class _AgentEnd(TypedDict):
    type: Literal["agent_end"]
    messages: list[dict]


class _TurnStart(TypedDict):
    type: Literal["turn_start"]


class _TurnEnd(TypedDict):
    type: Literal["turn_end"]
    message: dict
    toolResults: list[dict]


class _MessageStart(TypedDict):
    type: Literal["message_start"]
    message: dict


class _MessageUpdate(TypedDict):
    type: Literal["message_update"]
    message: dict
    assistantMessageEvent: dict


class _MessageEnd(TypedDict):
    type: Literal["message_end"]
    message: dict


class _ToolExecutionStart(TypedDict):
    type: Literal["tool_execution_start"]
    toolCallId: str
    toolName: str
    args: Any


class _ToolExecutionUpdate(TypedDict):
    type: Literal["tool_execution_update"]
    toolCallId: str
    toolName: str
    args: Any
    partialResult: Any


class _ToolExecutionEnd(TypedDict):
    type: Literal["tool_execution_end"]
    toolCallId: str
    toolName: str
    result: Any
    isError: bool


AgentEvent = Union[
    _AgentStart,
    _AgentEnd,
    _TurnStart,
    _TurnEnd,
    _MessageStart,
    _MessageUpdate,
    _MessageEnd,
    _ToolExecutionStart,
    _ToolExecutionUpdate,
    _ToolExecutionEnd,
]
```

- [ ] **Step 2: Commit**

```bash
git add src/python/flash_agents/_events.py
git commit -m "feat(python): AgentEvent TypedDicts"
```

---

### Task 2.3: Write the WASM host (loader + SHA check)

**Files:**
- Create: `src/python/flash_agents/wasm/host.py`

- [ ] **Step 1: Locate the wasmtime-py Component API**

Familiarize yourself with:
- `wasmtime.Store` — arena for one component instance
- `wasmtime.Engine` — shared wasm compilation context
- `wasmtime.Component.from_file(engine, path)` — load
- `wasmtime.Linker` — supplies imported interfaces

Reference: https://bytecodealliance.github.io/wasmtime-py/ (Component Model section). When in doubt, inspect the existing Rust host in `examples/python-stub/rust/src/` for control-flow inspiration; the Python equivalent uses `wasmtime` Python APIs but the host-import / resource / call pattern is the same.

- [ ] **Step 2: Write a failing test for SHA mismatch detection**

Create `src/python/tests/unit/test_wasm_host_sha.py`:

```python
"""SHA256 mismatch detection: altering core.wasm without rebuilding must fail fast."""
from __future__ import annotations

import pathlib
import pytest

from flash_agents.errors import WasmHostError
from flash_agents.wasm import host as host_mod


def test_sha_mismatch_raises(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_wasm = tmp_path / "core.wasm"
    fake_wasm.write_bytes(b"not really a wasm module")
    sha_file = tmp_path / "CORE_WASM_SHA256.txt"
    sha_file.write_text("0" * 64 + "\n")

    with pytest.raises(WasmHostError, match="SHA256 mismatch"):
        host_mod._verify_sha256(fake_wasm, sha_file)
```

- [ ] **Step 3: Run — expect failure**

Run: `cd src/python && pytest tests/unit/test_wasm_host_sha.py -v`
Expected: fails.

- [ ] **Step 4: Write `src/python/flash_agents/wasm/host.py`**

```python
"""WASM host: load core.wasm, verify its SHA, instantiate the component.

Concurrency contract:
- Every guest call runs in a worker thread via asyncio.to_thread(...).
- The agent captures its creator loop at Agent.create() time.
- Tool dispatch (added in Chunk 4) bridges worker thread -> main loop
  via asyncio.run_coroutine_threadsafe(..., captured_loop).result().
"""

from __future__ import annotations

import hashlib
import pathlib
import threading
from typing import Any, Callable

import wasmtime

from flash_agents.errors import WasmHostError


_WASM_DIR = pathlib.Path(__file__).parent
_CORE_WASM = _WASM_DIR / "core.wasm"
_SHA_FILE = _WASM_DIR / "CORE_WASM_SHA256.txt"


def _verify_sha256(wasm_path: pathlib.Path, sha_file: pathlib.Path) -> None:
    if not wasm_path.exists():
        raise WasmHostError(
            f"core.wasm not found at {wasm_path}. Run `bun run build:wasm:python` "
            f"from the repo root before installing flash-agents from source."
        )
    if not sha_file.exists():
        raise WasmHostError(
            f"CORE_WASM_SHA256.txt not found at {sha_file}. Rebuild core.wasm."
        )
    expected = sha_file.read_text().strip().lower()
    actual = hashlib.sha256(wasm_path.read_bytes()).hexdigest().lower()
    if expected != actual:
        raise WasmHostError(
            f"SHA256 mismatch on core.wasm: expected {expected}, got {actual}. "
            f"Rebuild via `bun run build:wasm:python`."
        )


class WasmHost:
    """Owns one loaded component + its wasmtime Store."""

    def __init__(self) -> None:
        _verify_sha256(_CORE_WASM, _SHA_FILE)
        self._engine = wasmtime.Engine()
        self._component = wasmtime.Component.from_file(self._engine, str(_CORE_WASM))
        self._store = wasmtime.Store(self._engine)
        self._call_lock = threading.Lock()
        self._linker = wasmtime.Linker(self._engine)

    def instantiate(
        self,
        *,
        host_llm_stream: Callable[[dict], Any],
        host_tools_list: Callable[[], str],
        host_tools_execute: Callable[[dict], dict],
    ) -> "WorldInstance":
        raise NotImplementedError(
            "Implementation fills this in Task 2.4 after verifying wasmtime-py API shape."
        )
```

- [ ] **Step 5: Run the SHA test — expect pass**

Run:
```bash
cd src/python
pip install -e ".[dev]"
pytest tests/unit/test_wasm_host_sha.py -v
```
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/python/flash_agents/wasm/host.py src/python/tests/unit/test_wasm_host_sha.py
git commit -m "feat(python): wasm host skeleton + sha256 verification"
```

---

### Task 2.4: Implement `WasmHost.instantiate()` and `WorldInstance`

**Files:**
- Modify: `src/python/flash_agents/wasm/host.py`

**Why:** Bind the host imports and expose synchronous functions (`prompt_sync`, `event_stream_next_sync`, `dispose_sync`) that the async Agent wraps via `asyncio.to_thread`. The binding is necessarily specific to `wasmtime-py`'s API.

- [ ] **Step 1: Explore wasmtime-py's bindgen for components**

```bash
python - <<'PY'
import wasmtime
print("wasmtime", wasmtime.__version__)
from wasmtime import Component, Linker, Engine, Store
print("Component.from_file:", hasattr(Component, "from_file"))
PY
```

Check whether `wasmtime.bindgen` exists, and/or whether `Linker.define_func` accepts per-interface function signatures. Use whichever idiom the installed version supports.

- [ ] **Step 2: Write a failing smoke test**

Create `src/python/tests/e2e/test_component_loads.py`:

```python
"""Smoke: WasmHost can load core.wasm and instantiate with no-op hosts."""
from __future__ import annotations

import pytest

from flash_agents.wasm.host import WasmHost


@pytest.mark.asyncio
async def test_component_instantiates() -> None:
    host = WasmHost()
    inst = host.instantiate(
        host_llm_stream=lambda req: _NoopStream(),
        host_tools_list=lambda: "[]",
        host_tools_execute=lambda call: {
            "callId": call["callId"],
            "isError": True,
            "outputJson": '{"error":"no tools","type":"NoopHost"}',
        },
    )
    assert inst is not None


class _NoopStream:
    def next(self) -> str | None:
        return None
```

- [ ] **Step 3: Run — expect NotImplementedError**

Run: `cd src/python && pytest tests/e2e/test_component_loads.py -v`

- [ ] **Step 4: Implement `instantiate()` and `WorldInstance`**

Replace the `NotImplementedError` in `WasmHost.instantiate` with the actual Linker wiring. The high-level shape (exact method names depend on wasmtime-py's API version):

```python
def instantiate(self, *, host_llm_stream, host_tools_list, host_tools_execute):
    self._linker.root().define_func(
        "research-computer:flash-agents/host-llm@0.1.0", "stream-llm",
        lambda req_record: host_llm_stream(self._record_to_dict(req_record)),
    )
    self._linker.root().define_func(
        "research-computer:flash-agents/host-tools@0.1.0", "list-tools",
        lambda: host_tools_list(),
    )
    self._linker.root().define_func(
        "research-computer:flash-agents/host-tools@0.1.0", "execute-tool",
        lambda call_record: self._dict_to_result_record(
            host_tools_execute(self._record_to_dict(call_record))
        ),
    )
    instance = self._linker.instantiate(self._store, self._component)
    exports = instance.exports(self._store)
    return WorldInstance(self, exports)
```

Add a `WorldInstance` class below `WasmHost`:

```python
class WorldInstance:
    def __init__(self, host: "WasmHost", exports: Any) -> None:
        self._host = host
        self._exports = exports
        self._agent_resource: Any | None = None

    def new_agent(self, config_json: str) -> None:
        with self._host._call_lock:
            self._agent_resource = self._exports["agent"]["agent"].constructor(
                self._host._store, config_json,
            )

    def prompt_sync(self, message: str, extra_system: str | None) -> Any:
        with self._host._call_lock:
            return self._exports["agent"]["agent"].prompt(
                self._host._store, self._agent_resource, message, extra_system,
            )

    def event_stream_next_sync(self, stream_handle: Any) -> str | None:
        with self._host._call_lock:
            return self._exports["agent"]["event-stream"].next(
                self._host._store, stream_handle,
            )

    def dispose_sync(self) -> None:
        if self._agent_resource is None:
            return
        with self._host._call_lock:
            self._exports["agent"]["agent"].drop(self._host._store, self._agent_resource)
            self._agent_resource = None
```

Notes on record marshalling: wasmtime-py represents WIT records as generated dataclass-like objects. Add helper methods `_record_to_dict` / `_dict_to_result_record` on `WasmHost` that convert between Python dicts (the rest of `flash_agents` speaks dicts) and those record objects. If the generated classes use snake_case (`call_id`), convert to/from camelCase (`callId`) here so the Python user code sees camelCase consistently with JSON events.

- [ ] **Step 5: Run the smoke test — expect pass**

Run: `cd src/python && pytest tests/e2e/test_component_loads.py -v`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/python/flash_agents/wasm/host.py src/python/tests/e2e/test_component_loads.py
git commit -m "feat(python): implement WasmHost.instantiate and WorldInstance call surface"
```

---

### Task 2.5: Write `flash_agents.Agent` — async facade over WasmHost

**Files:**
- Create: `src/python/flash_agents/agent.py`
- Modify: `src/python/flash_agents/__init__.py`

- [ ] **Step 1: Write a failing test for the loop-binding error**

Create `src/python/tests/unit/test_agent_loop_binding.py`:

```python
"""Agent must refuse calls from a different event loop than the one that created it."""
from __future__ import annotations

import asyncio
import pytest

from flash_agents import Agent
from flash_agents.errors import WasmHostError


@pytest.mark.asyncio
async def test_prompt_from_foreign_loop_raises() -> None:
    class _NoopLlm:
        async def stream(self, req):  # noqa: ARG002
            return
            yield

    agent = await Agent.create(
        llm=_NoopLlm(),
        model={"id": "m", "provider": "openai", "api": "openai-completions"},
        system_prompt="",
    )
    try:
        def run_in_other_loop() -> None:
            async def inner():
                async for _ in agent.prompt("hello"):
                    pass
            asyncio.new_event_loop().run_until_complete(inner())
        with pytest.raises(WasmHostError, match="different event loop"):
            await asyncio.to_thread(run_in_other_loop)
    finally:
        await agent.dispose()
```

- [ ] **Step 2: Run — expect ImportError**

Run: `cd src/python && pytest tests/unit/test_agent_loop_binding.py -v`

- [ ] **Step 3: Write `src/python/flash_agents/agent.py`**

```python
"""Agent — async facade over WasmHost.

Lifecycle:
    async with await Agent.create(...) as agent:
        async for event in agent.prompt("..."):
            ...
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Protocol

from flash_agents.errors import ConfigError, WasmHostError
from flash_agents.wasm.host import WasmHost, WorldInstance


class LlmClient(Protocol):
    def stream(self, req: Any) -> AsyncIterator[str]: ...


class Agent:
    def __init__(self, *, inst: WorldInstance, llm: LlmClient, loop: asyncio.AbstractEventLoop) -> None:
        self._inst = inst
        self._llm = llm
        self._loop = loop
        self._call_lock = asyncio.Lock()
        self._disposed = False

    @classmethod
    async def create(
        cls,
        *,
        llm: LlmClient,
        model: dict,
        system_prompt: str = "",
        cwd: str | None = None,
    ) -> "Agent":
        if not isinstance(model, dict) or not {"id", "provider", "api"} <= set(model):
            raise ConfigError("model must be a dict with keys 'id', 'provider', 'api'")

        loop = asyncio.get_running_loop()
        host = WasmHost()

        def _host_llm_stream(req: dict) -> "_LlmStream":
            return _LlmStream(llm, req, loop)

        def _host_tools_list() -> str:
            return "[]"  # No tools until Chunk 4.

        def _host_tools_execute(call: dict) -> dict:
            return {
                "callId": call["callId"],
                "isError": True,
                "outputJson": json.dumps({
                    "error": "no tools registered in this agent",
                    "type": "ConfigError",
                }),
            }

        inst = host.instantiate(
            host_llm_stream=_host_llm_stream,
            host_tools_list=_host_tools_list,
            host_tools_execute=_host_tools_execute,
        )
        config_json = json.dumps({
            "model": model,
            "systemPrompt": system_prompt,
            "cwd": cwd or "/flash-agents",
        })
        inst.new_agent(config_json)
        return cls(inst=inst, llm=llm, loop=loop)

    def _check_loop(self) -> None:
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is not self._loop:
            raise WasmHostError(
                "Agent is bound to a different event loop than the one calling it. "
                "Agents cannot be shared across event loops."
            )

    def prompt(self, message: str) -> AsyncIterator[dict]:
        """Returns an async iterator of AgentEvent dicts for one turn.

        NOT declared `async def`: we need `async for event in agent.prompt(...)`
        to work directly without an intervening `await`. A regular function
        that returns an async generator satisfies that usage — same pattern
        as examples/python-stub/py/rc_agents/agent.py.
        """
        self._check_loop()
        if self._disposed:
            raise WasmHostError("agent has been disposed")

        async def iterator() -> AsyncIterator[dict]:
            async with self._call_lock:
                # Each guest call runs on a worker thread so tool dispatch
                # (Chunk 4) can bridge back to the main loop without deadlock.
                stream_handle = await asyncio.to_thread(
                    self._inst.prompt_sync, message, None,
                )
                while True:
                    raw = await asyncio.to_thread(
                        self._inst.event_stream_next_sync, stream_handle,
                    )
                    if raw is None:
                        return
                    yield json.loads(raw)
        return iterator()

    async def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        await asyncio.to_thread(self._inst.dispose_sync)

    async def __aenter__(self) -> "Agent":
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.dispose()


class _LlmStream:
    """Sync-facing stream wrapping an async LlmClient.stream().

    The guest calls .next() synchronously from inside a wasmtime call that
    is itself running on a worker thread (asyncio.to_thread). We schedule
    the async generator on the creator loop and block the worker thread
    until each next() resolves.
    """

    def __init__(self, llm: LlmClient, req: dict, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._aiter_future = asyncio.run_coroutine_threadsafe(
            _start_llm_stream(llm, req), loop,
        )
        self._aiter: AsyncIterator[str] | None = None

    def next(self) -> str | None:
        if self._aiter is None:
            self._aiter = self._aiter_future.result()
        fut = asyncio.run_coroutine_threadsafe(_next_or_none(self._aiter), self._loop)
        return fut.result()


async def _start_llm_stream(llm: LlmClient, req: dict) -> AsyncIterator[str]:
    return llm.stream(_LlmRequestFromDict(**req))


async def _next_or_none(aiter: AsyncIterator[str]) -> str | None:
    try:
        return await aiter.__anext__()
    except StopAsyncIteration:
        return None


class _LlmRequestFromDict:
    """Lightweight holder for the llm-request fields."""
    def __init__(self, modelId: str, provider: str, api: str, systemPrompt: str,
                 messagesJson: str, toolsJson: str, optionsJson: str, **_: Any) -> None:
        self.model_id = modelId
        self.provider = provider
        self.api = api
        self.system_prompt = systemPrompt
        self.messages_json = messagesJson
        self.tools_json = toolsJson
        self.options_json = optionsJson
```

- [ ] **Step 4: Update `src/python/flash_agents/__init__.py`**

```python
"""flash-agents — Python SDK wrapping the agents-sdk core via WebAssembly."""

from flash_agents.agent import Agent
from flash_agents.errors import (
    ConfigError,
    FlashAgentError,
    LlmError,
    ToolError,
    WasmHostError,
)

__version__ = "0.1.0"

__all__ = [
    "Agent",
    "ConfigError",
    "FlashAgentError",
    "LlmError",
    "ToolError",
    "WasmHostError",
]
```

- [ ] **Step 5: Run the loop-binding test — expect pass**

Run: `cd src/python && pytest tests/unit/test_agent_loop_binding.py -v`
Expected: pass. If the no-op LLM hangs the turn, wrap the inner `async for` in `asyncio.wait_for(..., timeout=5.0)`.

- [ ] **Step 6: Commit**

```bash
git add src/python/flash_agents/agent.py src/python/flash_agents/__init__.py src/python/tests/unit/test_agent_loop_binding.py
git commit -m "feat(python): Agent async facade with loop-binding guard and serialization lock"
```

---

### Task 2.6: Chunk 2 integration verification

- [ ] **Step 1: Full unit test run**

Run: `cd src/python && pytest tests/unit -v`
Expected: all pass.

- [ ] **Step 2: Full e2e smoke run**

Run: `cd src/python && pytest tests/e2e -v`
Expected: `test_component_loads` passes.

---

## Chunk 3: LLM client + mock server + first real one-turn + multi-turn e2e

This chunk ports the OpenAI-compat LLM client and the mock SSE server from the existing stub, adjusts them for the new package, and adds the first real end-to-end tests that actually drive `core.wasm`.

### Task 3.1: Port `LlmClient` Protocol and `LlmRequest` dataclass

**Files:**
- Create: `src/python/flash_agents/llm/__init__.py`
- Create: `src/python/flash_agents/llm/client.py`

- [ ] **Step 1: Read the stub's version**

Run: `cat examples/python-stub/py/rc_agents/llm_clients.py | head -60`

- [ ] **Step 2: Write `src/python/flash_agents/llm/__init__.py`** (client bits only; Task 3.3 adds `OpenAiCompatLlmClient`)

```python
"""LlmClient Protocol + LlmRequest. OpenAiCompatLlmClient is added in Task 3.3."""

from flash_agents.llm.client import LlmClient, LlmRequest

__all__ = ["LlmClient", "LlmRequest"]
```

Reason for the two-step shape: if `__init__.py` referenced `OpenAiCompatLlmClient` before Task 3.3 created the module, the commit at the end of Task 3.1 would import a missing symbol. Task 3.3 appends the additional import.

- [ ] **Step 3: Write `src/python/flash_agents/llm/client.py`**

```python
"""LlmClient Protocol and LlmRequest record."""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator, Protocol


@dataclass(frozen=True)
class LlmRequest:
    """Mirrors the host-llm.llm-request WIT record.

    Field names are snake_case in Python; the WASM host converts between
    these and the camelCase JSON that crosses the WIT boundary.
    """
    model_id: str
    provider: str
    api: str
    system_prompt: str
    messages_json: str
    tools_json: str
    options_json: str


class LlmClient(Protocol):
    """Python-side counterpart to the core's TypeScript LlmClient.

    Contract: MUST NOT raise. Transport failures encode as a final event
    with stopReason="error" (see pi-agent-core's StreamFn contract).
    """
    def stream(self, req: LlmRequest) -> AsyncIterator[str]: ...
```

- [ ] **Step 4: Commit**

```bash
git add src/python/flash_agents/llm/
git commit -m "feat(python): LlmClient Protocol + LlmRequest"
```

---

### Task 3.2: Port message translation

**Files:**
- Create: `src/python/flash_agents/llm/message_translate.py`

- [ ] **Step 1: Copy the stub's logic**

Read `examples/python-stub/py/rc_agents/message_translate.py`. Copy it to `src/python/flash_agents/llm/message_translate.py`, changing only:
- Import of `LlmRequest` from `rc_agents.llm_clients` → `flash_agents.llm.client`.
- Top-level docstring mentions of "M1" → remove.
- `# TODO(post-M1): decoder does not yet process delta.tool_calls.` → replace with a note that tool-call decoding is exercised in Chunk 4.

- [ ] **Step 2: Commit**

```bash
git add src/python/flash_agents/llm/message_translate.py
git commit -m "feat(python): pi-ai <-> openai chat-completions message translation (ported from stub)"
```

---

### Task 3.3: Port `OpenAiCompatLlmClient`

**Files:**
- Create: `src/python/flash_agents/llm/openai_compat.py`

- [ ] **Step 1: Copy the stub's client**

Read `examples/python-stub/py/rc_agents/llm_clients.py:42-126`. Copy `OpenAiCompatLlmClient` into `src/python/flash_agents/llm/openai_compat.py`, updating imports:

```python
from flash_agents.llm.client import LlmRequest
from flash_agents.llm.message_translate import pi_ai_to_openai_request, OpenAiStreamDecoder
```

Replace the stub's "M1 opens a fresh aiohttp.ClientSession per stream() call" docstring block with: `# Opens a fresh aiohttp session per call. Agent lifetimes in flash-agents are long-lived (multi-turn); sharing a session can land once streaming performance matters.`

Preserve the stub's "drain the HTTP response into a buffer inside the `async with` scope" pattern verbatim (stub lines 91-118). It is load-bearing — it avoids `async generator ignored GeneratorExit` warnings when the generator is consumed across the FFI boundary (the wasmtime worker thread pulls items and may abandon iteration before `aiohttp`'s session cleanup runs on the main loop).

- [ ] **Step 2: Amend `flash_agents/llm/__init__.py` to export the client**

```python
"""LlmClient Protocol, LlmRequest, and OpenAiCompatLlmClient."""

from flash_agents.llm.client import LlmClient, LlmRequest
from flash_agents.llm.openai_compat import OpenAiCompatLlmClient

__all__ = ["LlmClient", "LlmRequest", "OpenAiCompatLlmClient"]
```

- [ ] **Step 3: Commit**

```bash
git add src/python/flash_agents/llm/openai_compat.py src/python/flash_agents/llm/__init__.py
git commit -m "feat(python): OpenAiCompatLlmClient (ported from stub)"
```

---

### Task 3.4: Port mock server for tests

**Files:**
- Create: `src/python/tests/e2e/mock_server.py`

- [ ] **Step 1: Copy the stub's mock**

Run: `cp examples/python-stub/py/mock_server.py src/python/tests/e2e/mock_server.py`

The mock has no flash-agents-specific dependencies; no edits needed.

- [ ] **Step 2: Add a helper for tool-call responses (used by Chunk 4)**

Append to `src/python/tests/e2e/mock_server.py`:

```python
def tool_call_chunks(tool_name: str, arguments_json: str, call_id: str = "call_1") -> list[dict]:
    """Canned SSE chunks representing an assistant turn that invokes one tool."""
    base = {
        "id": "chatcmpl-mock-tool",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "mock-gpt",
    }
    return [
        {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [
            {"index": 0, "id": call_id, "type": "function", "function": {"name": tool_name, "arguments": ""}}
        ]}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": arguments_json}}
        ]}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
    ]


def make_recording_app(chunks_per_turn: list[list[dict]]):
    """Each POST pops the next canned chunks and records the incoming JSON body."""
    recorded: list[dict] = []
    queue = list(chunks_per_turn)

    async def handler(request):
        body = await request.json()
        recorded.append(body)
        chunks = queue.pop(0) if queue else default_canned_chunks()
        resp = web.StreamResponse(
            status=200,
            headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"},
        )
        await resp.prepare(request)
        for chunk in chunks:
            await resp.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
        await resp.write(b"data: [DONE]\n\n")
        await resp.write_eof()
        return resp

    app = web.Application()
    app.router.add_post("/v1/chat/completions", handler)
    return app, recorded
```

- [ ] **Step 3: Commit**

```bash
git add src/python/tests/e2e/mock_server.py
git commit -m "test(python): port mock SSE server from stub; add tool_call_chunks and recording helpers"
```

---

### Task 3.5: Unit test for openai_compat translation

**Files:**
- Create: `src/python/tests/unit/test_openai_compat.py`

- [ ] **Step 1: Write the test**

```python
"""Unit: pi-ai Message[] <-> OpenAI chat-completions translation."""
from __future__ import annotations

import json

from flash_agents.llm.client import LlmRequest
from flash_agents.llm.message_translate import (
    pi_ai_to_openai_request,
    OpenAiStreamDecoder,
)


def test_forward_translation_basic() -> None:
    req = LlmRequest(
        model_id="gpt-4o",
        provider="openai",
        api="openai-completions",
        system_prompt="SYS",
        messages_json=json.dumps([{"role": "user", "content": "hi"}]),
        tools_json="[]",
        options_json="{}",
    )
    payload = pi_ai_to_openai_request(req)
    assert payload["model"] == "gpt-4o"
    assert payload["stream"] is True
    assert payload["messages"][0] == {"role": "system", "content": "SYS"}
    assert payload["messages"][1] == {"role": "user", "content": "hi"}


def test_decoder_yields_start_text_done_sequence() -> None:
    dec = OpenAiStreamDecoder(model_id="gpt-4o", provider="openai", api="openai-completions")
    events = []
    events += list(dec.consume_chunk({"choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hi"}, "finish_reason": None}]}))
    events += list(dec.consume_chunk({"choices": [{"index": 0, "delta": {"content": ", world."}, "finish_reason": "stop"}]}))
    types = [e["type"] for e in events]
    assert types == ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]
    assert events[-1]["reason"] == "stop"
    assert events[-1]["message"]["content"][0]["text"] == "Hi, world."
```

- [ ] **Step 2: Run**

Run: `cd src/python && pytest tests/unit/test_openai_compat.py -v`
Expected: both tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/python/tests/unit/test_openai_compat.py
git commit -m "test(python): unit tests for openai-compat translation"
```

---

### Task 3.6: E2E one-turn test

**Files:**
- Create: `src/python/tests/__init__.py` (empty)
- Create: `src/python/tests/e2e/__init__.py` (empty)
- Create: `src/python/tests/e2e/conftest.py`
- Create: `src/python/tests/e2e/test_one_turn.py`

- [ ] **Step 1: Create package markers so `from tests.e2e.mock_server import ...` resolves**

Run:
```bash
touch src/python/tests/__init__.py
touch src/python/tests/e2e/__init__.py
touch src/python/tests/unit/__init__.py
```

Without these, the `conftest.py` and test files that import `from tests.e2e.mock_server import ...` fail with `ModuleNotFoundError` because pytest's rootdir resolution does not add `src/python` as an implicit package root. (`conftest.py` is always collected by pytest, but sibling `.py` files under `tests/e2e/` need the package markers to be importable.)

- [ ] **Step 2: Write shared fixtures**

`src/python/tests/e2e/conftest.py`:

```python
"""E2E fixtures: boot mock server, yield base URL."""
from __future__ import annotations

import socket
from typing import AsyncIterator

import pytest_asyncio
from aiohttp.web_runner import AppRunner, TCPSite

from tests.e2e.mock_server import make_mock_app, default_canned_chunks


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def mock_llm_base_url() -> AsyncIterator[str]:
    port = _find_free_port()
    app = make_mock_app(default_canned_chunks())
    runner = AppRunner(app)
    await runner.setup()
    site = TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        yield f"http://127.0.0.1:{port}/v1"
    finally:
        await runner.cleanup()
```

- [ ] **Step 3: Write the one-turn test**

`src/python/tests/e2e/test_one_turn.py`:

```python
"""E2E: one prompt() turn against the default mock streams 'Hello, world.'"""
from __future__ import annotations

import pytest

from flash_agents import Agent
from flash_agents.llm import OpenAiCompatLlmClient


@pytest.mark.asyncio
async def test_one_turn(mock_llm_base_url: str) -> None:
    llm = OpenAiCompatLlmClient(base_url=mock_llm_base_url)
    async with await Agent.create(
        llm=llm,
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        system_prompt="You are helpful.",
    ) as agent:
        final_text = ""
        types_seen: list[str] = []
        async for event in agent.prompt("Hello"):
            types_seen.append(event["type"])
            if event["type"] == "message_update":
                blocks = event["message"].get("content", []) or []
                for b in blocks:
                    if isinstance(b, dict) and b.get("type") == "text":
                        final_text = b.get("text", "")
    assert "agent_start" in types_seen
    assert "turn_end" in types_seen
    assert "agent_end" in types_seen
    assert final_text == "Hello, world."
```

- [ ] **Step 4: Build core.wasm if not built**

Run: `bun run build:wasm:python` from repo root.

- [ ] **Step 5: Run**

Run: `cd src/python && pytest tests/e2e/test_one_turn.py -v`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/python/tests/__init__.py src/python/tests/unit/__init__.py src/python/tests/e2e/__init__.py src/python/tests/e2e/conftest.py src/python/tests/e2e/test_one_turn.py
git commit -m "test(python): e2e one-turn flow against mock SSE server"
```

---

### Task 3.7: E2E multi-turn test

**Files:**
- Create: `src/python/tests/e2e/test_multi_turn.py`

- [ ] **Step 1: Write the test**

```python
"""E2E: two sequential prompts preserve message history in the core."""
from __future__ import annotations

import socket
from typing import AsyncIterator

import pytest
import pytest_asyncio
from aiohttp.web_runner import AppRunner, TCPSite

from flash_agents import Agent
from flash_agents.llm import OpenAiCompatLlmClient
from tests.e2e.mock_server import make_recording_app, default_canned_chunks


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def recording_mock() -> AsyncIterator[tuple[str, list[dict]]]:
    port = _find_free_port()
    app, recorded = make_recording_app([default_canned_chunks(), default_canned_chunks()])
    runner = AppRunner(app)
    await runner.setup()
    site = TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        yield (f"http://127.0.0.1:{port}/v1", recorded)
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_multi_turn_preserves_history(
    recording_mock: tuple[str, list[dict]],
) -> None:
    base_url, recorded = recording_mock
    llm = OpenAiCompatLlmClient(base_url=base_url)
    async with await Agent.create(
        llm=llm,
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        system_prompt="SYS",
    ) as agent:
        async for _ in agent.prompt("first"):
            pass
        async for _ in agent.prompt("second"):
            pass
    assert len(recorded) == 2
    msgs_turn2 = recorded[1]["messages"]
    roles_turn2 = [m["role"] for m in msgs_turn2]
    assert "assistant" in roles_turn2, f"turn 2 missing prior assistant reply; got {roles_turn2}"
    assert roles_turn2.count("user") >= 2, f"turn 2 missing prior user msg; got {roles_turn2}"
```

- [ ] **Step 2: Run**

Run: `cd src/python && pytest tests/e2e/test_multi_turn.py -v`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/python/tests/e2e/test_multi_turn.py
git commit -m "test(python): e2e multi-turn history preservation"
```

---

### Task 3.8: Chunk 3 integration verification

- [ ] **Step 1: Run all unit + e2e**

Run: `cd src/python && pytest -v`
Expected: everything passes.

---

## Chunk 4: Tools — API surface, schema inference, and host-tools wiring

This chunk adds `@tool`, `Tool`, `ToolContext`, schema inference, the registry, and end-to-end tool invocation across the WIT `host-tools` boundary with the worker-thread / main-loop bridge.

### Task 4.1: ToolContext and canonical tool record

**Files:**
- Create: `src/python/flash_agents/tools/__init__.py`
- Create: `src/python/flash_agents/tools/context.py`
- Create: `src/python/flash_agents/tools/registry.py`

- [ ] **Step 1: Write `context.py`**

```python
"""ToolContext — what a tool's execute() receives as its second arg."""

from __future__ import annotations

import logging
from dataclasses import dataclass


@dataclass(frozen=True)
class ToolContext:
    """Handed to a tool at call time.

    Fields:
        cwd: the agent's configured working directory.
        call_id: unique id for this invocation (matches tool_execution_start event).
        logger: namespaced logger under 'flash_agents.tools'.
    """
    cwd: str
    call_id: str
    logger: logging.Logger
```

- [ ] **Step 2: Write `registry.py`**

```python
"""Canonical tool record + Registry.

Every Python tool (decorator or class form) normalizes to the same internal
shape before being handed to the wasm guest via host-tools.list-tools.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from flash_agents.errors import ConfigError
from flash_agents.tools.context import ToolContext


@dataclass(frozen=True)
class CanonicalTool:
    name: str
    description: str
    input_schema: dict
    execute: Callable[[dict, ToolContext], Awaitable[Any]]


class ToolRegistry:
    def __init__(self) -> None:
        self._by_name: dict[str, CanonicalTool] = {}

    def register(self, tool: CanonicalTool) -> None:
        if tool.name in self._by_name:
            raise ConfigError(f"duplicate tool name: {tool.name!r}")
        self._by_name[tool.name] = tool

    def get(self, name: str) -> CanonicalTool | None:
        return self._by_name.get(name)

    def list_json(self) -> list[dict]:
        return [
            {"name": t.name, "description": t.description, "inputSchema": t.input_schema}
            for t in self._by_name.values()
        ]

    def __len__(self) -> int:
        return len(self._by_name)
```

- [ ] **Step 3: Write the package `__init__.py`**

```python
"""Tools: @tool decorator, Tool class, ToolContext, schema inference."""

from flash_agents.tools.context import ToolContext
from flash_agents.tools.base import Tool, tool

__all__ = ["Tool", "ToolContext", "tool"]
```

- [ ] **Step 4: Commit**

```bash
git add src/python/flash_agents/tools/context.py src/python/flash_agents/tools/registry.py src/python/flash_agents/tools/__init__.py
git commit -m "feat(python): ToolContext + CanonicalTool + ToolRegistry"
```

---

### Task 4.2: `@tool` decorator + `Tool` base class + schema inference

**Files:**
- Create: `src/python/flash_agents/tools/base.py`
- Create: `src/python/flash_agents/tools/schema.py`
- Create: `src/python/tests/unit/test_tool_decorator.py`

- [ ] **Step 1: Write failing unit tests**

`src/python/tests/unit/test_tool_decorator.py`:

```python
"""Unit tests for @tool schema inference and Tool class."""
from __future__ import annotations

from typing import Literal, Optional, TypedDict
from dataclasses import dataclass

import pytest

from flash_agents import ConfigError
from flash_agents.tools import tool, Tool


class _Point(TypedDict):
    x: int
    y: int


@dataclass
class _Box:
    w: int
    h: int


def test_decorator_infers_primitive_args() -> None:
    @tool
    async def read_file(path: str, *, max_bytes: int = 65536) -> str:
        """Read a file.

        Args:
            path: Absolute path to the file.
            max_bytes: Truncate after this many bytes.
        """
        return ""

    schema = read_file.canonical.input_schema
    assert schema["type"] == "object"
    assert schema["properties"]["path"]["type"] == "string"
    assert schema["properties"]["max_bytes"]["type"] == "integer"
    assert schema["properties"]["max_bytes"]["default"] == 65536
    assert "path" in schema["required"]
    assert "max_bytes" not in schema["required"]
    assert read_file.canonical.description.startswith("Read a file")


def test_decorator_handles_optional_and_literal_and_list() -> None:
    @tool
    async def fn(
        tags: list[str],
        mode: Literal["r", "w"] = "r",
        note: Optional[str] = None,
    ) -> None:
        """Do stuff."""

    s = fn.canonical.input_schema
    assert s["properties"]["tags"]["type"] == "array"
    assert s["properties"]["tags"]["items"]["type"] == "string"
    assert s["properties"]["mode"]["enum"] == ["r", "w"]
    note_type = s["properties"]["note"]["type"]
    assert "string" in note_type if isinstance(note_type, list) else note_type == "string"


def test_decorator_typeddict_and_dataclass() -> None:
    @tool
    async def plot(point: _Point, box: _Box) -> None:
        """Plot point in box."""

    s = plot.canonical.input_schema
    assert s["properties"]["point"]["type"] == "object"
    assert s["properties"]["point"]["properties"]["x"]["type"] == "integer"
    assert s["properties"]["box"]["type"] == "object"


def test_unsupported_type_raises_configerror() -> None:
    class _Opaque: ...

    with pytest.raises(ConfigError, match="unsupported"):
        @tool
        async def bad(x: _Opaque) -> None:
            """no schema possible."""


def test_tool_class_form() -> None:
    class WebFetch(Tool):
        name = "web_fetch"
        description = "fetch url"
        input_schema = {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}

        async def execute(self, args, ctx):
            return {"fetched": args["url"]}

    t = WebFetch()
    assert t.canonical.name == "web_fetch"
    assert t.canonical.input_schema["required"] == ["url"]


def test_tool_class_missing_fields_raises() -> None:
    with pytest.raises(ConfigError):
        class Bad(Tool):
            description = "x"
            input_schema = {"type": "object"}
            async def execute(self, args, ctx): return None
        Bad()
```

- [ ] **Step 2: Run — expect failures / ImportError**

Run: `cd src/python && pytest tests/unit/test_tool_decorator.py -v`

- [ ] **Step 3: Write `src/python/flash_agents/tools/schema.py`**

```python
"""JSON Schema inference from Python type hints.

Supported: str, int, float, bool, list[T], dict[str, V], Optional[T],
Literal[...], TypedDict, dataclass. Anything else -> ConfigError pointing
the user at the explicit Tool class form.
"""

from __future__ import annotations

import dataclasses
import inspect
import re
import types as _types
import typing
from typing import Any, get_args, get_origin, get_type_hints

from flash_agents.errors import ConfigError


_PRIMITIVES = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
}


def _is_typeddict(tp: Any) -> bool:
    return isinstance(tp, type) and typing.is_typeddict(tp)


def type_to_schema(tp: Any, path: str) -> dict:
    if tp in _PRIMITIVES:
        return {"type": _PRIMITIVES[tp]}
    origin = get_origin(tp)
    args = get_args(tp)
    if origin is list:
        if not args:
            return {"type": "array"}
        return {"type": "array", "items": type_to_schema(args[0], f"{path}[]")}
    if origin is dict:
        if len(args) == 2 and args[0] is str:
            return {"type": "object", "additionalProperties": type_to_schema(args[1], f"{path}{{}}")}
        return {"type": "object"}
    if origin is typing.Union or origin is getattr(typing, "UnionType", type(None)):
        non_none = [a for a in args if a is not type(None)]
        nullable = any(a is type(None) for a in args)
        if len(non_none) == 1:
            inner = type_to_schema(non_none[0], path)
            if nullable:
                t = inner.get("type")
                if isinstance(t, str):
                    inner["type"] = [t, "null"]
                elif t is None:
                    inner["type"] = ["null"]
                else:
                    if "null" not in t:
                        inner["type"] = list(t) + ["null"]
            return inner
        raise ConfigError(
            f"unsupported type at {path}: Union with multiple non-None arms. "
            f"Use a Tool subclass with an explicit input_schema."
        )
    if origin is typing.Literal:
        return {"enum": list(args)}
    if _is_typeddict(tp):
        hints = get_type_hints(tp)
        required = list(getattr(tp, "__required_keys__", hints.keys()))
        return {
            "type": "object",
            "properties": {k: type_to_schema(v, f"{path}.{k}") for k, v in hints.items()},
            "required": required,
        }
    if dataclasses.is_dataclass(tp):
        fields = {f.name: f for f in dataclasses.fields(tp)}
        required = [n for n, f in fields.items() if f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING]
        hints = get_type_hints(tp)
        return {
            "type": "object",
            "properties": {k: type_to_schema(hints[k], f"{path}.{k}") for k in fields},
            "required": required,
        }
    raise ConfigError(
        f"unsupported type at {path}: {tp!r}. "
        f"Use a Tool subclass with an explicit input_schema."
    )


def signature_to_schema(fn: Any, ignore: set[str]) -> tuple[dict, str]:
    sig = inspect.signature(fn)
    hints = get_type_hints(fn)
    properties: dict[str, dict] = {}
    required: list[str] = []
    for name, param in sig.parameters.items():
        if name in ignore:
            continue
        if name not in hints:
            raise ConfigError(
                f"parameter {name!r} in {fn.__name__} has no type hint. "
                f"All tool arguments must be annotated."
            )
        schema = type_to_schema(hints[name], name)
        if param.default is inspect.Parameter.empty:
            required.append(name)
        else:
            schema["default"] = param.default
        properties[name] = schema
    description = _parse_docstring(fn.__doc__ or fn.__name__)
    obj_schema: dict = {"type": "object", "properties": properties}
    if required:
        obj_schema["required"] = required
    return obj_schema, description


_ARGS_RE = re.compile(r"^\s*Args:\s*$", re.MULTILINE)


def _parse_docstring(doc: str) -> str:
    doc = inspect.cleandoc(doc or "")
    if not doc:
        return ""
    m = _ARGS_RE.search(doc)
    if m:
        return doc[: m.start()].strip()
    return doc.strip()
```

- [ ] **Step 4: Write `src/python/flash_agents/tools/base.py`**

```python
"""@tool decorator and Tool base class."""

from __future__ import annotations

import inspect
from typing import Any, Awaitable, Callable, get_type_hints

from flash_agents.errors import ConfigError
from flash_agents.tools.context import ToolContext
from flash_agents.tools.registry import CanonicalTool
from flash_agents.tools.schema import signature_to_schema


class _Decorated:
    """Object returned by @tool. Callable like the original function; also
    carries a `.canonical` attribute holding the CanonicalTool."""

    def __init__(self, fn: Callable[..., Awaitable[Any]], canonical: CanonicalTool) -> None:
        self._fn = fn
        self.canonical = canonical
        self.__name__ = getattr(fn, "__name__", canonical.name)
        self.__doc__ = fn.__doc__

    async def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return await self._fn(*args, **kwargs)


def tool(fn: Callable[..., Awaitable[Any]]) -> _Decorated:
    if not inspect.iscoroutinefunction(fn):
        raise ConfigError(
            f"@tool function {fn.__name__} must be declared `async def`."
        )
    hints = get_type_hints(fn)
    ctx_param_name: str | None = None
    for name, hint in hints.items():
        if hint is ToolContext:
            ctx_param_name = name
            break
    ignore = {ctx_param_name} if ctx_param_name else set()
    schema, description = signature_to_schema(fn, ignore=ignore)

    async def do_call(args: dict, ctx: ToolContext) -> Any:
        call_kwargs = dict(args)
        if ctx_param_name is not None:
            call_kwargs[ctx_param_name] = ctx
        return await fn(**call_kwargs)

    canonical = CanonicalTool(
        name=fn.__name__,
        description=description,
        input_schema=schema,
        execute=do_call,
    )
    return _Decorated(fn, canonical)


class Tool:
    """Base class for explicit tools with hand-written input_schema.

    Subclasses must set `name`, `description`, `input_schema`, and implement
    `async def execute(self, args, ctx) -> Any`.
    """

    name: str
    description: str
    input_schema: dict

    def __init__(self) -> None:
        for attr in ("name", "description", "input_schema"):
            if not getattr(self, attr, None):
                raise ConfigError(
                    f"Tool subclass {type(self).__name__} must define class attribute {attr!r}"
                )
        if not inspect.iscoroutinefunction(type(self).execute):
            raise ConfigError(
                f"Tool subclass {type(self).__name__}.execute must be `async def`"
            )

    async def execute(self, args: dict, ctx: ToolContext) -> Any:
        raise NotImplementedError

    @property
    def canonical(self) -> CanonicalTool:
        instance = self

        async def do_call(args: dict, ctx: ToolContext) -> Any:
            return await instance.execute(args, ctx)

        return CanonicalTool(
            name=self.name,
            description=self.description,
            input_schema=self.input_schema,
            execute=do_call,
        )
```

- [ ] **Step 5: Run unit tests — expect pass**

Run: `cd src/python && pytest tests/unit/test_tool_decorator.py -v`
Expected: all six tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/python/flash_agents/tools/base.py src/python/flash_agents/tools/schema.py src/python/tests/unit/test_tool_decorator.py
git commit -m "feat(python): @tool decorator, Tool class, JSON Schema inference"
```

---

### Task 4.3: Wire tools into `Agent.create()`

**Files:**
- Modify: `src/python/flash_agents/agent.py`
- Modify: `src/python/flash_agents/__init__.py`

- [ ] **Step 1: Extend Agent.create()**

Add `tools: list | None = None` to `Agent.create`'s signature. Before `host.instantiate`, build a registry and replace the stub host-tools callbacks:

```python
from flash_agents.tools.base import _Decorated, Tool
from flash_agents.tools.registry import CanonicalTool, ToolRegistry
from flash_agents.tools.context import ToolContext
import logging, traceback

_TOOL_LOGGER = logging.getLogger("flash_agents.tools")

# Inside Agent.create, after capturing loop:
registry = ToolRegistry()
for t in (tools or []):
    if isinstance(t, _Decorated):
        registry.register(t.canonical)
    elif isinstance(t, Tool):
        registry.register(t.canonical)
    elif isinstance(t, CanonicalTool):
        registry.register(t)
    else:
        raise ConfigError(
            f"tools[{len(registry)}] is not a recognized tool: got {type(t).__name__}. "
            f"Use @tool, subclass Tool, or pass a CanonicalTool."
        )

tools_list_json = json.dumps(registry.list_json())

def _host_tools_list() -> str:
    return tools_list_json

def _host_tools_execute(call: dict) -> dict:
    return _dispatch_tool(call, registry, loop, cwd or "/flash-agents")
```

Add `_dispatch_tool` as a module-level function in `agent.py`:

```python
def _dispatch_tool(
    call: dict, registry: ToolRegistry, loop: asyncio.AbstractEventLoop, cwd: str,
) -> dict:
    name = call.get("toolName") or call.get("tool_name") or ""
    call_id = call.get("callId") or call.get("call_id") or ""
    input_json = call.get("inputJson") or call.get("input_json") or "{}"
    tool_rec = registry.get(name)
    if tool_rec is None:
        return {
            "callId": call_id,
            "isError": True,
            "outputJson": json.dumps({
                "error": f"unknown tool: {name}",
                "type": "ToolError",
            }),
        }
    try:
        args = json.loads(input_json)
    except json.JSONDecodeError as e:
        return {
            "callId": call_id,
            "isError": True,
            "outputJson": json.dumps({
                "error": f"invalid JSON args: {e}",
                "type": "ToolError",
            }),
        }
    ctx = ToolContext(cwd=cwd, call_id=call_id, logger=_TOOL_LOGGER)
    try:
        fut = asyncio.run_coroutine_threadsafe(tool_rec.execute(args, ctx), loop)
        result = fut.result()
    except Exception as exc:  # noqa: BLE001 — tool boundary swallows all
        return {
            "callId": call_id,
            "isError": True,
            "outputJson": json.dumps({
                "error": str(exc),
                "type": type(exc).__name__,
                "traceback": traceback.format_exc(),
            }),
        }
    return {
        "callId": call_id,
        "isError": False,
        "outputJson": json.dumps(result),
    }
```

- [ ] **Step 2: Update `flash_agents/__init__.py`**

```python
from flash_agents.agent import Agent
from flash_agents.errors import (
    ConfigError, FlashAgentError, LlmError, ToolError, WasmHostError,
)
from flash_agents.tools import Tool, ToolContext, tool

__all__ = [
    "Agent", "Tool", "ToolContext", "tool",
    "ConfigError", "FlashAgentError", "LlmError", "ToolError", "WasmHostError",
]
__version__ = "0.1.0"
```

- [ ] **Step 3: Commit**

```bash
git add src/python/flash_agents/agent.py src/python/flash_agents/__init__.py
git commit -m "feat(python): Agent.create accepts tools; wires host-tools bridge"
```

---

### Task 4.4: E2E — successful tool call

**Files:**
- Create: `src/python/tests/e2e/test_tool_call.py`

- [ ] **Step 1: Write the test**

```python
"""E2E: LLM invokes a @tool, host runs it, turn continues with result."""
from __future__ import annotations

import socket
from typing import AsyncIterator

import pytest
import pytest_asyncio
from aiohttp.web_runner import AppRunner, TCPSite

from flash_agents import Agent, tool
from flash_agents.llm import OpenAiCompatLlmClient
from tests.e2e.mock_server import (
    make_recording_app,
    default_canned_chunks,
    tool_call_chunks,
)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def two_turn_mock() -> AsyncIterator[tuple[str, list[dict]]]:
    chunks1 = tool_call_chunks("add", '{"a": 2, "b": 3}')
    chunks2 = [
        {
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "the result is 5"}, "finish_reason": "stop"}],
            "id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": 0, "model": "mock-gpt",
        }
    ]
    port = _find_free_port()
    app, recorded = make_recording_app([chunks1, chunks2])
    runner = AppRunner(app)
    await runner.setup()
    site = TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        yield (f"http://127.0.0.1:{port}/v1", recorded)
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_tool_call_success(two_turn_mock: tuple[str, list[dict]]) -> None:
    base_url, recorded = two_turn_mock

    @tool
    async def add(a: int, b: int) -> int:
        """Add two integers."""
        return a + b

    llm = OpenAiCompatLlmClient(base_url=base_url)
    tool_events = []
    async with await Agent.create(
        llm=llm,
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        system_prompt="",
        tools=[add],
    ) as agent:
        async for event in agent.prompt("what is 2+3?"):
            if event["type"] in {"tool_execution_start", "tool_execution_end"}:
                tool_events.append(event)
    starts = [e for e in tool_events if e["type"] == "tool_execution_start"]
    ends = [e for e in tool_events if e["type"] == "tool_execution_end"]
    assert len(starts) == 1
    assert len(ends) == 1
    assert ends[0]["isError"] is False
    assert ends[0]["toolName"] == "add"
    turn2_roles = [m["role"] for m in recorded[1]["messages"]]
    assert "tool" in turn2_roles
```

- [ ] **Step 2: Run**

Run: `cd src/python && pytest tests/e2e/test_tool_call.py -v`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/python/tests/e2e/test_tool_call.py
git commit -m "test(python): e2e successful @tool invocation end-to-end"
```

---

### Task 4.5: E2E — tool raises, traceback feeds back to LLM

**Files:**
- Modify: `src/python/tests/e2e/test_tool_call.py`

- [ ] **Step 1: Add a test function**

```python
@pytest.mark.asyncio
async def test_tool_call_raises_and_reports_traceback(
    two_turn_mock: tuple[str, list[dict]],
) -> None:
    base_url, recorded = two_turn_mock

    @tool
    async def add(a: int, b: int) -> int:
        """Intentionally fails."""
        raise ValueError("boom")

    llm = OpenAiCompatLlmClient(base_url=base_url)
    end_events = []
    async with await Agent.create(
        llm=llm,
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        system_prompt="",
        tools=[add],
    ) as agent:
        async for event in agent.prompt("what is 2+3?"):
            if event["type"] == "tool_execution_end":
                end_events.append(event)
    assert len(end_events) == 1
    assert end_events[0]["isError"] is True
    turn2_tool_msgs = [m for m in recorded[1]["messages"] if m["role"] == "tool"]
    assert len(turn2_tool_msgs) == 1
    content = turn2_tool_msgs[0]["content"]
    assert "ValueError" in content
    assert "boom" in content
    assert "Traceback" in content
```

- [ ] **Step 2: Run**

Run: `cd src/python && pytest tests/e2e/test_tool_call.py::test_tool_call_raises_and_reports_traceback -v`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/python/tests/e2e/test_tool_call.py
git commit -m "test(python): raising tool surfaces traceback to LLM via tool-result"
```

---

### Task 4.6: E2E — tool awaits async I/O (deadlock regression)

**Files:**
- Create: `src/python/tests/e2e/test_tool_async_io.py`

**Why:** The spec reviewer flagged this explicitly: if the worker-thread bridge is broken, a tool that `await`s a network call hangs forever.

- [ ] **Step 1: Write the test**

```python
"""E2E: a tool that awaits aiohttp completes; verifies worker-thread /
main-loop bridging does not deadlock."""
from __future__ import annotations

import asyncio
import socket
from typing import AsyncIterator

import aiohttp
import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.web_runner import AppRunner, TCPSite

from flash_agents import Agent, tool
from flash_agents.llm import OpenAiCompatLlmClient
from tests.e2e.mock_server import make_recording_app, tool_call_chunks


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def echo_server() -> AsyncIterator[str]:
    async def handler(request: web.Request) -> web.Response:
        return web.Response(text="pong")
    app = web.Application()
    app.router.add_get("/ping", handler)
    port = _find_free_port()
    runner = AppRunner(app)
    await runner.setup()
    site = TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        yield f"http://127.0.0.1:{port}/ping"
    finally:
        await runner.cleanup()


@pytest_asyncio.fixture
async def mock_llm_two_turns() -> AsyncIterator[str]:
    chunks1 = tool_call_chunks("fetch_ping", "{}")
    chunks2 = [
        {
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}],
            "id": "m", "object": "chat.completion.chunk", "created": 0, "model": "mock",
        }
    ]
    app, _ = make_recording_app([chunks1, chunks2])
    port = _find_free_port()
    runner = AppRunner(app)
    await runner.setup()
    site = TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        yield f"http://127.0.0.1:{port}/v1"
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_tool_awaits_aiohttp_without_deadlock(
    echo_server: str, mock_llm_two_turns: str,
) -> None:
    @tool
    async def fetch_ping() -> str:
        """GET the echo server and return its body."""
        async with aiohttp.ClientSession() as sess:
            async with sess.get(echo_server) as r:
                return await r.text()

    llm = OpenAiCompatLlmClient(base_url=mock_llm_two_turns)
    async def _run() -> None:
        async with await Agent.create(
            llm=llm,
            model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
            system_prompt="",
            tools=[fetch_ping],
        ) as agent:
            async for _ in agent.prompt("please ping"):
                pass

    await asyncio.wait_for(_run(), timeout=10.0)
```

- [ ] **Step 2: Run — expect pass (or TimeoutError if bridging is broken)**

Run: `cd src/python && pytest tests/e2e/test_tool_async_io.py -v`
Expected: pass within a few seconds.

- [ ] **Step 3: Commit**

```bash
git add src/python/tests/e2e/test_tool_async_io.py
git commit -m "test(python): e2e tool awaits async HTTP without deadlock"
```

---

### Task 4.7: Unit — Tool class validation

**Files:**
- Create: `src/python/tests/unit/test_tool_class.py`

- [ ] **Step 1: Write the tests**

```python
"""Unit: Tool class subclass validation, duplicate-name detection."""
from __future__ import annotations

import pytest

from flash_agents import ConfigError, Tool
from flash_agents.tools.registry import ToolRegistry


class _Ok(Tool):
    name = "ok"
    description = "ok tool"
    input_schema = {"type": "object"}
    async def execute(self, args, ctx):
        return None


def test_valid_subclass_has_canonical() -> None:
    t = _Ok()
    assert t.canonical.name == "ok"


def test_missing_class_attrs_raise() -> None:
    class _NoName(Tool):
        description = "x"
        input_schema = {"type": "object"}
        async def execute(self, args, ctx): return None
    with pytest.raises(ConfigError):
        _NoName()


def test_sync_execute_raises() -> None:
    class _Sync(Tool):
        name = "s"
        description = "sync"
        input_schema = {"type": "object"}
        def execute(self, args, ctx):
            return None
    with pytest.raises(ConfigError, match="async def"):
        _Sync()


def test_registry_duplicate_rejected() -> None:
    reg = ToolRegistry()
    reg.register(_Ok().canonical)
    with pytest.raises(ConfigError, match="duplicate"):
        reg.register(_Ok().canonical)
```

- [ ] **Step 2: Run**

Run: `cd src/python && pytest tests/unit/test_tool_class.py -v`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/python/tests/unit/test_tool_class.py
git commit -m "test(python): Tool class validation + registry duplicate detection"
```

---

### Task 4.8: Chunk 4 integration verification

- [ ] **Step 1: Run all**

Run: `cd src/python && pytest -v`
Expected: all unit + e2e pass.

---

## Chunk 5: Memory + MCP registration

This chunk adds filesystem memory with Node-compatible format, per-turn memory retrieval injection, and the MCP registration surface with its staged-wiring warning.

### Task 5.1: `Memory` dataclass and `MemoryStore` Protocol

**Files:**
- Create: `src/python/flash_agents/memory/__init__.py`
- Create: `src/python/flash_agents/memory/types.py`

- [ ] **Step 1: Write `types.py`**

```python
"""Memory dataclass + MemoryStore Protocol. Matches core's Memory shape."""

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
```

- [ ] **Step 2: Write `__init__.py`**

```python
"""Memory: Memory dataclass, MemoryStore Protocol, FilesystemMemoryStore."""

from flash_agents.memory.types import Memory, MemoryStore, MemoryType
from flash_agents.memory.filesystem import FilesystemMemoryStore

__all__ = ["Memory", "MemoryStore", "MemoryType", "FilesystemMemoryStore"]
```

- [ ] **Step 3: Commit**

```bash
git add src/python/flash_agents/memory/types.py src/python/flash_agents/memory/__init__.py
git commit -m "feat(python): Memory dataclass + MemoryStore Protocol"
```

---

### Task 5.2: `FilesystemMemoryStore` with Node-compatible format

**Files:**
- Create: `src/python/flash_agents/memory/filesystem.py`
- Create: `src/python/tests/unit/test_filesystem_memory.py`

**Why:** On-disk format must exactly match `src/node/memory/node-memory-store.ts` so a directory can be read/written from either host.

- [ ] **Step 1: Write failing tests**

```python
"""FilesystemMemoryStore round-trip + Node-format parity."""
from __future__ import annotations

import pathlib

import pytest

from flash_agents.memory import FilesystemMemoryStore, Memory


@pytest.mark.asyncio
async def test_round_trip(tmp_path: pathlib.Path) -> None:
    store = FilesystemMemoryStore(root=tmp_path)
    m = Memory(name="Prefers Terse Responses", description="user likes short answers", type="user", content="body\nline2")
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
```

- [ ] **Step 2: Run — expect failure**

Run: `cd src/python && pytest tests/unit/test_filesystem_memory.py -v`
Expected: ImportError.

- [ ] **Step 3: Write `src/python/flash_agents/memory/filesystem.py`**

```python
"""Filesystem-backed MemoryStore; on-disk format matches Node's createNodeMemoryStore."""

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
    """Mirror of Node's sanitizeFilename in src/node/memory/node-memory-store.ts."""
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
    """One .md file per entry, with three-line frontmatter compatible with Node.

    Root defaults to ~/.flash-agents/memory; overridable via constructor arg
    or FLASH_AGENTS_MEMORY_DIR env var.
    """

    def __init__(self, root: str | pathlib.Path | None = None) -> None:
        if root is None:
            env = os.environ.get("FLASH_AGENTS_MEMORY_DIR")
            if env:
                root = pathlib.Path(env).expanduser()
            else:
                root = pathlib.Path("~/.flash-agents/memory").expanduser()
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
```

- [ ] **Step 4: Run — expect pass**

Run: `cd src/python && pytest tests/unit/test_filesystem_memory.py -v`
Expected: four tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/python/flash_agents/memory/filesystem.py src/python/tests/unit/test_filesystem_memory.py
git commit -m "feat(python): FilesystemMemoryStore with Node-compatible frontmatter"
```

---

### Task 5.3: `retrieve()` keyword scoring

**Files:**
- Create: `src/python/flash_agents/memory/retrieve.py`
- Create: `src/python/tests/unit/test_retrieve.py`

- [ ] **Step 1: Read the Node implementation**

Run: `cat src/core/memory/retrieve.ts`. Note the algorithm precisely — this is a literal port, not a re-implementation:
- `tokenize`: `text.toLowerCase().split(/\W+/).filter(t => t.length > 0)`
- Per-memory index: tokenize **`description + " " + content`** only (NOT the name); build a term-frequency `Map<string, number>` and `wordCount = tokens.length || 1`.
- Default `maxItems = 10`; default `maxTokens = Infinity`.
- Empty query: return all memories up to `maxItems`, each with `relevanceScore = 1` and recency-order `updatedAt = Date.now() - index`; still enforces the `maxTokens` budget.
- Non-empty query: dedup query terms (a repeated term does not multiply weight); score per memory as `Σ_over_unique_terms count / wordCount`.
- Sort by score desc, break ties by `updatedAt` desc.
- Truncate by `maxItems` AND by a `maxTokens` budget where each memory costs `ceil(content.length / 4)` tokens; stop early when an item's `relevanceScore === 0`.

- [ ] **Step 2: Failing test (uses the core's algorithm behavior)**

```python
"""Unit: retrieve() is a literal port of src/core/memory/retrieve.ts."""
from __future__ import annotations

from flash_agents.memory import Memory
from flash_agents.memory.retrieve import retrieve


def test_tokenizer_matches_word_non_word_split() -> None:
    # Node: text.toLowerCase().split(/\W+/).filter(t => t.length > 0)
    from flash_agents.memory.retrieve import _tokenize
    assert _tokenize("Hello, World! foo_bar") == ["hello", "world", "foo_bar"]


def test_scoring_tokenizes_description_and_content_only() -> None:
    # Token 'python' only in the name must NOT score — core ignores name.
    mems = [
        Memory(name="python", description="about web frameworks", type="reference", content="flask and django"),
        Memory(name="x",      description="python testing",       type="reference", content="pytest fixtures"),
    ]
    out = retrieve(mems, query="python")
    # Only the second memory contains 'python' in description; the first should score 0.
    assert len(out) == 1
    assert out[0].memory.name == "x"


def test_empty_query_returns_all_up_to_max_items() -> None:
    mems = [
        Memory(name=f"m{i}", description="d", type="user", content="c") for i in range(15)
    ]
    out = retrieve(mems, query="", max_items=10)
    assert len(out) == 10
    assert all(s.relevance_score == 1.0 for s in out)


def test_max_items_caps_result_count() -> None:
    mems = [
        Memory(name=f"m{i}", description="python", type="user", content="pytest") for i in range(5)
    ]
    out = retrieve(mems, query="python pytest", max_items=2)
    assert len(out) == 2


def test_stops_at_zero_score() -> None:
    mems = [
        Memory(name="a", description="python", type="user", content="py"),
        Memory(name="b", description="unrelated", type="user", content="nope"),
    ]
    out = retrieve(mems, query="python", max_items=10)
    assert len(out) == 1  # 'b' has score 0 and is dropped
    assert out[0].memory.name == "a"


def test_dedup_query_terms() -> None:
    mems = [Memory(name="m", description="python python python", type="user", content="")]
    score_once = retrieve(mems, query="python")[0].relevance_score
    score_repeated = retrieve(mems, query="python python python")[0].relevance_score
    assert score_once == score_repeated
```

- [ ] **Step 3: Implement `retrieve()` as a literal port**

```python
"""Keyword-scoring retrieval — literal port of src/core/memory/retrieve.ts.

Semantic parity (not convenience Pythonism): outputs for a given
(memories, query, max_items, max_tokens) input should match the Node
implementation for any shared fixture.
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
    # Mirror: text.toLowerCase().split(/\W+/).filter(t => t.length > 0)
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

    # Empty-query branch: return memories up to maxItems, most-recent first.
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

    unique_terms = list(dict.fromkeys(query_terms))  # dedup preserving order

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
```

Note: default `max_items=10` matches the core default, not the `memory_top_k=5` the Agent passes. The Agent's `memory_top_k` is a user-facing default that overrides this internal default via the explicit `max_items` kwarg.

- [ ] **Step 4: Run**

Run: `cd src/python && pytest tests/unit/test_retrieve.py -v`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/python/flash_agents/memory/retrieve.py src/python/tests/unit/test_retrieve.py
git commit -m "feat(python): retrieve() keyword scoring (parity with core)"
```

---

### Task 5.4: Wire memory injection into `Agent`

**Files:**
- Modify: `src/python/flash_agents/agent.py`

- [ ] **Step 1: Extend Agent.create() signature**

Add `memory`, `memory_top_k` parameters. Sentinel for "not supplied" so that `memory=None` is distinguishable from default:

```python
_UNSET = object()

@classmethod
async def create(
    cls, *, llm, model, system_prompt="", tools=None,
    memory=_UNSET, memory_top_k=5, mcp_servers=None, cwd=None,
):
    ...
    if memory is _UNSET:
        from flash_agents.memory import FilesystemMemoryStore
        memory = FilesystemMemoryStore()
    elif memory is None:
        pass  # disabled
    else:
        if not all(hasattr(memory, a) for a in ("load", "save", "remove")):
            raise ConfigError("memory must implement MemoryStore Protocol (load/save/remove) or be None")
```

Store `self._memory = memory` and `self._memory_top_k = memory_top_k` on the instance.

- [ ] **Step 2: Compute `extra_system` in `Agent.prompt()`**

```python
async def prompt(self, message: str) -> AsyncIterator[dict]:
    self._check_loop()
    if self._disposed:
        raise WasmHostError("agent has been disposed")

    extra_system: str | None = None
    if self._memory is not None:
        from flash_agents.memory.retrieve import retrieve as _retrieve
        memories = await self._memory.load()
        selections = _retrieve(memories, query=message, max_items=self._memory_top_k)
        if selections:
            rendered = "\n\n".join(
                f"<memory name=\"{s.memory.name}\">\n{s.memory.content}\n</memory>"
                for s in selections
            )
            extra_system = f"<memories>\n{rendered}\n</memories>"

    async def iterator() -> AsyncIterator[dict]:
        async with self._call_lock:
            stream_handle = await asyncio.to_thread(self._inst.prompt_sync, message, extra_system)
            while True:
                raw = await asyncio.to_thread(self._inst.event_stream_next_sync, stream_handle)
                if raw is None:
                    return
                yield json.loads(raw)
    return iterator()
```

- [ ] **Step 3: Commit**

```bash
git add src/python/flash_agents/agent.py
git commit -m "feat(python): per-turn memory retrieval -> extra_system injection"
```

---

### Task 5.5: E2E memory injection test

**Files:**
- Create: `src/python/tests/e2e/test_memory_injection.py`

- [ ] **Step 1: Write the test**

```python
"""E2E: FilesystemMemoryStore entries appear in the system prompt for each turn."""
from __future__ import annotations

import pathlib
import socket
from typing import AsyncIterator

import pytest
import pytest_asyncio
from aiohttp.web_runner import AppRunner, TCPSite

from flash_agents import Agent
from flash_agents.llm import OpenAiCompatLlmClient
from flash_agents.memory import FilesystemMemoryStore, Memory
from tests.e2e.mock_server import make_recording_app, default_canned_chunks


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def recording() -> AsyncIterator[tuple[str, list[dict]]]:
    app, recorded = make_recording_app([default_canned_chunks()])
    port = _find_free_port()
    runner = AppRunner(app)
    await runner.setup()
    await TCPSite(runner, "127.0.0.1", port).start()
    try:
        yield (f"http://127.0.0.1:{port}/v1", recorded)
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_memory_appears_in_system_prompt(
    recording: tuple[str, list[dict]], tmp_path: pathlib.Path,
) -> None:
    base_url, recorded = recording
    store = FilesystemMemoryStore(root=tmp_path)
    await store.save(Memory(
        name="Python testing preference",
        description="user prefers pytest over unittest",
        type="user",
        content="User prefers pytest and uses fixtures heavily.",
    ))

    llm = OpenAiCompatLlmClient(base_url=base_url)
    async with await Agent.create(
        llm=llm,
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
        system_prompt="BASE",
        memory=store,
    ) as agent:
        async for _ in agent.prompt("How should I run python tests?"):
            pass

    system_msg = recorded[0]["messages"][0]
    assert system_msg["role"] == "system"
    assert "<memory" in system_msg["content"]
    assert "Python testing preference" in system_msg["content"]
    assert "pytest" in system_msg["content"]
```

- [ ] **Step 2: Run**

Run: `cd src/python && pytest tests/e2e/test_memory_injection.py -v`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/python/tests/e2e/test_memory_injection.py
git commit -m "test(python): e2e memory injection via extra_system"
```

---

### Task 5.6: MCP registration API + warning

**Files:**
- Create: `src/python/flash_agents/mcp/__init__.py`
- Modify: `src/python/flash_agents/agent.py`
- Create: `src/python/tests/unit/test_mcp_registration_warning.py`

- [ ] **Step 1: Write `mcp/__init__.py`**

```python
"""MCP server registration (wiring staged — accepted but not dispatched in v1)."""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field


@dataclass(frozen=True)
class McpServer:
    """Declarative config for an MCP server. v1 accepts but does not dispatch."""
    name: str
    command: list[str]
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)


def _warn_if_registered(mcp_servers: list[McpServer] | None) -> list[McpServer]:
    if not mcp_servers:
        return []
    seen: set[str] = set()
    out: list[McpServer] = []
    for s in mcp_servers:
        if s.name in seen:
            from flash_agents.errors import ConfigError
            raise ConfigError(f"duplicate MCP server name: {s.name!r}")
        seen.add(s.name)
        out.append(s)
    warnings.warn(
        "flash-agents v1 accepts mcp_servers for forward compatibility but "
        "does not yet dispatch calls to them. MCP wiring lands in a future release.",
        UserWarning,
        stacklevel=3,
    )
    return out


__all__ = ["McpServer"]
```

- [ ] **Step 2: Wire `mcp_servers` into `Agent.create()`**

Add `mcp_servers=None` kwarg and right after tools wiring:

```python
from flash_agents.mcp import McpServer, _warn_if_registered
self._mcp_servers = _warn_if_registered(mcp_servers)
```

(`self._mcp_servers` is stored for introspection; it is not used by any runtime code path in v1.)

- [ ] **Step 3: Write the test**

```python
"""Unit: mcp_servers registration emits warning once and rejects duplicates."""
from __future__ import annotations

import warnings

import pytest

from flash_agents import Agent, ConfigError
from flash_agents.mcp import McpServer


class _NoopLlm:
    async def stream(self, req):
        return
        yield


@pytest.mark.asyncio
async def test_mcp_servers_emit_warning() -> None:
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        agent = await Agent.create(
            llm=_NoopLlm(),
            model={"id": "m", "provider": "openai", "api": "openai-completions"},
            mcp_servers=[McpServer(name="git", command=["mcp-git"])],
        )
        await agent.dispose()
    assert any("mcp_servers" in str(x.message) for x in w)


@pytest.mark.asyncio
async def test_duplicate_mcp_name_raises() -> None:
    with pytest.raises(ConfigError, match="duplicate"):
        await Agent.create(
            llm=_NoopLlm(),
            model={"id": "m", "provider": "openai", "api": "openai-completions"},
            mcp_servers=[
                McpServer(name="x", command=["a"]),
                McpServer(name="x", command=["b"]),
            ],
        )
```

- [ ] **Step 4: Run**

Run: `cd src/python && pytest tests/unit/test_mcp_registration_warning.py -v`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/python/flash_agents/mcp/ src/python/flash_agents/agent.py src/python/tests/unit/test_mcp_registration_warning.py
git commit -m "feat(python): McpServer registration (staged — warns, rejects duplicates)"
```

---

### Task 5.7: Chunk 5 integration verification

- [ ] **Step 1: Run all**

Run: `cd src/python && pytest -v`
Expected: all unit + e2e pass.

---

## Chunk 6: Concurrency, CI, docs, and stub cleanup

### Task 6.1: Concurrent agents test

**Files:**
- Create: `src/python/tests/e2e/test_concurrent_agents.py`

- [ ] **Step 1: Write the test**

```python
"""E2E: two Agent instances in parallel; one agent serializes two prompts."""
from __future__ import annotations

import asyncio
import socket
from typing import AsyncIterator

import pytest
import pytest_asyncio
from aiohttp.web_runner import AppRunner, TCPSite

from flash_agents import Agent
from flash_agents.llm import OpenAiCompatLlmClient
from tests.e2e.mock_server import make_mock_app, default_canned_chunks


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def two_mocks() -> AsyncIterator[tuple[str, str]]:
    results: list[tuple[AppRunner, int]] = []
    for _ in range(2):
        app = make_mock_app(default_canned_chunks(), delay_between_ms=50)
        port = _find_free_port()
        runner = AppRunner(app)
        await runner.setup()
        await TCPSite(runner, "127.0.0.1", port).start()
        results.append((runner, port))
    try:
        yield (f"http://127.0.0.1:{results[0][1]}/v1", f"http://127.0.0.1:{results[1][1]}/v1")
    finally:
        for runner, _ in results:
            await runner.cleanup()


async def _drain(agent: Agent, msg: str) -> int:
    count = 0
    async for _ in agent.prompt(msg):
        count += 1
    return count


@pytest.mark.asyncio
async def test_two_agents_run_in_parallel(two_mocks: tuple[str, str]) -> None:
    a_url, b_url = two_mocks
    model = {"id": "mock-gpt", "provider": "openai", "api": "openai-completions"}
    a = await Agent.create(llm=OpenAiCompatLlmClient(base_url=a_url), model=model)
    b = await Agent.create(llm=OpenAiCompatLlmClient(base_url=b_url), model=model)
    try:
        ca, cb = await asyncio.gather(_drain(a, "hello"), _drain(b, "hello"))
        assert ca > 0 and cb > 0
    finally:
        await a.dispose()
        await b.dispose()


@pytest.mark.asyncio
async def test_same_agent_serializes(two_mocks: tuple[str, str]) -> None:
    a_url, _ = two_mocks
    agent = await Agent.create(
        llm=OpenAiCompatLlmClient(base_url=a_url),
        model={"id": "mock-gpt", "provider": "openai", "api": "openai-completions"},
    )
    try:
        c1, c2 = await asyncio.gather(_drain(agent, "one"), _drain(agent, "two"))
        assert c1 > 0 and c2 > 0
    finally:
        await agent.dispose()
```

- [ ] **Step 2: Run**

Run: `cd src/python && pytest tests/e2e/test_concurrent_agents.py -v`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/python/tests/e2e/test_concurrent_agents.py
git commit -m "test(python): concurrent agents + same-agent serialization"
```

---

### Task 6.2: CI workflow

**Files:**
- Create: `.github/workflows/python.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Python SDK

on:
  push:
    branches: [main]
  pull_request:
    paths:
      - "src/python/**"
      - "src/core/**"
      - "src/python/wasm-guest/**"
      - "src/python/wit/**"
      - "package.json"
      - ".github/workflows/python.yml"

jobs:
  test:
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        python-version: ["3.11", "3.12", "3.13"]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Install JS deps
        run: bun install
      - name: Build core.wasm
        run: bun run build:wasm:python
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - name: Install flash-agents
        working-directory: src/python
        run: |
          python -m pip install --upgrade pip
          pip install -e ".[dev]"
      - name: Run tests
        working-directory: src/python
        run: pytest -v
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/python.yml
git commit -m "ci: run flash-agents python tests on 3.11/3.12/3.13 x linux/macos"
```

---

### Task 6.3: Example script

**Files:**
- Create: `src/python/examples/hello.py`

- [ ] **Step 1: Write a minimal runnable example**

```python
"""Minimal flash-agents example: one prompt, one tool, against an OpenAI-compat endpoint.

Run:
    export OPENAI_API_KEY=...
    python src/python/examples/hello.py
"""
from __future__ import annotations

import asyncio
import os

from flash_agents import Agent, tool
from flash_agents.llm import OpenAiCompatLlmClient


@tool
async def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


async def main() -> None:
    llm = OpenAiCompatLlmClient(
        base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        api_key=os.environ.get("OPENAI_API_KEY"),
    )
    async with await Agent.create(
        llm=llm,
        model={"id": "gpt-4o-mini", "provider": "openai", "api": "openai-completions"},
        system_prompt="You are a helpful assistant.",
        tools=[add],
    ) as agent:
        async for event in agent.prompt("What is 2+3? Use the add tool."):
            if event["type"] == "message_update":
                for b in (event["message"].get("content") or []):
                    if isinstance(b, dict) and b.get("type") == "text":
                        print(b["text"], end="", flush=True)
        print()


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Commit**

```bash
git add src/python/examples/hello.py
git commit -m "docs(python): minimal example script"
```

---

### Task 6.4: Rewrite README

**Files:**
- Modify: `src/python/README.md`

- [ ] **Step 1: Replace contents**

```markdown
# flash-agents

Python SDK for `@researchcomputer/agents-sdk`. Runs the agent core as a
WebAssembly Component via `wasmtime-py` — no Rust extension, no Node at
runtime.

## Install

```bash
pip install flash-agents
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
- Filesystem-backed memory (`FilesystemMemoryStore`), Node-compatible.
- MCP server **registration** (wiring staged for a future release).
- OpenAI-compatible LLM client built in; `LlmClient` Protocol for custom transports.

## Development

```bash
# From repo root:
bun install
bun run build:wasm:python

cd src/python
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

## Spec

Design spec: `docs/superpowers/specs/2026-04-22-flash-agents-python-sdk-design.md`
```

- [ ] **Step 2: Commit**

```bash
git add src/python/README.md
git commit -m "docs(python): README quickstart + features"
```

---

### Task 6.5: Remove `examples/python-stub/`

**Files:**
- Delete: `examples/python-stub/`
- Modify: `package.json` (root), `README.md` (root), `docs/embedding-core.md`, `CLAUDE.md`, `INTEGRATIONS.md` as needed

- [ ] **Step 1: Find all references**

Run: `grep -rn "examples/python-stub\|python-stub" --include="*.md" --include="*.ts" --include="*.json" --include="*.yml" --include="*.yaml" .`

- [ ] **Step 2: Update references**

For each reference:
- In `README.md` (root), `docs/embedding-core.md`, `INTEGRATIONS.md`: replace `examples/python-stub/` descriptions with `src/python/` and point at `pip install flash-agents`.
- In `package.json`: drop the old `build:wasm`, `build:wasm:bundle`, `build:wasm:componentize` scripts targeting `examples/python-stub/` unless other files still reference them. Keep the new `build:wasm:python:*` scripts.
- In `CLAUDE.md`: update the Python/WASM embedding section to describe `src/python/` as the reference embedding; drop the maturin + Rust mentions.

- [ ] **Step 3: Remove the stub directory**

Run: `rm -rf examples/python-stub/`

- [ ] **Step 4: Confirm repo still builds + tests pass**

Run:
```bash
bun run lint
bun run test
bun run build:wasm:python
cd src/python && pytest -v
```
Expected: every step exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove examples/python-stub (superseded by src/python)"
```

---

### Task 6.6: Final integration verification

- [ ] **Step 1: Full repo test from scratch**

Run:
```bash
git status                   # expect clean
bun run lint
bun run test
bun run build:wasm:python
cd src/python && pytest -v
```
Every step exits 0.

- [ ] **Step 2: Verify the SDK installs cleanly from outside the source tree**

Run:
```bash
cd /tmp && python -m venv test-install && source test-install/bin/activate
pip install -e /path/to/repo/src/python
python -c "from flash_agents import Agent, tool, Tool, ToolContext; print('ok')"
```
Expected: `ok`.

- [ ] **Step 3: Review final git history**

Run: `git log --oneline | head -40`
Expected: one coherent sequence of commits from the Chunk 1 core change through the stub removal.

---

## Done

All chunks passed. The SDK is:
- One pure-Python universal wheel (`flash-agents`) that bundles `core.wasm`.
- Supports multi-turn agents with user-defined Python tools, filesystem memory, MCP registration.
- Tests cover unit schema inference, Node-memory parity, e2e one/multi-turn, tool success / raise / async I/O, loop-binding, concurrent agents, MCP warning.
- CI runs on Python 3.11/3.12/3.13 × Linux/macOS.
