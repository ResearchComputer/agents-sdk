# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

The primary toolchain is Bun (`>=1.3.0`); `npm` scripts still work for
contributors who don't want a second toolchain installed. Both commands
below behave identically — the `bun run` variant is preferred in
docs/CI. The WASM bundler is Bun-only (calls `Bun.build()` directly).

```bash
bun run build                   # Build all referenced projects (tsc -b) to ./dist
bun run dev                     # TypeScript compiler in watch mode (tsc --watch)
bun run test                    # Lint src/core/ for node: imports, then run Vitest once
bun run test:watch              # Vitest in watch mode
bun run lint                    # Build-mode typecheck without emit (tsc -b --noEmit)
bun run build:wasm:python       # Bundle + componentize core.wasm for the flash-agents Python SDK (src/python/)
```

The `build:wasm:python` pipeline (`build:wasm:python:bundle` + `:componentize` + `:sha`) produces `src/python/flash_agents/wasm/core.wasm` — the portable core exposed as a WebAssembly Component, loaded by the Rust+PyO3+wasmtime host at `src/python/wasm-host/`.

Run a single test file:
```bash
bun x vitest run src/node/tools/read.test.ts   # or: npx vitest run ...
```

## Architecture

**@researchcomputer/agents-sdk** is a TypeScript SDK for building LLM-powered coding agents. It wraps `@mariozechner/pi-agent-core` (agent runtime) and `@researchcomputer/ai-provider` (multi-provider LLM interface).

The codebase is split into two layers:

- **`src/core/`** — language-agnostic runtime. No `node:*` imports in non-test files; talks to hosts through adapters (LLM client, memory/session stores, MCP manager, telemetry, auth). Published at `@researchcomputer/agents-sdk/core`. The `test:lint-core` script enforces the no-`node:` rule (it excludes `*.test.ts` — tests under `src/core/spec/` legitimately use `node:fs` / `node:path` to read on-disk schema fixtures).
- **`src/node/`** — Node.js host. Supplies default adapter implementations plus the built-in tools and hosted-auth flow. Published as the default `@researchcomputer/agents-sdk` entry point.

### Entry points
- `src/node/factory.ts` — `createAgent()` is the Node entry point; builds `CoreAdapters` and delegates to `createAgentCore()`.
- `src/core/factory.ts` — `createAgentCore()` is the language-agnostic factory used by non-Node hosts (WASM, browser sandbox). See `src/python/` for the reference Python embedding (Rust+PyO3+wasmtime host at `src/python/wasm-host/`, Python SDK at `src/python/flash_agents/`).
- `src/node/index.ts` — public API surface (re-exports everything in `src/core/index.ts`).
- `src/core/types.ts` — shared type definitions (Capability, PermissionMode, Memory, SdkTool, etc.).

### Subsystems

**Tools** (`src/node/tools/`): Node-only. 10 built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, NotebookEdit, AskUser). Each tool declares required `capabilities` for permission checks. `util.ts` provides path resolution, safety checks, and truncation helpers.

**Middleware** (`src/core/middleware/`): Pipeline of hooks → permission checks → `runContext`. `permission-middleware.ts` implements specificity-based rule matching. `pipeline.ts` wires them together.

**Memory** (`src/core/memory/` + `src/node/memory/`): Core exposes the `MemoryStore` interface and a pure `retrieve()` for relevance scoring. `src/node/memory/node-memory-store.ts` is the filesystem-backed default that reads/writes Markdown + YAML frontmatter under `~/.rc-agents/memory`.

**Sessions** (`src/core/session/` + `src/node/session/`): Same split. Core defines `SessionStore`; node's `node-session-store.ts` persists JSON snapshots (atomic tmp-and-rename) under `~/.rc-agents/sessions`.

**Context** (`src/core/context/`): `system-prompt.ts` assembles the full prompt. `compression.ts` handles context overflow via truncate or summarize. `converter.ts` transforms agent messages to LLM format.

**MCP** (`src/core/mcp/` + `src/node/mcp/`): Core owns schema conversion and tool wrapping. Node owns the stdio/SSE/HTTP transports via `@modelcontextprotocol/sdk`.

**Agents/Swarm** (`src/core/agents/`): `SwarmManager` creates multi-agent teams with a leader + teammates, async message queues, and task budgets.

**Observability** (`src/core/observability/`): Per-model token/cost tracking and trace IDs.

**Telemetry** (`src/core/telemetry/` + `src/node/telemetry/`): Core collects per-session LLM/tool events. Node writes the `telemetry.jsonl` sidecar and does deferred HTTP upload. Wired by the factory, flushed during `dispose()` after `SessionEnd` hooks.

**Auth** (`src/node/auth/`): Node-only. Research Computer hosted login flow. `login.ts` performs the browser-based Stytch exchange; `session.ts` reads/writes `~/.rc-agents/auth.json`. `resolver.ts` resolves the auth token via `config.authToken` → `RC_AUTH_TOKEN` → `getSession()` → legacy fallbacks, else throws `AuthRequiredError`.

**Skills** (`src/core/skills.ts`): `composeAgentConfig()` merges skill-contributed tools, hooks, MCP servers, and permission rules into a unified `AgentConfig`.

**LLM adapter** (`src/core/llm/` + `src/node/llm/`): Core defines `LlmClient`. Node's `createAiProviderLlmClient()` delegates to `@researchcomputer/ai-provider`. Non-Node hosts supply their own.

**Snapshot/Fork** (in `src/core/factory.ts`): `snapshot()` / `restore()` checkpoint the message history. `fork()` / `forkFrom()` spawn N parallel child agents. `autoFork` config forks automatically on each user turn.

**Python SDK — `flash-agents`** (`src/python/`): Packages `src/core/` as a WebAssembly Component and exposes it to Python via a Rust+PyO3+wasmtime host. Build pipeline: `bun run build:wasm:python` (Bun bundles the core, then `jco componentize` wraps against `src/python/wit/world.wit`). The Rust host (`src/python/wasm-host/`) is built via `maturin develop` from its own Cargo crate. The Python surface (`src/python/flash_agents/`) provides `Agent`, `@tool`, `Tool`, `FilesystemMemoryStore`, and `OpenAiCompatLlmClient`.

## Key Constraints
- ES modules throughout (`"type": "module"` in package.json)
- Node.js >= 20.0.0 required
- Strict TypeScript mode
- `@sinclair/typebox` is used for all tool input schemas — do not use plain JSON Schema objects
- Nothing non-test under `src/core/` may import `node:*`; the `test:lint-core` script enforces this (test files are excluded from the check).
