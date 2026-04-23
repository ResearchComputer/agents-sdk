<!-- Content placement rule: this file is the scannable router. Keep code snippets ≤3 lines; narrative belongs in docs/integrations.md. -->

# Integrating `@researchcomputer/agents-sdk`

Three integration paths, depending on what you're building. Pick one.

## 1. Build on Node.js

You're writing a Node.js app that uses the SDK as a library.

- **Entry point:** `createAgent()` from `@researchcomputer/agents-sdk`.
- **Start here:** [docs/getting-started.md](./docs/getting-started.md).
- **Full overview:** [docs/integrations.md § Path 1](./docs/integrations.md#path-1-build-on-nodejs).

```bash
npm install @researchcomputer/agents-sdk @researchcomputer/ai-provider
```

## 2. Embed the core in a non-Node host

You're running the agent loop from Python, Rust, Go, a browser sandbox, or any other non-Node environment. Two sub-paths:

### 2a. ES module import

For JS runtimes that aren't Node (Deno, Bun, browser worker).

- **Entry point:** `createAgentCore()` from `@researchcomputer/agents-sdk/core`.
- **Guide:** [docs/embedding-core.md § ES module import](./docs/embedding-core.md#two-embedding-paths).

### 2b. WASM Component

For non-JS hosts (Rust, Python, Go, …).

- **Artifact:** `core.wasm` built by `npm run build:wasm`.
- **ABI contract:** [docs/spec/wasm.md](./docs/spec/wasm.md) — authoritative: [`examples/python-stub/wasm/world.wit`](./examples/python-stub/wasm/world.wit).
- **Reference implementation:** [`examples/python-stub/`](./examples/python-stub).
- **Guide:** [docs/embedding-core.md § WASM Component path](./docs/embedding-core.md#the-wasm-component-path).

## 3. Consume agent outputs or generate bindings

You're writing code that reads SDK-produced artifacts (session snapshots, trajectory JSONL, hook payloads) or generating typed bindings from our schemas.

- **Contract surface:** [docs/spec/README.md](./docs/spec/README.md).
- **Schemas:** [docs/spec/schemas/](./docs/spec/schemas).
- **Conventions + examples:** [docs/spec/README.md § Worked example](./docs/spec/README.md#worked-example-validating-a-trajectory).
- **Full overview:** [docs/integrations.md § Path 3](./docs/integrations.md#path-3-consume-agent-outputs-or-generate-bindings).

## Not sure which path?

Quick heuristic:

- Can you `npm install` and stay on Node? → **Path 1**.
- Need to run the agent loop outside Node? → **Path 2**.
- Only reading or writing agent data files? → **Path 3**.

See [docs/integrations.md § Choosing a path](./docs/integrations.md#choosing-a-path) for the decision matrix with more detail.
