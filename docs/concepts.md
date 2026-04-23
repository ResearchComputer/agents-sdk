# Core Concepts

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Tools](#tools)
- [Permission System](#permission-system)
- [Memory](#memory)
- [Session Management](#session-management)
- [Context & Compression](#context--compression)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
- [Swarm (Multi-Agent)](#swarm-multi-agent)
- [Snapshot & Fork](#snapshot--fork)
- [Hooks](#hooks)
- [Observability](#observability)
- [Glossary](#glossary)

---

## Architecture Overview

The SDK is split into two layers:

- **`src/core/`** — language-agnostic runtime. Pure TypeScript with no `node:*` imports; talks to every host service through injected adapters (LLM transport, memory store, session store, MCP manager, telemetry, auth). Published at `@researchcomputer/agents-sdk/core`.
- **`src/node/`** — Node.js host. Supplies the default adapters (filesystem-backed memory/session stores, MCP stdio/SSE/HTTP transports, ai-provider-backed LLM client, hosted-auth resolver), the built-in tools (Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/NotebookEdit/AskUser), and the browser-based login flow. Published at `@researchcomputer/agents-sdk` (default entry point).

`createAgent()` is the Node factory. It builds a `CoreAdapters` bundle and hands off to `createAgentCore()`, the language-agnostic factory. Other hosts (WASM/Python stub, browser sandboxes, deterministic replays) import `createAgentCore()` directly and supply their own adapters. See [`examples/python-stub/`](../examples/python-stub) for a working Python ↔ Rust ↔ WASM embedding.

For a step-by-step walkthrough of the non-Node embedding path, see [Embedding the Core](./embedding-core.md); for the WIT ABI contract, see [`docs/spec/wasm.md`](./spec/wasm.md).

```
User prompt
     │
     ▼
 Agent.prompt()                       ◄── returned by createAgent (node)
     │                                          or createAgentCore (any host)
     ▼
 Agent (pi-agent-core)
     │
     ├── System Prompt (skills + tools + memory + permissions + swarm context)
     │
     ├── Middleware Pipeline
     │       ├── PreToolUse hooks
     │       ├── Permission gate
     │       └── PostToolUse hooks
     │
     ├── Context Compression (when near token budget)
     │
     ├── Snapshot / Fork (checkpoint or branch agent state)
     │
     ├── LLM calls → via injected LlmClient adapter
     │
     └── Tool Execution → Result → Next turn
```

**Skills** (`ResolvedSkill`) are the primary extension mechanism. Each skill can contribute tools, hooks, MCP servers, permission rules, and prompt sections. The `composeAgentConfig()` function merges all skill contributions into the agent config, with skill tools overriding defaults by name.

### Adapters

Core never touches the filesystem, spawns processes, or imports `ai-provider` at runtime. Each integration point is reached through an adapter interface that the host supplies via `CoreAdapters`:

| Adapter | Responsibility | Node default |
|---|---|---|
| `LlmClient` | `stream()` + `completeN()` for the LLM transport | `createAiProviderLlmClient()` (delegates to `@researchcomputer/ai-provider`) |
| `MemoryStore` | `load/save/remove` memories | Markdown files under `memoryDir` |
| `SessionStore` | `load/save/list` session snapshots | JSON files under `sessionDir` |
| `McpManager` | connect/disconnect MCP servers, expose their tools | stdio/SSE/HTTP manager in `src/node/mcp/` |
| `TelemetryCollector` | collect LLM + tool events | in-memory aggregator |
| `TelemetrySink` | flush collected telemetry | `telemetry.jsonl` sidecar + optional HTTP upload |
| `AuthTokenResolver` | produce a bearer token when no `getApiKey` is supplied | resolves from `authToken` → `RC_AUTH_TOKEN` → `~/.rc-agents/auth.json` → legacy fallbacks |

Any host that provides equivalent implementations can run the full agent loop — WASM, browser sandbox, in-process test harness, or a deterministic replay runtime. The `examples/python-stub/` directory is the reference non-Node embedding.

---

## Tools

A tool is the atomic unit of agent capability. The SDK defines tools as `SdkTool`, which extends the base `AgentTool` interface from `pi-agent-core`:

```typescript
interface SdkTool<TParameters extends TSchema = TSchema, TDetails = any>
  extends AgentTool<TParameters, TDetails> {
  capabilities: Capability[];  // Required capabilities for permission checks
  permissionCheck?: (params: Static<TParameters>, rules: PermissionRule[]) => PermissionResult;
}
```

### Capabilities

Capabilities categorize what a tool can do. They drive the default permission system:

| Capability | Tools that use it | Description |
|---|---|---|
| `fs:read` | Read, Glob, Grep | Read file system contents |
| `fs:write` | Write, Edit, NotebookEdit, Bash | Modify file system |
| `process:spawn` | Bash | Execute subprocesses |
| `network:egress` | WebFetch, WebSearch, Bash | Make network requests |
| `git:mutate` | (reserved) | Modify git repositories |
| `mcp:call` | All MCP-connected tools | Call external MCP tools |

### Custom Tools

You can define custom tools using TypeBox schemas:

```typescript
import { Type } from '@sinclair/typebox';
import type { SdkTool } from '@researchcomputer/agents-sdk';

const myTool: SdkTool = {
  name: 'MyTool',
  description: 'Does something useful',
  inputSchema: Type.Object({
    input: Type.String({ description: 'The input value' }),
  }),
  capabilities: ['fs:read'],
  execute: async ({ input }, runContext) => {
    // perform work
    return `Result: ${input}`;
  },
};

const agent = await createAgent({ model, tools: [myTool] });
```

See [API Reference](./api-reference.md#tool-factories) for built-in tool factories.

---

## Permission System

The permission system runs as middleware before every tool call.

### Modes

| Mode | Behavior | Use Case |
|---|---|---|
| `default` | `fs:read` and no-capability tools are allowed; mutations and spawning require explicit allow or user prompt | Safe default for interactive use |
| `allowAll` | All tools run without checks | Trusted environments, automated pipelines |
| `rulesOnly` | Only tools with a matching allow rule are permitted; everything else is denied | Strict security requirements |

### Rules

Rules are evaluated before the mode fallback. A rule targets specific tools, capabilities, MCP servers, or everything:

```typescript
interface PermissionRule {
  target:
    | { type: 'tool'; name: string; pattern?: string }  // specific tool by name, optional glob pattern
    | { type: 'capability'; capability: Capability }
    | { type: 'mcp'; server: string; tool?: string }
    | { type: 'all' };
  behavior: 'allow' | 'deny';
  source: 'user' | 'project' | 'session';     // user > project > session priority
}
```

When multiple rules match a tool call, the most specific one wins. Specificity order (highest first): `tool + pattern > tool > mcp + tool > mcp > capability > all`. Within equal specificity, source priority applies: `user > project > session`.

### Permission Check Flow

1. Run `tool.permissionCheck(params, rules)` if defined — returns `{ behavior: 'allow' }`, `{ behavior: 'deny', reason }`, or `{ behavior: 'ask', prompt }`.
2. Otherwise, evaluate matching `permissionRules`.
3. If no rule matches, fall back to the `permissionMode`.
4. If the result is `ask`, call `onPermissionAsk(toolName, args)`. If no callback is set, deny.
5. All decisions are logged to `runContext.permissionDecisions`.

---

## Memory

Memory gives the agent persistent context across sessions. Each memory is a Markdown file with YAML frontmatter:

```markdown
---
name: user-role
description: The user is a senior backend engineer working on distributed systems
type: user
---

User is a senior backend engineer. They prefer Go and are experienced with Kubernetes.
Avoid explaining basic concepts unless asked.
```

### Memory Types

| Type | Purpose | Example |
|---|---|---|
| `user` | Information about the user's role, preferences, expertise | "Senior backend engineer, prefers Go" |
| `feedback` | Guidance on how to approach work (do/don't patterns) | "Always run tests before committing" |
| `project` | Goals, context, constraints specific to the current project | "This project uses custom auth" |
| `reference` | Pointers to external systems (issue trackers, dashboards) | "Jira: https://company.atlassian.net" |

### Retrieval

When the agent builds its system prompt, relevant memories are retrieved using keyword matching against the current conversation context. Memories are scored by overlap with query tokens and ranked within a token budget.

### Operations

Via `agent.memory`:

```typescript
// Save a new memory
await agent.memory.save({
  name: 'my-note',
  description: '...',
  type: 'user',
  content: '...'
});

// Remove a memory
await agent.memory.remove('my-note');

// Retrieve relevant memories
const relevant = agent.memory.retrieve(memories, { 
  query: 'query string', 
  maxItems: 5, 
  maxTokens: 2000 
});
```

---

## Session Management

Sessions persist conversation history as JSON snapshots. Each snapshot records:

- All `AgentMessage` objects (including tool calls and results)
- The model ID and provider
- A hash of the system prompt (to detect configuration drift)
- References to memory files active at the time
- Compaction state (if context was compressed)
- Timestamps

### Resuming a Session

```typescript
const id = await agent.sessions.save({
  version: 1,
  id: runContext.sessionId,
  messages: agent.agent.state.messages,
  modelId: config.model.id,
  providerName: 'openai',
  systemPromptHash: 'abc123...',
  memoryRefs: ['user-prefs', 'project-context'],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const resumed = await createAgent({
  model,
  sessionDir: './sessions',
  sessionId: id,
});
```

On resume, the snapshot's messages are replayed into the agent's context before any new prompts are processed.

---

## Context & Compression

### Message Conversion

The agent maintains `AgentMessage[]` internally. Before each LLM call, messages are converted to the LLM's format via `convertToLlm()`. Custom message types (memory injections, compaction summaries, swarm reports) are converted to user-turn text with descriptive prefixes.

### System Prompt Construction

`buildSystemPrompt()` assembles the system prompt in this order:

1. Base instructions (custom or default coding agent prompt)
2. Skill instructions (from `ResolvedSkill.promptSections`)
3. Tool descriptions (name + description for each tool)
4. Retrieved memories with relevance scores
5. Memory management instructions
6. Permission context (if `permissionMode` is configured)
7. Swarm team context (if swarm is enabled)

### Compression

When the token count approaches the budget (default threshold: 80%), the `createCompressionMiddleware` kicks in:

1. Estimate tokens: `ceil(total_chars / 4)`
2. Protect the most recent N turns (default: 3, i.e., 9 messages)
3. Drop older turns from the front until the total fits the budget
4. Insert a `CompactionSummaryMessage` noting what was trimmed

For production workloads with very long conversations, consider the `summarize` strategy which generates an LLM summary of dropped content before truncating.

---

## MCP (Model Context Protocol)

MCP servers expose tools via a standard protocol, letting you plug in external capabilities without writing custom tool code.

### Transports

**stdio** — Spawn a local process:

```typescript
{ name: 'git', transport: 'stdio', command: 'mcp-git', args: [], env: {} }
```

**sse** — Connect to a remote SSE server:

```typescript
{ name: 'browser', transport: 'sse', url: 'http://localhost:3001/sse', headers: {} }
```

**http** — Connect to a remote HTTP server:

```typescript
{ name: 'api', transport: 'http', url: 'http://localhost:3001', headers: {} }
```

### Tool Naming

Each MCP tool is named `mcp__<server>__<tool>`. For example, a `list_branches` tool from the `git` server becomes `mcp__git__list_branches`. This namespacing prevents collisions and makes the tool's origin clear in permission rules:

```typescript
// Allow all git MCP tools
{ target: { type: 'mcp', server: 'git' }, behavior: 'allow', source: 'user' }

// Allow only one specific MCP tool
{ target: { type: 'mcp', server: 'git', tool: 'list_branches' }, behavior: 'allow', source: 'user' }
```

### Schema Conversion

MCP tools describe their inputs as JSON Schema. The SDK converts these to TypeBox schemas automatically. Unsupported constructs (`$ref`, `oneOf`, `allOf`, `anyOf`) emit a warning but are handled gracefully.

---

## Swarm (Multi-Agent)

When `enableSwarm: true`, the agent becomes a team leader with the ability to spawn sub-agents (teammates), delegate work to them, and receive reports.

### How It Works

1. The leader uses `SpawnTeammate` to create a sub-agent with a name, system prompt, and task.
2. Each teammate runs as an independent `Agent` with its own tool set and budget constraints.
3. The leader can use `SendMessage` to communicate with running teammates.
4. Teammates can be dismissed with `DismissTeammate` when their work is complete.
5. Teammate results are delivered back to the leader as `SwarmReportMessage` entries in the conversation.

### Merge Strategies

When spawning a teammate, specify how its output should be returned:

| Strategy | Behavior |
|---|---|
| `report` | Return a text summary of findings |
| `diff` | Return a unified diff of file changes |
| `pr` | (future) Open a pull request |

### Budget Controls

Prevent runaway sub-agents with budget limits:

```typescript
// Inside a prompt, the leader can spawn with constraints
SpawnTeammate({
  name: 'researcher',
  prompt: 'Search the codebase for all usages of deprecated APIs',
  maxTurns: 20,
  maxTokens: 50000,
  timeoutMs: 60000,
});
```

---

## Snapshot & Fork

`Agent` supports checkpointing and branching conversation state for rollback, parallel exploration, and evaluation harnesses.

### Message-Centric State

Snapshots are **strictly message-based**. They capture the full `AgentMessage[]` history (including tool results and compaction summaries) but **do not capture external state** such as:
- Files written to disk
- Environment variables or current working directory
- Network connections or MCP server state
- Local processes spawned via tools

This design ensures that snapshots are lightweight, easily serializable, and suitable for branching across multiple independent child agents without environment collision.

### Snapshot / Restore

`snapshot()` captures the current `AgentMessage[]` history as an `AgentSnapshot` (a UUID + cloned messages + timestamp). `restore(snapshot)` replaces the agent's conversation with a previous snapshot. Both throw if the agent is currently streaming.

### Fork

`fork(message, n)` creates N independent child agents from the current conversation state. Each child is a fresh `Agent` (via `createAgent`) whose messages are replaced with a deep clone of the parent's, then prompted with `message`. All N children run in parallel.

For OpenAI-compatible models, `fork` is optimized to use the model's native `n` parameter, requesting multiple completions in a single input call to save tokens. If tool calls are generated, it falls back to standard prompts to ensure correct tool execution.

`forkFrom(snapshot, message, n)` is the same but starts from a previously captured snapshot instead of the current state — useful for branching from a known-good point after the parent has moved on.

### Auto-Fork

The `autoFork` config automatically forks after every LLM turn:

```typescript
const agent = await createAgent({
  model,
  autoFork: {
    branches: 3,
    onBranches: async (children) => { /* score, compare, etc. */ },
  },
});
```

The fork happens asynchronously after each `turn_end` event. Exceptions in `onBranches` are caught and ignored.

---

## Hooks

Hooks let you observe and modify agent behavior at specific lifecycle points.

### Tool Lifecycle Hooks

```typescript
interface HookHandler {
  event: 'PreToolUse' | 'PostToolUse';
  matcher?: string; // Tool name or regex pattern; omit to match all tools
  handler: (context: HookContext) => Promise<HookResult>;
}
```

`PreToolUse` hooks can modify `toolArgs` before the tool runs. `PostToolUse` hooks can modify `toolResult` after it runs. Hooks run sequentially; each receives the output of the previous.

### Lifecycle Hooks

These hooks fire at specific agent lifecycle events and do not support a `matcher`:

| Event | When | Use Case |
|---|---|---|
| `SessionStart` | After the agent is fully initialized | Initialize external resources |
| `SessionEnd` | Before the agent disposes | Cleanup, logging |
| `Stop` | When the agent stops processing (end_turn) | Trigger follow-up actions |
| `SubagentStart` | When a swarm teammate begins | Track sub-agent creation |
| `SubagentStop` | When a swarm teammate finishes | Process sub-agent results |
| `PreCompact` | Before context compression | Save state before truncation |
| `PostCompact` | After context compression | Log compression results |

### Example

```typescript
const agent = await createAgent({
  model,
  hooks: [
    {
      event: 'PreToolUse',
      matcher: 'Bash',
      handler: async ({ toolArgs }) => {
        console.log('Running bash:', (toolArgs as any).command);
        return {}; // return {} to continue, or { updatedArgs: ... } to modify
      },
    },
    {
      event: 'PostToolUse',
      handler: async ({ toolName, toolResult }) => {
        logAudit(toolName, toolResult);
        return {}; // return {} to pass result through, or { updatedResult: ... }
      },
    },
    {
      event: 'SessionEnd',
      handler: async () => {
        console.log('Session complete');
        return {};
      },
    },
  ],
});
```

---

## Observability

### Cost Tracking

Every LLM call's token usage is recorded. The `CostTracker` aggregates this across the session:

```typescript
const { tokens, cost } = agent.costTracker.total();
// tokens: total input + output tokens
// cost: USD estimate based on model pricing

const perModel = agent.costTracker.perModel();
// Map<modelId, { tokens, cost }>
```

### Trace IDs

Each session gets a unique `traceId` from `generateTraceId()`. This is available on the `RunContext` passed to every tool and middleware. Use it to correlate logs across a session.

### Permission Audit Log

`runContext.permissionDecisions` accumulates every permission check result during the session:

```typescript
{
  toolName: string;
  args: unknown;
  behavior: 'allow' | 'deny';
  matchedRule?: PermissionRule;
  normalizedTarget: string;
  timestamp: number;
}
```

---

## Glossary

| Term | Definition |
|---|---|
| **Adapter** | A host-supplied implementation of a core interface (`LlmClient`, `MemoryStore`, `SessionStore`, `McpManager`, `TelemetryCollector`, `TelemetrySink`, `AuthTokenResolver`). Core never imports host APIs directly. |
| **Agent** | The core runtime from `pi-agent-core` that manages the conversation loop |
| **Capability** | A category of tool functionality (e.g., `fs:read`, `process:spawn`) used for permission checks |
| **Agent** | The high-level wrapper returned by `createAgent()` with helpers for sessions, memory, MCP, etc. |
| **Core** | The language-agnostic runtime under `src/core/`, published as `@researchcomputer/agents-sdk/core`. Runs anywhere an ES module runs (Node, WASM, browser sandbox). |
| **LlmClient** | Adapter that core uses for LLM calls. Node's default wraps `@researchcomputer/ai-provider`; non-Node hosts supply their own (e.g., the Python stub bridges it to an aiohttp mock). |
| **Compression** | The process of reducing context size when approaching token limits (truncate or summarize) |
| **Fork** | Creating N parallel agent branches from a snapshot for parallel exploration |
| **Hook** | A callback that runs at specific lifecycle points (PreToolUse, PostToolUse, SessionStart, etc.) |
| **MCP** | Model Context Protocol — a standard for connecting external tool servers |
| **Memory** | Persistent context stored as Markdown files with YAML frontmatter |
| **Permission Mode** | The default behavior when no rules match (`default`, `allowAll`, `rulesOnly`) |
| **Permission Rule** | An explicit allow/deny directive targeting tools, capabilities, or MCP servers |
| **Pipeline** | The composed chain of hooks and permission checks that runs before/after tool execution |
| **Session** | A persisted snapshot of conversation history that can be resumed later |
| **Skill** | A reusable package of tools, hooks, MCP servers, permission rules, and prompt sections |
| **Snapshot** | A point-in-time capture of an agent's conversation state (messages) |
| **Swarm** | Multi-agent coordination where a leader spawns and manages sub-agents (teammates) |
| **Teammate** | A sub-agent spawned by a swarm leader to handle delegated tasks |
| **Tool** | An atomic unit of agent capability with a schema, capabilities, and execute function |
| **Trace ID** | A unique identifier for correlating logs across a session |
