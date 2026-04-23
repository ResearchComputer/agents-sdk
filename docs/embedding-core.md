# Embedding the Core Runtime

> *Audience: developers building a non-Node host for the agent loop — WASM, browser sandbox, Python, Rust, Go, or a deterministic replay harness. If you are building a Node.js app, start with [Getting Started](./getting-started.md) instead.*

## Table of Contents

- [When to embed the core](#when-to-embed-the-core)
- [Two embedding paths](#two-embedding-paths)
- [The core runtime and its adapters](#the-core-runtime-and-its-adapters)
- [Implementing `CoreAdapters`](#implementing-coreadapters)
- [Computing `systemPromptHash`](#computing-systemprompthash)
- [Wiring a minimal agent](#wiring-a-minimal-agent)
- [The WASM Component path](#the-wasm-component-path)
- [Reference implementation: the Python stub](#reference-implementation-the-python-stub)
- [Common pitfalls](#common-pitfalls)
- [See also](#see-also)

## When to embed the core

`createAgent()` (from `@researchcomputer/agents-sdk`) is the right entry point for Node.js apps. It bundles filesystem-backed memory/session stores, MCP stdio/SSE/HTTP transports, the `ai-provider`-backed LLM client, and the browser-based login flow into one factory call.

You embed the core directly when:

- you are in a non-Node runtime (WASM, browser sandbox, Python via `wasmtime`, etc.),
- you need to replace one or more adapters for a specialized use case (deterministic replay, in-memory test harness, custom LLM transport), or
- you want to run the agent loop with strict isolation from the Node filesystem and process APIs.

If none of those apply, use `createAgent()` — this guide is not for you.

## Two embedding paths

| Path | Best for | Entry point | Artifact |
|---|---|---|---|
| **ES module import** | JS/TS hosts that can `import` ESM (browser workers, Deno, Bun, non-Node ESM runtimes) | `createAgentCore` from `@researchcomputer/agents-sdk/core` | npm package |
| **WASM Component** | Non-JS hosts (Rust, Python, Go, …) that can load a WebAssembly Component | `agent` resource from `rc-agent-core` world | `core.wasm` built by `npm run build:wasm` |

Under the hood these are the same runtime. The WASM Component path wraps the ES module in a Component Model interface so any language with a Component Model runtime can drive it. The ABI contract lives in [`docs/spec/wasm.md`](./spec/wasm.md) and the WIT file at [`examples/python-stub/wasm/world.wit`](../examples/python-stub/wasm/world.wit).

## The core runtime and its adapters

The core factory is `createAgentCore(config, adapters)`. It takes the same config shape as `createAgent()` (minus the filesystem-specific `memoryDir` / `sessionDir` / `telemetry` fields) and a bundle of adapter implementations the host must supply.

```typescript
interface CoreAdapters {
  memoryStore: MemoryStore;           // load/save/remove memory records
  sessionStore: SessionStore;         // load/save/list session snapshots
  telemetryCollector: TelemetryCollector;
  telemetrySink: TelemetrySink;       // flush telemetry at dispose
  mcpManager: McpManager;             // manage MCP connections
  authTokenResolver: AuthTokenResolver;
  llmClient: LlmClient;               // the LLM transport seam
  telemetryOptOut?: boolean;
}
```

Each interface is defined in `src/core/types.ts` and exported from `@researchcomputer/agents-sdk/core`. See [API Reference → Adapter Interfaces](./api-reference.md#adapter-interfaces) for the full signatures.

The core never touches the filesystem, spawns processes, or imports `@researchcomputer/ai-provider` at runtime. Everything host-specific is reached through one of the adapters above.

## Implementing `CoreAdapters`

Minimal implementations that are valid for every adapter.

### `MemoryStore`

```typescript
const memoryStore: MemoryStore = {
  async load() { return []; },           // no memories
  async save(_memory) {},                 // no-op
  async remove(_name) {},
};
```

A production implementation reads and writes `Memory` records from your host's storage (browser IndexedDB, SQLite, object store, …).

### `SessionStore`

```typescript
const sessions = new Map<string, SessionSnapshot>();
const sessionStore: SessionStore = {
  async load(id) { return sessions.get(id) ?? null; },
  async save(snapshot) { sessions.set(snapshot.id, snapshot); },
  async list() { return [...sessions.values()].map(s => ({ id: s.id, updatedAt: s.updatedAt })); },
};
```

### `TelemetryCollector` and `TelemetrySink`

```typescript
import { createTelemetryCollector } from '@researchcomputer/agents-sdk/core';

const telemetryCollector = createTelemetryCollector({ optOut: true });
const telemetrySink: TelemetrySink = { async flush(_snapshot) {} };
```

The built-in collector is pure and safe to use in any runtime.

### `McpManager`

If your host does not support MCP, return a no-op manager:

```typescript
const mcpManager: McpManager = {
  async connect(_config) { throw new Error('MCP not supported'); },
  async disconnect(_name) {},
  getTools() { return []; },
  getConnections() { return []; },
};
```

### `AuthTokenResolver`

```typescript
const authTokenResolver: AuthTokenResolver = {
  async resolve() { return hostSuppliedToken; },
};
```

The core only asks for a token when `config.getApiKey` is not set. In most embeddings you pass `getApiKey` directly instead of implementing this.

### `LlmClient`

The only adapter that does real work. Its shape:

```typescript
interface LlmClient {
  stream: StreamFn;        // matches pi-agent-core's StreamFn
  completeN(model, context, n, options?): Promise<AssistantMessage[]>;
}
```

A minimal `LlmClient` that bridges to a host-supplied streaming function:

```typescript
const llmClient: LlmClient = {
  async *stream(model, context, options) {
    // Call your host's LLM API and yield chunks matching
    // pi-ai's StreamChunk shape.
    yield* hostStreamFn(model, context, options);
  },
  async completeN(model, context, n, options) {
    // Fan out to parallel stream() calls or use a native n>1 path.
    const results = await Promise.all(
      Array.from({ length: n }, () => collectStream(this.stream(model, context, options))),
    );
    return results.map(toAssistantMessage);
  },
};
```

See `examples/python-stub/py/rc_agents/llm_clients.py` for a complete OpenAI-compatible reference implementation.

## Computing `systemPromptHash`

The Node factory hashes the assembled system prompt via `node:crypto`. The core factory cannot do this itself (no `node:*` imports), so you pass the hash as `config.systemPromptHash`:

```typescript
import { buildSystemPrompt } from '@researchcomputer/agents-sdk/core';

// `memories` must be MemorySelection[] (i.e., already scored by
// retrieve()), not a raw Memory[]. See retrieve() in
// @researchcomputer/agents-sdk/core.
const prompt = buildSystemPrompt({ basePrompt, skills, tools, memories });

// Web Crypto (browser, Deno, Bun, WASM-with-WASI)
const bytes = new TextEncoder().encode(prompt);
const digest = await crypto.subtle.digest('SHA-256', bytes);
const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
const systemPromptHash = `sha256:${hex}`;
```

## Wiring a minimal agent

```typescript
import {
  createAgentCore,
  createTelemetryCollector,
  type CoreAdapters,
  type AgentCoreConfig,
} from '@researchcomputer/agents-sdk/core';

const adapters: CoreAdapters = {
  memoryStore,
  sessionStore,
  mcpManager,
  telemetryCollector: createTelemetryCollector({ optOut: true }),
  telemetrySink: { async flush() {} },
  authTokenResolver: { async resolve() { return hostToken; } },
  llmClient,
  telemetryOptOut: true,
};

const config: AgentCoreConfig = {
  model,
  cwd: '/sandbox',
  systemPromptHash,            // precomputed above
  permissionMode: 'allowAll',
  enableMemory: false,
};

const agent = await createAgentCore(config, adapters);
await agent.prompt('Hello');
await agent.dispose();
```

This yields the same `Agent` surface as `createAgent()`: `prompt`, `snapshot`, `restore`, `fork`, `forkFrom`, `promptFork`, `dispose`.

## The WASM Component path

For non-JS hosts, build the core into a WebAssembly Component and call it through generated bindings.

### Build

```bash
npm run build:wasm
# produces examples/python-stub/dist/core.wasm
```

The pipeline is:
1. `build:wasm:bundle` — esbuild bundles `src/core/` into a single ESM file suitable for `componentize-js`.
2. `build:wasm:componentize` — `jco componentize` wraps the bundle as a WASM Component using the WIT world in `examples/python-stub/wasm/world.wit`.

### The ABI contract

```wit
world rc-agent-core {
  import host-llm;
  export agent;
}
```

The host implements `host-llm` (one LLM streaming call) and calls `agent.agent` to run turns. See [`docs/spec/wasm.md`](./spec/wasm.md) for the full contract — this guide shows you how to wire one up; that document is the reference.

## Reference implementation: the Python stub

[`examples/python-stub/`](../examples/python-stub) is a working Python ↔ Rust ↔ WASM host. File map:

| File | Role |
|---|---|
| `wasm/world.wit` | The ABI contract |
| `wasm/entrypoint.ts` | Guest-side glue: wires `createAgentCore` into the WIT exports |
| `wasm/adapters.ts` | No-op `memory`, `session`, `mcp`, `telemetry`, `auth` adapters |
| `wasm/llm-bridge.ts` | Wraps the `host-llm` import as the core's `LlmClient` |
| `wasm/agent-events.ts` | Bridges `Agent.subscribe(fn)` into an `AsyncIterable` |
| `rust/Cargo.toml`, `rust/src/*.rs` | Rust host: wasmtime + PyO3 |
| `py/rc_agents/agent.py` | Python async `Agent` wrapper |
| `py/rc_agents/llm_clients.py` | `OpenAiCompatLlmClient` reference implementation |
| `py/rc_agents/message_translate.py` | pi-ai ↔ OpenAI translator |
| `py/mock_server.py` | aiohttp mock LLM for tests |
| `py/example.py` | Runnable demo |

Use it as the starting template for new hosts.

## Common pitfalls

- **Telemetry stubbing.** If `telemetryOptOut` is false and your sink writes to disk, the core will happily attempt to serialize the session on dispose. In non-Node hosts, pass `telemetryOptOut: true` and a no-op `telemetrySink.flush`.
- **MCP in non-Node hosts.** The MCP SDK depends on `node:net` and `node:child_process`. Non-Node hosts that want MCP need a port of the SDK; the default is a no-op manager.
- **Auth resolver fallback chain.** Node's default resolver reads `~/.rc-agents/auth.json`. In a non-Node host you typically supply the token directly via `config.authToken` or a custom resolver; don't rely on the default.
- **`systemPromptHash` mismatch.** If the hash you pass doesn't match the actual system prompt, session resume may silently discard messages because the prompt is treated as "drifted." Regenerate the hash whenever prompt inputs change.
- **`cwd` is required.** The core factory does not fall back to `process.cwd()`. Pass an explicit sandbox path even if no tool touches the filesystem.
- **Model context API mismatches.** `pi-agent-core` expects pi-ai's message shape. If your LLM speaks OpenAI or Anthropic, translate in the `LlmClient` (see `examples/python-stub/py/rc_agents/message_translate.py`).

## See also

- [API Reference → Core factory](./api-reference.md#core-factory) — full type signatures for `createAgentCore` and `CoreAdapters`.
- [Core Concepts → Architecture Overview](./concepts.md#architecture-overview) — the core/node split and how skills compose.
- [`docs/spec/wasm.md`](./spec/wasm.md) — the WIT ABI reference.
- [`examples/python-stub/`](../examples/python-stub) — working reference implementation.
