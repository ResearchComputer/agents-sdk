# API Reference

Complete API documentation for `@researchcomputer/agents-sdk`.

## Table of Contents

- [Package entry points](#package-entry-points)
- [Factory](#factory)
  - [`createAgent(config)`](#createagentconfig)
  - [`AgentConfig`](#agentconfig)
  - [`Agent`](#agent)
- [Core factory](#core-factory)
  - [`createAgentCore(config, adapters)`](#createagentcoreconfig-adapters)
  - [`CoreAdapters`](#coreadapters)
  - [`AgentCoreConfig`](#agentcoreconfig)
- [Authentication](#authentication)
  - [`initiateLogin(options?)`](#initiateloginoptions)
  - [`exchangeToken(token, tokenType)`](#exchangetokentoken-tokentype)
  - [`getSession()`](#getsession)
  - [`logout()`](#logout)
  - [`Session`](#session)
- [Types](#types)
  - [Core Types](#core-types)
  - [Permission Types](#permission-types)
  - [Memory Types](#memory-types)
  - [Session Types](#session-types)
  - [MCP Types](#mcp-types)
  - [Hook Types](#hook-types)
  - [Context Types](#context-types)
- [Managers](#managers)
  - [`MemoryManager`](#memorymanager)
  - [`SessionManager`](#sessionmanager)
  - [`McpManager`](#mcpmanager)
  - [`SwarmManager`](#swarmmanager)
  - [`CostTracker`](#costtracker)
- [Adapter Interfaces](#adapter-interfaces)
  - [`LlmClient`](#llmclient)
  - [`MemoryStore`](#memorystore)
  - [`SessionStore`](#sessionstore)
  - [`TelemetryCollector`](#telemetrycollector)
  - [`TelemetrySink`](#telemetrysink)
  - [`AuthTokenResolver`](#authtokenresolver)
- [Tool Factories](#tool-factories)
- [Skills Utilities](#skills-utilities)
- [Context Utilities](#context-utilities)
- [Middleware Utilities](#middleware-utilities)
- [MCP Utilities](#mcp-utilities)
- [Swarm Utilities](#swarm-utilities)
- [Observability Utilities](#observability-utilities)
- [Spec Utilities](#spec-utilities)
- [Trajectory](#trajectory)
- [Error Classes](#error-classes)
- [Exports Summary](#exports-summary)

---

## Package entry points

The package exposes two entry points:

| Import | What you get | Use when |
|---|---|---|
| `@researchcomputer/agents-sdk` | Node.js factory (`createAgent`), built-in tools, MCP manager, hosted auth. Re-exports everything from `./core`. | Running agents on Node.js — the common case. |
| `@researchcomputer/agents-sdk/core` | Language-agnostic core: `createAgentCore`, adapter interfaces, types, context utilities, middleware, permissions, memory retrieval, swarm. **No `node:*` imports.** | Embedding the runtime in a non-Node host (WASM, browser sandbox, deterministic replay). See [`examples/python-stub/`](../examples/python-stub). |

---

## Factory

### `createAgent(config)`

The main factory function. Creates and initializes a fully configured `Agent`.

```typescript
function createAgent(config: AgentConfig): Promise<Agent>
```

### `AgentConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | `Model<any>` | **required** | LLM model instance from `@researchcomputer/ai-provider` |
| `systemPrompt` | `string` | built-in | Custom system prompt; replaces the default |
| `tools` | `SdkTool[]` | all built-in | Tools available to the agent |
| `permissionMode` | `PermissionMode` | `'default'` | `'default'` \| `'allowAll'` \| `'rulesOnly'` |
| `permissionRules` | `PermissionRule[]` | `[]` | Explicit allow/deny rules |
| `onPermissionAsk` | `(toolName, args) => Promise<boolean>` | deny | Called when a tool needs interactive approval |
| `mcpServers` | `McpServerConfig[]` | `[]` | MCP servers to connect on startup |
| `maxContextTokens` | `number` | 80% of model context window | Token budget for context compression |
| `compressionStrategy` | `'truncate' \| 'summarize'` | `'truncate'` | How to handle context overflow |
| `memoryDir` | `string` | `~/.rc-agents/memory` | Directory for memory files |
| `enableMemory` | `boolean` | `true` | Load/save memories from `memoryDir` |
| `sessionDir` | `string` | `~/.rc-agents/sessions` | Directory for session snapshots |
| `sessionId` | `string` | — | Resume an existing session by ID |
| `hooks` | `HookHandler[]` | `[]` | Lifecycle and tool hooks |
| `skills` | `ResolvedSkill[]` | `[]` | Skills that contribute tools, hooks, MCP servers, permission rules, and prompt sections |
| `enableSwarm` | `boolean` | `false` | Enable multi-agent swarm capabilities |
| `thinkingLevel` | `ThinkingLevel` | `'off'` | Reasoning depth hint |
| `toolExecution` | `'sequential' \| 'parallel'` | `'parallel'` | Tool execution order |
| `getApiKey` | `(provider) => Promise<string \| undefined>` | resolved auth token | Custom provider API key resolver; if omitted, the SDK falls back to hosted auth token resolution |
| `cwd` | `string` | `process.cwd()` | Working directory for file tools |
| `onQuestion` | `(question) => Promise<string>` | — | Handler for `AskUser` tool |
| `autoFork` | `AutoForkConfig` | — | Automatically fork N branches after each LLM turn |
| `streamFn` | `StreamFn` | — | Custom stream function for proxy backends and testing |
| `authToken` | `string` | — | Explicit hosted/proxy auth token; highest-priority auth source |
| `telemetry` | `TelemetryConfig \| false` | resolved from file/env | Telemetry endpoint + API key. Pass `false` to opt out; skips collection and sidecar writes |
| `memoryResumeStrategy` | `'pin' \| 'refresh'` | `'pin'` | On resume, reuse the memory selection saved in the snapshot (`pin`, reproducible) or re-run `retrieve()` against the current memory store (`refresh`, picks up changes) |
| `redactArgs` | `(toolName, args) => unknown` | passthrough | Optional redactor applied to tool `args` before they're written to `tool_call` and `permission_decision` trajectory events. The in-memory `PermissionDecision` log is NOT redacted — only the disk representation. Use with [`createKeyRedactor`](#createkeyredactorkeys-options) or a custom function |
| `redactMessages` | `(messages: AgentMessage[]) => AgentMessage[]` | passthrough | Optional redactor applied to message arrays before they're written to `llm_api_call.request_messages` and `agent_message.content` trajectory events and before upload. Use with [`createContentRedactor`](#createcontentredactoroptions) for opt-in secret-pattern scanning, or supply your own function. A throwing redactor falls back to the raw messages with a `redact_messages_failed` warning |

### `TelemetryConfig`

```typescript
interface TelemetryConfig {
  endpoint?: string;          // ingest URL; falls back to ~/.rc-agents/telemetry.json, then env
  apiKey?: string;            // tenant API key; same fallback chain
  captureTrajectory?: boolean; // include trajectory pointers in upload payload; default true
}
```

**`captureTrajectory`**: when `false`, the uploader strips `trajectoryId` and `lastEventId` from the POST body so the ingest worker cannot fetch or link the sidecar. The **local `.trajectory.jsonl` file is unaffected** — it continues to be written for local debugging. Only the wire representation changes.

### Privacy: what gets written and uploaded

| Surface | Controlled by | Default |
|---|---|---|
| Tool args in `tool_call` / `permission_decision` JSONL | `redactArgs` | passthrough |
| LLM request messages in `llm_api_call` JSONL | `redactMessages` | passthrough |
| Assistant / user content in `agent_message` JSONL | `redactMessages` | passthrough |
| In-memory `PermissionDecision` log | not redacted | raw args preserved for audit callbacks |
| Upload body trajectory pointers | `captureTrajectory` | included |
| Local `.trajectory.jsonl` sidecar | always written | (captureTrajectory does not apply) |

As of `src/core/factory.ts` the `request_messages` captured in `llm_api_call` is the snapshot **as of `message_start`** — i.e., the exact input sent to the LLM for that turn, excluding the assistant's own reply. This avoids O(n²) growth on long sessions and prevents the uploader's 5 MB guard from silently dropping sessions.

### `AutoForkConfig`

```typescript
interface AutoForkConfig {
  branches: number;
  onBranches: (agents: Agent[]) => void | Promise<void>;
}
```

### `Agent`

```typescript
interface Agent {
  agent: Agent;
  mcp: McpManager;
  sessions: SessionManager;
  memory: MemoryManager;
  swarm?: SwarmManager;
  costTracker: CostTracker;

  prompt(message: string, images?: ImageContent[]): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): AgentSnapshot;
  restore(snapshot: AgentSnapshot): void;
  fork(message: string, n: number): Promise<Agent[]>;
  forkFrom(snapshot: AgentSnapshot, message: string, n: number): Promise<Agent[]>;
  promptFork(message: string, n: number): Promise<Agent[]>;
}
```

**`prompt(message, images?)`** — Send a message to the agent. Waits until the agent reaches `end_turn` (including all tool calls).

**`dispose()`** — Save the session, run `SessionEnd` hooks, disconnect MCP servers, and clean up swarm resources. Always call this when done.

**`snapshot()`** — Capture the current conversation state as an `AgentSnapshot`. Throws if the agent is currently streaming.

**`restore(snapshot)`** — Replace the agent's conversation history with a previous snapshot. Throws if the agent is currently streaming.

**`fork(message, n)`** — Spawn N independent child agents from the current conversation state, each prompted with `message`. Children run in parallel and are returned once all complete. For OpenAI-compatible models, this is optimized to use the native `n` parameter, saving input tokens.

**`forkFrom(snapshot, message, n)`** — Like `fork`, but starts from a previously captured snapshot instead of the current state.

**`promptFork(message, n)`** — Alias for `fork`.

---

## Core factory

> *For a walkthrough of the non-Node embedding path, see [Embedding the Core](./embedding-core.md). For the WASM ABI contract, see [`docs/spec/wasm.md`](./spec/wasm.md).*

The language-agnostic factory. Use this when you are building a non-Node host (WASM, browser sandbox, custom runtime). Import from `@researchcomputer/agents-sdk/core`.

### `createAgentCore(config, adapters)`

```typescript
function createAgentCore(
  config: AgentCoreConfig,
  adapters: CoreAdapters,
): Promise<Agent>
```

Builds a `Agent` using the provided adapters. Returns the same `Agent` interface as `createAgent()`. Differs from `createAgent()` in that:

- It never touches the filesystem, spawns processes, or imports `@researchcomputer/ai-provider` at runtime.
- It requires you to pass every integration point via `CoreAdapters`.
- It requires `config.cwd` to be set (no `process.cwd()` fallback).
- It expects a pre-computed `systemPromptHash` (the Node factory hashes via `node:crypto`; other hosts use Web Crypto or equivalent).

### `CoreAdapters`

```typescript
interface CoreAdapters {
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  telemetryCollector: TelemetryCollector;
  telemetrySink: TelemetrySink;
  mcpManager: McpManager;
  authTokenResolver: AuthTokenResolver;
  llmClient: LlmClient;
  telemetryOptOut?: boolean;
}
```

See [Adapter Interfaces](#adapter-interfaces) for each interface definition.

### `AgentCoreConfig`

```typescript
interface AgentCoreConfig extends Omit<AgentConfig, 'memoryDir' | 'sessionDir' | 'telemetry'> {
  systemPromptHash: string;   // pre-computed by the host
}
```

`memoryDir` / `sessionDir` / `telemetry` are absent because those are host concerns that the adapters have already captured.

---

## Authentication

### `initiateLogin(options?)`

Opens a browser-based login flow, exchanges the returned Stytch token at `RC_LLM_PROXY_URL`, and stores the resulting session in `~/.rc-agents/auth.json`.

```typescript
function initiateLogin(options?: { port?: number }): Promise<Session>
```

Requirements:

- `STYTCH_PUBLIC_TOKEN`
- `RC_LLM_PROXY_URL`

Notes:

- The callback listener binds to `127.0.0.1` on the provided port, or an ephemeral port when omitted.
- Supported Stytch token types are `magic_links` and `oauth`.

### `exchangeToken(token, tokenType)`

Exchanges a Stytch token for a session and saves it locally.

```typescript
function exchangeToken(token: string, tokenType: string): Promise<Session>
```

Throws `SdkError` with:

- `CONFIG_MISSING` when `RC_LLM_PROXY_URL` is unset
- `UNSUPPORTED_TOKEN_TYPE` for unsupported token types
- `AUTH_EXCHANGE_FAILED` when the proxy returns a non-2xx response

### `getSession()`

Reads `~/.rc-agents/auth.json`. If the JWT is within 60 seconds of expiry, it attempts to refresh via `RC_LLM_PROXY_URL/auth/stytch/refresh`.

```typescript
function getSession(): Promise<Session | null>
```

Behavior:

- Returns the stored session immediately when the JWT still has at least 60 seconds remaining.
- Returns `null` when no local session exists or the proxy definitively rejects refresh with `401` or `403`.
- Falls back to the still-valid stored JWT on transient refresh failures such as network errors or `5xx` responses.

### `logout()`

Best-effort logout for the hosted auth flow.

```typescript
function logout(): Promise<void>
```

Behavior:

- Reads the stored `sessionToken` from `~/.rc-agents/auth.json`
- Best-effort POSTs it to `RC_LLM_PROXY_URL/auth/stytch/revoke`
- Deletes `~/.rc-agents/auth.json` even if revoke fails

### `Session`

```typescript
interface Session {
  sessionJwt: string;
  sessionToken: string;
  jwtExpiresAt: number;
  email: string;
}
```

`createAgent()` resolves hosted auth in this order when `getApiKey` is not provided:

1. `config.authToken`
2. `RC_AUTH_TOKEN`
3. `getSession()`
4. `config.telemetry.apiKey` (legacy)
5. `RC_TELEMETRY_API_KEY` (legacy)

If no auth source is found, it throws `AuthRequiredError`.

---

## Types

### Core Types

#### `SdkTool`

```typescript
interface SdkTool<TParameters extends TSchema = TSchema, TDetails = any>
  extends AgentTool<TParameters, TDetails> {
  capabilities: Capability[];
  permissionCheck?: (params: Static<TParameters>, rules: PermissionRule[]) => PermissionResult;
}
```

#### `Capability`

```typescript
type Capability =
  | 'fs:read'
  | 'fs:write'
  | 'process:spawn'
  | 'network:egress'
  | 'git:mutate'
  | 'mcp:call';
```

### Permission Types

#### `PermissionMode`

```typescript
type PermissionMode = 'default' | 'allowAll' | 'rulesOnly';
```

#### `PermissionResult`

```typescript
type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; prompt: string };
```

#### `PermissionRule`

```typescript
interface PermissionRule {
  target: PermissionTarget;
  behavior: 'allow' | 'deny';
  source: 'user' | 'project' | 'session';
}

type PermissionTarget =
  | { type: 'tool'; name: string; pattern?: string }
  | { type: 'capability'; capability: Capability }
  | { type: 'mcp'; server: string; tool?: string }
  | { type: 'all' };
```

#### `PermissionDecision`

```typescript
interface PermissionDecision {
  toolName: string;
  args: unknown;
  behavior: 'allow' | 'deny';
  matchedRule?: PermissionRule;
  normalizedTarget: string;
  timestamp: number;
}
```

### Context Types

#### `RunContext`

Created internally by the factory and passed to every tool and middleware.

```typescript
interface RunContext {
  sessionId: string;
  traceId: string;
  cwd: string;
  signal: AbortSignal;
  costTracker: CostTracker;
  permissionDecisions: PermissionDecision[];
}
```

#### `AgentSnapshot`

```typescript
interface AgentSnapshot {
  id: string;          // UUID for logging and tracing
  messages: AgentMessage[];
  createdAt: number;
}
```

### Skill Types

#### `ResolvedSkill`

```typescript
interface ResolvedSkill {
  id: string;
  description?: string;
  promptSections?: string[];
  tools?: SdkTool<any, any>[];
  mcpServers?: McpServerConfig[];
  hooks?: HookHandler[];
  permissionRules?: PermissionRule[];
  metadata?: Record<string, string>;
}
```

### Memory Types

#### `Memory`

```typescript
interface Memory {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  content: string;
}
```

#### `MemorySelection`

```typescript
interface MemorySelection {
  memory: Memory;
  relevanceScore: number;
  source: string;
  updatedAt: number;
}
```

### Session Types

#### `SessionSnapshot`

```typescript
interface SessionSnapshot {
  version: 1;
  id: string;
  messages: AgentMessage[];
  modelId: string;
  providerName: string;
  systemPromptHash: string;
  memoryRefs: string[];
  compactionState?: {
    lastCompactedIndex: number;
    summary?: string;
  };
  createdAt: number;
  updatedAt: number;
}
```

### MCP Types

#### `McpServerConfig`

```typescript
interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse / http
  url?: string;
  headers?: Record<string, string>;
  trustLevel?: 'trusted' | 'untrusted';
}
```

#### `McpConnection`

```typescript
interface McpConnection {
  name: string;
  config: McpServerConfig;
  close(): Promise<void>;
}
```

### Hook Types

#### `HookHandler`

```typescript
interface HookHandler {
  event: HookEvent;
  matcher?: string;  // Tool name pattern (regex); ignored for lifecycle events
  handler: (context: HookContext) => Promise<HookResult | void>;
}

type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact';

interface HookContext {
  event: HookEvent;
  runContext: RunContext;
  toolCallId?: string;                  // Set for PreToolUse / PostToolUse
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: AgentToolResult<any>;
  agentName?: string;                   // Set for SubagentStart / SubagentStop
  messages?: AgentMessage[];
  /** True when this HookContext is built during a session-resume flow.
   *  Set on SessionStart; undefined on fresh sessions. */
  resumed?: boolean;
  /** tool_call_ids that were interrupted (no tool_result) before resume.
   *  Populated by the resume path alongside the synthetic close-out
   *  messages it injects, so SessionStart hooks can observe what was
   *  recovered. */
  interruptedToolCallIds?: string[];
}

interface HookResult {
  updatedArgs?: unknown;              // PreToolUse: override tool arguments
  updatedResult?: AgentToolResult<any>;  // PostToolUse: override tool result
}
```

---

## Managers

### `MemoryManager`

```typescript
interface MemoryManager {
  load(dir: string): Promise<Memory[]>;
  save(dir: string, memory: Memory): Promise<void>;
  remove(dir: string, name: string): Promise<void>;
  retrieve(memories: Memory[], context: { query: string; maxItems?: number; maxTokens?: number }): MemorySelection[];
}
```

Returned as `agent.memory`. `retrieve()` scores memories by keyword overlap with the query and returns the top results within the token budget.

### `SessionManager`

```typescript
interface SessionManager {
  save(snapshot: SessionSnapshot): Promise<void>;
  load(id: string): Promise<SessionSnapshot | null>;
  list(): Promise<{ id: string; updatedAt: number }[]>;
}
```

Returned as `agent.sessions`.

### `McpManager`

```typescript
interface McpManager {
  connect(config: McpServerConfig): Promise<McpConnection>;
  disconnect(serverName: string): Promise<void>;
  getTools(): SdkTool[];
  getConnections(): McpConnection[];
}
```

Returned as `agent.mcp`. MCP servers are connected during factory initialization; you can also connect/disconnect at runtime.

### `SwarmManager`

```typescript
interface SwarmManager {
  createTeam(config: TeamConfig): Team;
  spawnTeammate(teamName: string, config: TeammateConfig): Promise<TeamAgent>;
  sendMessage(from: string, to: string, message: AgentMessage): void;
  removeTeammate(teamName: string, name: string): Promise<void>;
  destroyTeam(teamName: string): Promise<void>;
  getTeam(name: string): Team | undefined;
}
```

Returned as `agent.swarm` when `enableSwarm: true`.

### `CostTracker`

```typescript
interface CostTracker {
  record(usage: Usage, modelId?: string): void;
  total(): { tokens: number; cost: number };
  perModel(): Map<string, { tokens: number; cost: number }>;
}
```

Returned as `agent.costTracker`.

---

## Adapter Interfaces

> *Walkthroughs and minimal reference implementations for every adapter live in [Embedding the Core](./embedding-core.md#implementing-coreadapters).*

These interfaces live in `@researchcomputer/agents-sdk/core`. The Node entry point supplies default implementations; non-Node hosts implement them directly and pass them to `createAgentCore()` via `CoreAdapters`.

### `LlmClient`

```typescript
interface LlmClient {
  stream: StreamFn;   // matches pi-agent-core's StreamFn shape
  completeN(
    model: Model<any>,
    context: Context,
    n: number,
    options?: ProviderStreamOptions,
  ): Promise<AssistantMessage[]>;
}
```

The only runtime seam between core and the LLM transport. Node's default is `createAiProviderLlmClient()` (from `@researchcomputer/agents-sdk`), which delegates to `@researchcomputer/ai-provider`. Hosts that cannot run ai-provider (WASM, Python embedding, deterministic replay) supply their own.

`completeN()` is used by `fork(..., n)` best-of-N. Providers with native `n>1` (OpenAI) answer in one request; others fan out to parallel `stream()` calls internally.

### `MemoryStore`

```typescript
interface MemoryStore {
  load(): Promise<Memory[]>;
  save(memory: Memory): Promise<void>;
  remove(name: string): Promise<void>;
}
```

Persistence layer for memories. The pure relevance-scoring `retrieve()` function operates on an already-loaded `Memory[]` and does not touch the store. Node's default reads/writes Markdown files with YAML frontmatter under `memoryDir`.

### `SessionStore`

```typescript
interface SessionStore {
  load(id: string): Promise<SessionSnapshot | null>;
  save(snapshot: SessionSnapshot): Promise<void>;
  list(): Promise<{ id: string; updatedAt: number }[]>;
}
```

Node's default writes JSON files under `sessionDir`, using an atomic tmp-and-rename strategy.

### `TelemetryCollector`

```typescript
interface TelemetryCollector {
  onLlmCall(record: LlmCallRecord): void;
  onToolEvent(record: ToolEventRecord): void;
  finalize(): SessionTelemetry;
}

function createTelemetryCollector(options: { optOut: boolean }): TelemetryCollector;
```

In-memory aggregator for per-session LLM calls and tool events. `finalize()` returns a `SessionTelemetry` that can be attached to the session snapshot.

### `TelemetrySink`

```typescript
interface TelemetrySink {
  flush(snapshot: SessionSnapshot): Promise<void>;
}
```

Called during `dispose()` after `SessionEnd` hooks. Node's default writes a `telemetry.jsonl` sidecar and, when `endpoint` + `apiKey` are configured, best-effort uploads the payload.

### `AuthTokenResolver`

```typescript
interface AuthTokenResolver {
  resolve(): Promise<string>;
}
```

Produces a bearer token when `getApiKey` is not supplied. Node's default resolves via `authToken` → `RC_AUTH_TOKEN` → `~/.rc-agents/auth.json` → legacy telemetry keys.

### `createAiProviderLlmClient()`

```typescript
function createAiProviderLlmClient(): LlmClient
```

Exported from `@researchcomputer/agents-sdk` (Node-only). The default `LlmClient` that delegates to `@researchcomputer/ai-provider`. Used by `createAgent()` when no custom client is provided.

---

## Tool Factories

All built-in tools are created via factory functions that accept a shared options object.

```typescript
interface ToolOptions {
  cwd?: string;
  allowedRoots?: string[];
}
```

| Factory | Signature | Description |
|---|---|---|
| `createReadTool` | `(options: ToolOptions) => SdkTool` | Read files with line numbers |
| `createWriteTool` | `(options: ToolOptions) => SdkTool` | Write/create files |
| `createEditTool` | `(options: ToolOptions) => SdkTool` | String replacement in files |
| `createGlobTool` | `(options: ToolOptions) => SdkTool` | File pattern matching |
| `createGrepTool` | `(options: ToolOptions) => SdkTool` | Content search with ripgrep |
| `createBashTool` | `(options: ToolOptions) => SdkTool` | Shell command execution |
| `createWebFetchTool` | `(options: ToolOptions) => SdkTool` | Fetch URL content |
| `createWebSearchTool` | `(options: ToolOptions) => SdkTool` | Web search |
| `createNotebookEditTool` | `(options: ToolOptions) => SdkTool` | Edit Jupyter notebook cells |
| `createAskUserTool` | `(options: ToolOptions) => SdkTool` | Interactive user prompts |
| `getAllTools` | `(options: ToolOptions) => SdkTool[]` | Returns all built-in tools |

---

## Skills Utilities

### `composeAgentConfig(config, options?)`

```typescript
function composeAgentConfig(
  config: AgentConfig,
  options?: { defaultTools?: SdkTool[] },
): ComposedAgentConfig
```

Merges skill-contributed tools, hooks, MCP servers, and permission rules into the base config. Skill tools override defaults by name. Returns a `ComposedAgentConfig` with resolved `tools`, `hooks`, `mcpServers`, `permissionRules`, and `skills` arrays.

---

## Context Utilities

### `createRunContext(options)`

```typescript
function createRunContext(options: {
  cwd: string;
  sessionId?: string;
}): RunContext
```

Creates a `RunContext`. Used internally by the factory; you typically don't call this directly.

### `buildSystemPrompt(options)`

```typescript
function buildSystemPrompt(options: {
  basePrompt?: string;
  skills?: ResolvedSkill[];
  tools?: SdkTool[];
  memories?: MemorySelection[];
  permissionMode?: PermissionMode;
  swarmContext?: { teammates: string[]; instructions?: string };
}): string
```

Assembles the system prompt. Sections are added in this order:

1. Base prompt
2. Skill instructions (from `ResolvedSkill.promptSections`)
3. Tool descriptions
4. Memory context
5. Memory instructions
6. Permission context
7. Swarm context

### `convertToLlm(messages)`

```typescript
function convertToLlm(messages: AgentMessage[]): Message[]
```

Converts SDK-internal `AgentMessage[]` to the LLM provider's `Message[]` format.

### `createCompressionMiddleware(options)`

```typescript
function createCompressionMiddleware(options: {
  maxTokens: number;
  strategy: 'truncate' | 'summarize';
  model?: Model<any>;
  protectedRecentTurns?: number;  // default: 3
}): Middleware
```

Creates middleware that handles context window overflow by truncating or summarizing older messages.

### `estimateTokens(text)`

```typescript
function estimateTokens(text: string): number
```

Estimates token count using a simple heuristic (`ceil(chars / 4)`).

---

## Middleware Utilities

### `createPermissionMiddleware(options)`

```typescript
function createPermissionMiddleware(options: {
  mode: PermissionMode;
  rules: PermissionRule[];
  tools: SdkTool[];
  runContext: RunContext;
  onAsk?: (toolName: string, args: unknown) => Promise<boolean>;
}): Middleware
```

Creates the permission checking middleware that runs before tool execution.

### `composePipeline(config)`

```typescript
function composePipeline(config: {
  hooks: HookHandler[];
  permissionGate: Middleware;
  runContext: RunContext;
}): Pipeline
```

Returns a `Pipeline` with `beforeToolCall` and `afterToolCall` functions. The factory uses this to compose hooks + permission gate.

### `matchRule(rule, toolName, capabilities)`

Checks if a permission rule matches a tool.

### `findMatchingRule(rules, toolName, capabilities)`

Finds the most specific matching rule from a list.

### `evaluatePermission(tool, args, rules, mode, onAsk)`

Evaluates the complete permission check flow.

### Hook Runners

- `runPreToolUseHooks(hooks, context)` — Run PreToolUse hooks sequentially
- `runPostToolUseHooks(hooks, context)` — Run PostToolUse hooks sequentially
- `runLifecycleHooks(hooks, event, runContext)` — Run lifecycle hooks

---

## MCP Utilities

### `createMcpManager()`

```typescript
function createMcpManager(): McpManager
```

Creates a new MCP manager instance.

### `wrapMcpTool(serverName, mcpTool, client)`

```typescript
function wrapMcpTool(serverName: string, mcpTool: McpTool, client: McpClient): SdkTool
```

Wraps a raw MCP tool definition as an `SdkTool`. The tool name is set to `mcp__<serverName>__<mcpTool.name>`.

### `jsonSchemaToTypeBox(schema)`

```typescript
function jsonSchemaToTypeBox(schema: JSONSchema): {
  schema: TSchema;
  isExact: boolean;
  warnings: string[];
}
```

Converts a JSON Schema object (as returned by MCP) into a TypeBox schema for use in `SdkTool.inputSchema`. `isExact` is `false` if the conversion had to approximate (e.g., unsupported `$ref`). Warnings list any constructs that could not be precisely converted.

---

## Swarm Utilities

### `createSwarmManager(options)`

```typescript
function createSwarmManager(options: {
  model: Model<any>;
  tools: SdkTool[];
  convertToLlm: (messages: AgentMessage[]) => Message[];
  getApiKey?: (provider: string) => Promise<string | undefined>;
  beforeToolCall?: (...args: any[]) => any;
  afterToolCall?: (...args: any[]) => any;
  transformContext?: (...args: any[]) => any;
}): SwarmManager
```

Creates a swarm manager for multi-agent coordination.

### `createSwarmTools(teamName, swarmManager)`

```typescript
function createSwarmTools(teamName: string, swarmManager: SwarmManager): SdkTool[]
```

Returns the `SpawnTeammate`, `SendMessage`, and `DismissTeammate` tools for the given team. These are automatically added when `enableSwarm: true`.

### `runSubAgent(prompt, config)`

```typescript
function runSubAgent(prompt: string, config: SubAgentConfig): Promise<string>

interface SubAgentConfig {
  model: Model<any>;
  systemPrompt?: string;
  tools?: SdkTool<any, any>[];
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  streamFn?: StreamFn;
}
```

One-shot sub-agent execution. Creates an `Agent`, sends `prompt`, waits for it to reach idle, and returns the last assistant text response as a string.

### `AsyncQueue<T>`

```typescript
class AsyncQueue<T> {
  enqueue(item: T): void;
  dequeue(): Promise<T>;
  tryDequeue(): T | undefined;
  isEmpty(): boolean;
  clear(): void;
}
```

Simple async FIFO queue used for inter-agent mailboxes in the swarm. You can use this in your own multi-agent implementations.

---

## Observability Utilities

### `createCostTracker()`

```typescript
function createCostTracker(): CostTracker
```

Creates a new cost tracker instance.

### `generateTraceId()`

```typescript
function generateTraceId(): string
```

Generates a unique trace ID for correlating logs across a session.

---

## Spec Utilities

Primitives for ID generation and runtime validation used across the SDK. Exported from both entry points.

### `newUlid()` / `isUlid(value)` / `nowIso()`

```typescript
function newUlid(): string;          // 26-char Crockford Base32 ULID
function isUlid(value: string): boolean;
function nowIso(): string;           // ISO-8601 timestamp
```

### `createValidator(schemaName)`

```typescript
function createValidator(schemaName: string): Validator

interface Validator {
  validate<T>(data: unknown): ValidationResult<T>;
}

interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  errors?: string[];
}
```

Returns a validator for a named schema. Uses Ajv internally.

### `SpecError`

Thrown on validation failures. Has a `code: SpecErrorCode` field.

---

## Trajectory

Every `Agent` session writes an append-only JSONL log of `TrajectoryEvent`s alongside the session snapshot. The trajectory is the source of truth for message history, permission decisions, tool calls/results, and LLM API calls. Messages are reconstructed by replaying the trajectory up to `lastEventId` on resume.

The Node factory wires a filesystem-backed writer by default. Non-Node hosts (WASM, browser sandbox) supply their own via `CoreAdapters.createTrajectoryWriter`; if they skip it, the core factory falls back to an in-memory writer so every run produces a valid v2 snapshot.

### `TrajectoryEvent`

```typescript
type TrajectoryEventType =
  | 'session_start' | 'session_end'
  | 'llm_api_call' | 'llm_turn'
  | 'agent_message'
  | 'tool_call' | 'tool_result'
  | 'hook_fire'
  | 'permission_decision'
  | 'compaction' | 'error';

interface TrajectoryEvent {
  schema_version: '1';
  trajectory_id: string;
  event_id: string;
  parent_event_id: string | null;
  event_type: TrajectoryEventType;
  timestamp: string;        // ISO-8601 UTC
  agent_id: string;         // 'leader' or 'teammate:<name>'
  payload: Record<string, unknown>;
  ext?: Record<string, unknown>;
}
```

Events match [`docs/spec/schemas/trajectory-event.v1.schema.json`](./spec/schemas/trajectory-event.v1.schema.json) field-for-field.

### `TrajectoryWriter`

```typescript
interface TrajectoryWriter {
  readonly trajectoryId: string;
  append(input: AppendInput): string;             // returns event_id
  flush(): Promise<void>;
  currentEventId(): string | null;
  close(): Promise<void>;
  events(): TrajectoryEvent[];
  read(options?: ReadOptions): AsyncIterable<TrajectoryEvent>;
}

interface AppendInput {
  event_type: TrajectoryEventType;
  payload: Record<string, unknown>;
  parent_event_id?: string | null;  // default: previous event_id (or null if first)
  agent_id?: string;                 // default: 'leader'
  ext?: Record<string, unknown>;
}

interface ReadOptions {
  sinceEventId?: string;  // skip events up to and including this event_id
}
```

IDs (`event_id`, `trajectory_id`) are 26-char Crockford Base32 ULIDs generated by the writer; callers only supply the payload-level information.

### `createInMemoryTrajectoryWriter(options?)`

Core export. In-process writer with no filesystem dependency. Used as the default when `CoreAdapters.createTrajectoryWriter` is absent, and in tests.

```typescript
interface InMemoryTrajectoryWriterOptions {
  trajectoryId?: string;  // override the generated ULID (for resume)
}

function createInMemoryTrajectoryWriter(
  options?: InMemoryTrajectoryWriterOptions,
): TrajectoryWriter
```

### `createNodeTrajectoryWriter(options)`

Node-only. Filesystem-backed writer that flushes JSONL appends to `<dir>/<trajectoryId>.trajectory.jsonl`. Single-writer — concurrent processes are not coordinated.

```typescript
interface NodeTrajectoryWriterOptions {
  dir: string;
  trajectoryId?: string;  // override the generated ULID (for resume)
}

function createNodeTrajectoryWriter(
  options: NodeTrajectoryWriterOptions,
): TrajectoryWriter
```

### `readNodeTrajectoryFile(dir, trajectoryId)`

Node-only. Loads the `.trajectory.jsonl` file for a given trajectory id into memory as a `TrajectoryEvent[]`. Wired into `CoreAdapters.readTrajectoryFromStorage` by the Node factory.

```typescript
function readNodeTrajectoryFile(
  dir: string,
  trajectoryId: string,
): Promise<TrajectoryEvent[]>
```

### `replayTrajectory(events)`

Deterministic reconstruction of runtime state from a trajectory. Same input produces the same output, suitable for rehydrating a freshly-built `RunContext` on resume.

```typescript
interface ReplayResult {
  messages: AgentMessage[];
  permissionDecisions: PermissionDecision[];
  interruptedToolCallIds: string[];
  interruptedToolCalls: InterruptedToolCall[];
  llmApiCallCount: number;
}

interface InterruptedToolCall {
  toolCallId: string;
  toolName: string;
  parentEventId: string;  // event_id of the originating tool_call
}

function replayTrajectory(events: Iterable<TrajectoryEvent>): ReplayResult
```

Non-replayable state (cost totals, selected memories, cwd, swarm state) lives in `SessionSnapshot.contextState`, not the trajectory.

### `createKeyRedactor(keys, options?)`

Builds a `RedactArgsFn` that walks a tool-args value recursively and replaces properties whose keys match `keys` with a replacement sentinel. Used to scrub secrets from `tool_call` and `permission_decision` payloads before they're written to the trajectory.

```typescript
type RedactArgsFn = (toolName: string, args: unknown) => unknown;

interface KeyRedactorOptions {
  caseInsensitive?: boolean;        // default false
  toolFilter?: (toolName: string) => boolean;  // no-op when returns false
  replacement?: string;             // default '[redacted]'
}

function createKeyRedactor(
  keys: string[],
  options?: KeyRedactorOptions,
): RedactArgsFn
```

Deliberately simple — the SDK does not ship a secret scanner or value-based heuristics. Callers declare the allowlist of field names to scrub.

Wire it in via `AgentConfig.redactArgs` (Node factory) or `CoreAdapters.redactArgs` (core factory).

### `createContentRedactor(options?)`

Builds a `RedactMessagesFn` that scans text content in each `AgentMessage` and replaces well-known secret patterns with a sentinel. Used to scrub secrets from `llm_api_call.request_messages` and `agent_message.content` payloads in the trajectory (and from the upload body).

```typescript
type RedactMessagesFn = (messages: AgentMessage[]) => AgentMessage[];

interface ContentRedactorOptions {
  replacement?: string;      // default '[redacted]'
  extraPatterns?: RegExp[];  // additional caller-supplied patterns
}

function createContentRedactor(
  options?: ContentRedactorOptions,
): RedactMessagesFn
```

Built-in patterns:
- AWS access key IDs: `AKIA[A-Z0-9]{16}`
- OpenAI-style keys: `sk-[A-Za-z0-9]{20,}`
- JWT-shaped tokens: three base64url segments separated by dots

Opt-in only — the factory never enables content scanning by default. This is a best-effort pattern match, **not a DLP solution**. Combine with `createKeyRedactor` (for tool args) to cover both surfaces.

Wire it in via `AgentConfig.redactMessages` (Node factory) or `CoreAdapters.redactMessages` (core factory).

---

## Error Classes

All errors extend `SdkError`:

```typescript
class SdkError extends Error {
  code: string;
  retryable: boolean;
}
```

| Class | `code` | `retryable` | When thrown |
|---|---|---|---|
| `ToolExecutionError` | `TOOL_EXECUTION_ERROR` | `true` | Tool `execute()` throws |
| `PermissionDeniedError` | `PERMISSION_DENIED` | `false` | Tool call blocked by permission system |
| `BudgetExhaustedError` | `BUDGET_EXHAUSTED` | `false` | Token or turn budget exceeded |
| `McpConnectionError` | `MCP_CONNECTION_ERROR` | `true` | MCP server unavailable |
| `SessionLoadError` | `SESSION_LOAD_ERROR` | `false` | Session file missing or corrupt |
| `CompressionError` | `COMPRESSION_ERROR` | `true` | Context compression failed |
| `AuthRequiredError` | `AUTH_REQUIRED` | `false` | No `getApiKey` supplied and no auth token could be resolved |

---

## Exports Summary

The following are exported from the package root (`@researchcomputer/agents-sdk`):

### Factory

- `createAgent` — Node factory (from `@researchcomputer/agents-sdk`)
- `createAgentCore` — language-agnostic factory (from `@researchcomputer/agents-sdk/core`)
- `AgentConfig`, `Agent`, `AutoForkConfig`, `TelemetryConfig`
- `AgentCoreConfig`, `CoreAdapters`, `AuthTokenResolver`

### Skills

- `composeAgentConfig`
- `ComposeAgentConfigOptions`, `ComposedAgentConfig`

### Types

**Core:** `Capability`, `SdkTool`, `RunContext`, `AgentSnapshot`

**Permissions:** `PermissionMode`, `PermissionResult`, `PermissionRule`, `PermissionTarget`, `PermissionDecision`

**Memory:** `MemoryType`, `Memory`, `MemorySelection`, `MemoryManager`

**Session:** `SessionSnapshot`, `SessionManager`

**MCP:** `McpServerConfig`, `McpConnection`, `McpManager`

**Swarm:** `TaskBudget`, `TeammateConfig`, `TeamAgent`, `Team`, `TeamConfig`, `SwarmManager`

**Hooks:** `HookEvent`, `HookContext`, `HookResult`, `HookHandler`

**Context:** `MemoryInjectionMessage`, `CompactionSummaryMessage`, `SwarmReportMessage`, `CompressionConfig`, `TranscriptSegment`, `SegmentType`

**Skills:** `ResolvedSkill`

**Tools:** `ToolOptions`, `SchemaConversionResult`, `BashToolOptions`, `AskUserToolOptions`, `GetAllToolsOptions`

**Context Options:** `SystemPromptConfig`, `RunContextOptions`, `PermissionMiddlewareConfig`, `PipelineConfig`, `Pipeline`

### Errors

- `SdkError`, `ToolExecutionError`, `PermissionDeniedError`, `BudgetExhaustedError`, `McpConnectionError`, `SessionLoadError`, `CompressionError`, `AuthRequiredError`

### Tools

- `createReadTool`, `createWriteTool`, `createEditTool`, `createGlobTool`, `createGrepTool`, `createBashTool`, `createWebFetchTool`, `createWebSearchTool`, `createNotebookEditTool`, `createAskUserTool`, `getAllTools`
- `resolvePath`, `isPathAllowed`, `truncateOutput`, `isBinaryContent`

### LLM

- `createAiProviderLlmClient` (Node-only; the default `LlmClient` for `createAgent`)
- `LlmClient` (interface; exported from `./core`)

### Adapters (from `./core`)

- `MemoryStore`, `SessionStore`, `TelemetryCollector`, `TelemetrySink`, `AuthTokenResolver`
- `createTelemetryCollector`

### Spec Utilities

- `newUlid`, `isUlid`, `nowIso`, `createValidator`, `SpecError`
- `Validator`, `ValidationResult`, `SpecErrorCode`

### Context

- `createRunContext`, `convertToLlm`, `buildSystemPrompt`, `createCompressionMiddleware`, `estimateTokens`

### Middleware

- `matchRule`, `findMatchingRule`, `evaluatePermission`, `createPermissionMiddleware`
- `runPreToolUseHooks`, `runPostToolUseHooks`, `runLifecycleHooks`, `composePipeline`

### Memory

- `createNodeMemoryStore` (Node; implements `MemoryStore`)
- `retrieve` (pure scoring function, from `./core`)

### Session

- `createNodeSessionStore` (Node; implements `SessionStore`)

### Trajectory

- `createInMemoryTrajectoryWriter`, `replayTrajectory`, `createKeyRedactor` (from `./core`)
- `createNodeTrajectoryWriter`, `readNodeTrajectoryFile` (Node)
- Types: `TrajectoryWriter`, `TrajectoryEvent`, `TrajectoryEventType`, `AppendInput`, `ReadOptions`, `InMemoryTrajectoryWriterOptions`, `NodeTrajectoryWriterOptions`, `ReplayResult`, `InterruptedToolCall`, `RedactArgsFn`, `KeyRedactorOptions`, `ContextState`

### MCP

- `createMcpManager`, `wrapMcpTool`, `jsonSchemaToTypeBox`
- `McpToolDefinition`, `CallToolFn`

### Swarm

- `createSwarmManager`, `createSwarmTools`, `runSubAgent`, `AsyncQueue`

### Observability

- `createCostTracker`, `generateTraceId`
