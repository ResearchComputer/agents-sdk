# @researchcomputer/agents-sdk

A TypeScript SDK for building coding agents powered by large language models. Built on `@mariozechner/pi-agent-core`, it provides a high-level framework for creating agents with file operations, shell execution, web access, permission controls, memory, sessions, MCP servers, and multi-agent swarms.

[![npm version](https://img.shields.io/npm/v/@researchcomputer/agents-sdk)](https://www.npmjs.com/package/@researchcomputer/agents-sdk) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- 🔧 **Built-in Tools** — File operations (Read, Write, Edit, Glob, Grep), shell execution (Bash), web access (WebFetch, WebSearch), Jupyter notebook editing, and user interaction
- 🔒 **Permission System** — Capability-based access control with multiple modes (default, allowAll, rulesOnly) and interactive prompting
- 🧠 **Memory** — Persistent, queryable per-agent memories with relevance scoring
- 💾 **Sessions** — Snapshot-based conversation persistence and resumption
- 🔌 **MCP** — Connect external tool servers via Model Context Protocol (stdio, SSE, HTTP transports)
- 🐝 **Swarm** — Multi-agent coordination with mailbox messaging and task delegation
- 🌿 **Snapshot & Fork** — Checkpoint agent state and branch into parallel explorations
- 🪝 **Middleware & Hooks** — Observe and modify agent behavior at lifecycle points
- 📊 **Observability** — Token/cost tracking and trace IDs for debugging

## Documentation

| Document | Description |
|---|---|
| [Getting Started](./docs/getting-started.md) | Installation, quick start, and first agent |
| [Core Concepts](./docs/concepts.md) | Architecture, tools, permissions, memory, sessions, MCP, swarm |
| [API Reference](./docs/api-reference.md) | Complete API documentation with types and examples |
| [Examples](./docs/examples.md) | Practical usage patterns and recipes |

## Quick Start

### Installation

```bash
npm install @researchcomputer/agents-sdk @researchcomputer/ai-provider
```

### Minimal Example

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';

const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  cwd: process.cwd(),
  getApiKey: async () => process.env.OPENAI_API_KEY,
});

await agent.prompt('List all TypeScript files and summarize what they do');
await agent.dispose();
```

## Integrations

Three ways to use this SDK from an external codebase:

| Path | For | Start here |
|---|---|---|
| **Node.js library** | Apps built on Node | [docs/getting-started.md](./docs/getting-started.md) |
| **Non-Node host** | Python, Rust, Go, browser, Deno, Bun — anywhere ES modules or WASM Components run | [docs/embedding-core.md](./docs/embedding-core.md) |
| **Consuming agent outputs** | External systems reading session snapshots, trajectories, hook payloads | [docs/spec/README.md](./docs/spec/README.md) |

Full router: [INTEGRATIONS.md](./INTEGRATIONS.md).

## Authentication

The SDK supports two auth patterns:

- Direct provider auth, where you pass a provider API key via `getApiKey`.
- Research Computer hosted auth, where you log in once and let the SDK reuse a stored session JWT.

### Provider API Keys

```bash
export OPENAI_API_KEY=sk-...
```

```typescript
const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  getApiKey: async () => process.env.OPENAI_API_KEY,
});
```

### Login / Session Auth

For the hosted login flow, set the proxy and Stytch env vars, then call `initiateLogin()` once:

```bash
export RC_LLM_PROXY_URL=https://api.research.computer
export STYTCH_PUBLIC_TOKEN=public-token-...
```

```typescript
import { createAgent, initiateLogin, logout } from '@researchcomputer/agents-sdk';

await initiateLogin(); // opens the browser and saves ~/.rc-agents/auth.json

const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
});

await agent.prompt('Summarize this repository');
await agent.dispose();

await logout(); // revokes the session best-effort and removes ~/.rc-agents/auth.json
```

When no custom `getApiKey` is provided, `createAgent()` resolves auth in this order:

1. `config.authToken`
2. `RC_AUTH_TOKEN`
3. `~/.rc-agents/auth.json` via `getSession()`
4. Legacy telemetry API key fallbacks

If none of those are present, it throws `AuthRequiredError`.

## Architecture Overview

```
@researchcomputer/agents-sdk
├── Factory            createAgent() — main entry point
├── Tools              Built-in: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, NotebookEdit, AskUser
├── Permissions        Capability-based access control with multiple modes
├── Memory             Persistent, queryable per-agent memories
├── Sessions           Snapshot-based conversation persistence
├── MCP                Connect external tool servers via Model Context Protocol
├── Swarm              Multi-agent coordination with mailbox messaging
├── Middleware         Hooks, permission gates, and pipeline composition
├── Context            Message conversion, system prompt construction, compression
└── Observability      Token/cost tracking and trace IDs
```

## Development

This repo uses [Bun](https://bun.sh) as the primary toolchain — it drives installs, scripts, and the WASM bundler. The published artifact is a standard Node ESM package, so consumers can continue to use `npm`, `pnpm`, or `yarn` without installing Bun.

```bash
# Install dependencies (Bun is the primary package manager)
bun install

# Build
bun run build

# Run tests (Vitest under Bun)
bun run test

# Type check
bun run lint

# Build the WASM component for the Python/WASM embedding
bun run build:wasm
```

`npm` still works for every script above — `npm install && npm run test` is supported for contributors who don't want to add a second toolchain. The only thing exclusive to Bun is the WASM bundler, which calls the `Bun.build()` API directly in `examples/python-stub/wasm/bun-build.ts`.

## Requirements

- Node.js >= 20.0.0
- Bun >= 1.3.0 (for contributors; consumers don't need it)
- TypeScript >= 5.7.0 (for development)

## License

MIT
