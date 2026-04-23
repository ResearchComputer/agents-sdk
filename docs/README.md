# Documentation

Pick the path that matches what you're building. Every document below is reachable from one of the three cards — the audience cards above the index are the fast path; the index below is the complete map.

## I'm building a Node.js app that uses the SDK as a library

You want `createAgent()`. Read these in order:

1. [Getting Started](./getting-started.md) — install, configure, send your first prompt.
2. [Core Concepts](./concepts.md) — architecture, tools, permissions, memory, MCP, swarm, snapshots.
3. [Examples](./examples.md) — copy-paste patterns for read-only agents, interactive prompts, multi-agent swarm, hooks.
4. [API Reference](./api-reference.md) — every exported type and function.

## I'm embedding the core runtime in a non-Node host

You are running the agent loop from Python, Rust, Go, a browser sandbox, or any other non-Node environment. Read:

1. [Embedding the Core](./embedding-core.md) — the step-by-step guide.
2. [`docs/spec/wasm.md`](./spec/wasm.md) — the WIT ABI reference (for the WASM path).
3. [`examples/python-stub/`](../examples/python-stub) — the working reference implementation.

Also useful: [API Reference → Core factory](./api-reference.md#core-factory) and [API Reference → Adapter Interfaces](./api-reference.md#adapter-interfaces).

## I'm consuming agent outputs or generating bindings from our contracts

You are writing code in another language that reads session snapshots, trajectory JSONL, hook payloads, or other SDK-produced artifacts — or generating typed bindings from our schemas. Read:

1. [`docs/spec/README.md`](./spec/README.md) — overview of contracts, versioning, conventions.
2. [`docs/spec/schemas/`](./spec/schemas) — authoritative JSON Schemas.
3. [`docs/spec/wasm.md`](./spec/wasm.md) — the WASM embedding ABI.

## Integrations overview

For a one-page summary of all three paths and how they relate, see [`INTEGRATIONS.md`](../INTEGRATIONS.md) at the repository root and [`docs/integrations.md`](./integrations.md) for deeper pointers.

---

## Full document index

| Document | Purpose |
|---|---|
| [Getting Started](./getting-started.md) | Install, configure, and write a first Node agent |
| [Core Concepts](./concepts.md) | Architecture, tools, permissions, memory, sessions, MCP, swarm, snapshots |
| [API Reference](./api-reference.md) | Complete API documentation |
| [Examples](./examples.md) | Practical patterns and recipes |
| [Snapshot & Fork](./snapshot-fork.md) | Deep dive on checkpointing, branching, best-of-N |
| [Embedding the Core](./embedding-core.md) | Non-Node host guide (WASM, Python, Rust, browser, …) |
| [Integrations](./integrations.md) | Overview of all third-party integration paths |
| [`docs/spec/README.md`](./spec/README.md) | Cross-language contract surface |
| [`docs/spec/wasm.md`](./spec/wasm.md) | WIT ABI reference for WASM embedders |
| [`INTEGRATIONS.md`](../INTEGRATIONS.md) | Repository-root router for the three paths |
