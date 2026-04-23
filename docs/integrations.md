<!-- Content placement rule: this file is the single source of truth for integration narrative and snippets. INTEGRATIONS.md at the repo root is the scannable router — keep code snippets there to ≤3 lines and link back here for detail. -->

# Integrations

Three ways to use `@researchcomputer/agents-sdk` from an external codebase, depending on what you're building.

## Table of Contents

- [Decision matrix](#decision-matrix)
- [Path 1: Build on Node.js](#path-1-build-on-nodejs)
- [Path 2: Embed the core in a non-Node host](#path-2-embed-the-core-in-a-non-node-host)
- [Path 3: Consume agent outputs or generate bindings](#path-3-consume-agent-outputs-or-generate-bindings)
- [Choosing a path](#choosing-a-path)
- [See also](#see-also)

## Decision matrix

| If you want to… | Pick path | Entry point |
|---|---|---|
| Run the SDK as a library inside a Node app | **1** | `createAgent()` from `@researchcomputer/agents-sdk` |
| Run the agent loop in a JS runtime that isn't Node (Deno, Bun, browser worker) | **2a** | `createAgentCore()` from `@researchcomputer/agents-sdk/core` |
| Run the agent loop from Python, Rust, Go, or any non-JS language | **2b** | `core.wasm` via Component Model bindings |
| Read session snapshots, trajectories, or hook payloads from files | **3** | `docs/spec/schemas/*.json` |
| Generate typed bindings for your language | **3** | `docs/spec/schemas/*.json` + standard JSON-Schema codegen |

## Path 1: Build on Node.js

The most common case. You install the SDK and call `createAgent()` from your app.

```bash
npm install @researchcomputer/agents-sdk @researchcomputer/ai-provider
```

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';

const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  cwd: process.cwd(),
  getApiKey: async () => process.env.OPENAI_API_KEY,
});

await agent.prompt('List the TypeScript files and summarize what they do');
await agent.dispose();
```

You get filesystem-backed memory/session stores, MCP support, hosted auth, and all ten built-in tools out of the box. Read [Getting Started](./getting-started.md) for the full setup, then [Examples](./examples.md) for common patterns. [API Reference](./api-reference.md) covers every exported type.

## Path 2: Embed the core in a non-Node host

The core runtime (under `src/core/`) has no `node:*` imports. It talks to its environment only through adapters, so any JS or non-JS host that can supply those adapters can run the agent loop.

### 2a. ES module import

If your runtime can `import` ES modules (Deno, Bun, browser worker, other non-Node JS runtimes), use `createAgentCore()` directly:

```typescript
import {
  createAgentCore,
  createTelemetryCollector,
  type CoreAdapters,
} from '@researchcomputer/agents-sdk/core';

const adapters: CoreAdapters = {
  memoryStore,        // your implementation
  sessionStore,       // your implementation
  mcpManager,         // no-op is fine if you don't need MCP
  telemetryCollector: createTelemetryCollector({ optOut: true }),
  telemetrySink: { async flush() {} },
  authTokenResolver: { async resolve() { return hostToken; } },
  llmClient,          // bridges to your LLM of choice
  telemetryOptOut: true,
};

const agent = await createAgentCore(
  { model, cwd: '/sandbox', systemPromptHash, permissionMode: 'allowAll' },
  adapters,
);
```

### 2b. WASM Component

For non-JS hosts (Rust, Python, Go, …), build a WebAssembly Component once and load it through the Component Model:

```bash
npm run build:wasm
# produces examples/python-stub/dist/core.wasm
```

The Component implements the `rc-agent-core` world declared in `examples/python-stub/wasm/world.wit`. Your host provides the `host-llm` interface (one streaming LLM call) and calls the `agent` resource to run turns.

Reference implementation: [`examples/python-stub/`](../examples/python-stub). It wires `core.wasm` to Python through Rust+PyO3, including a mock OpenAI-compatible LLM server for tests.

### Which sub-path to pick

- **2a** if your host can already run ES modules — it's lighter and avoids the Component Model entirely.
- **2b** if your host is not a JS runtime, or if you want an ABI-stable distribution artifact (`core.wasm`) instead of an npm dependency.

Both give you the same `Agent` surface. Read [Embedding the Core](./embedding-core.md) for the step-by-step guide; read [`docs/spec/wasm.md`](./spec/wasm.md) for the WIT ABI reference.

## Path 3: Consume agent outputs or generate bindings

If you are not running the agent at all — you are only reading or writing its output files — `docs/spec/` is what you need. It contains:

- **JSON Schemas** under `docs/spec/schemas/` for every artifact: session snapshots, trajectory events, hook payloads, MCP server descriptors, permission rules, memory records, tool schemas.
- **Golden example files** under `docs/spec/examples/` showing valid and invalid instances of each schema.
- **Per-schema prose** under `docs/spec/prose/` explaining ordering, correlation, and invariant rules the JSON Schema cannot capture.
- **A version table** at `docs/spec/VERSIONS.md` listing the current version and status of each record.

```python
# Python — validate a trajectory JSONL file
import json, jsonschema
schema = json.load(open("docs/spec/schemas/trajectory-event.v1.schema.json"))
for line in open("trajectory.jsonl"):
    jsonschema.validate(json.loads(line), schema)
```

For typed bindings, any JSON-Schema-to-language generator works (`quicktype`, `datamodel-code-generator`, `schemars`, …). See [`docs/spec/README.md`](./spec/README.md) for the full contract surface and language-specific loading patterns.

## Choosing a path

A quick heuristic:

- If you can `npm install` and stay on Node, use **Path 1**.
- If you need to run the agent loop outside Node, use **Path 2**.
- If you only need to read or write agent data files, use **Path 3**.

Paths are not mutually exclusive. A Node service might embed the core in a browser worker (Path 2a) *and* read archived trajectories from S3 (Path 3). Pick the one that matches each boundary.

## See also

- [`INTEGRATIONS.md`](../INTEGRATIONS.md) — the one-page router.
- [Getting Started](./getting-started.md) — Path 1 walkthrough.
- [Embedding the Core](./embedding-core.md) — Path 2 walkthrough.
- [`docs/spec/README.md`](./spec/README.md) — Path 3 reference.
- [Core Concepts → Architecture Overview](./concepts.md#architecture-overview) — the core/node split explained.
