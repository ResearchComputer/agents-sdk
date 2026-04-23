# Snapshot & Fork

> *Audience: developers using `createAgent()` or `createAgentCore()` and needing to branch or restore conversation state.*

Checkpoint agent state and branch into parallel explorations. This guide covers every snapshot and fork primitive the SDK exposes, when to reach for each one, and how they compose.

## Table of Contents

- [Overview](#overview)
- [Snapshot & Restore](#snapshot--restore)
- [Fork](#fork)
- [Fork from Snapshot](#fork-from-snapshot)
- [promptFork](#promptfork)
- [Auto-Fork](#auto-fork)
- [API Reference](#api-reference)
- [Patterns & Recipes](#patterns--recipes)
- [Constraints & Caveats](#constraints--caveats)

---

## Overview

All snapshot and fork operations work on the agent's **message history** — the ordered list of `AgentMessage` objects that make up the conversation. They do not capture or restore external side effects (files written to disk, processes spawned, MCP server state, etc.).

```
                  snapshot()
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   restore(snap)            fork(msg, N)
   (roll back)              (branch out)
        │                    ┌──┼──┐
        ▼                    ▼  ▼  ▼
   continue from          N child agents
   the checkpoint         run in parallel
```

Key properties:

- **Deep clone** — snapshots and forks use `structuredClone` so mutations in one branch never leak to another.
- **Streaming guard** — `snapshot()` and `restore()` throw if the agent is currently streaming.
- **Independent children** — forked agents are full `Agent` instances with their own tool pipeline, cost tracker, and session manager. They share the same `AgentConfig` (minus `sessionId` and `autoFork`).

---

## Snapshot & Restore

`snapshot()` captures the current message history. `restore(snapshot)` replaces the agent's messages with a previous capture.

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';

const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  cwd: process.cwd(),
  permissionMode: 'allowAll',
  enableMemory: false,
});

// Build context
await agent.prompt('Read src/index.ts and summarize the exports');

// Checkpoint
const checkpoint = agent.snapshot();
// checkpoint.id        — UUID
// checkpoint.messages  — deep-cloned AgentMessage[]
// checkpoint.createdAt — Date.now() at capture time

// Try approach A
await agent.prompt('Refactor exports to use barrel files');

// Unhappy? Roll back
agent.restore(checkpoint);

// Try approach B from the same starting point
await agent.prompt('Refactor exports to use named re-exports');

await agent.dispose();
```

### When to use

- **Experimentation** — try something risky and roll back if it doesn't work.
- **A/B comparisons** — checkpoint, try A, record result, restore, try B, compare.
- **Undo** — provide an undo mechanism in interactive agent UIs.

### What is captured

| Included | Not included |
|---|---|
| All `AgentMessage` objects (user, assistant, tool calls, tool results, memory injections, compaction summaries, swarm reports) | Files written to disk |
| | Processes spawned via Bash |
| | MCP server state |
| | Cost tracker totals |
| | Session persistence |

---

## Fork

`fork(message, n)` creates N independent child agents from the **current** conversation state. Each child receives a deep clone of the parent's messages, then processes the given `message` in parallel.

```typescript
const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  cwd: process.cwd(),
  permissionMode: 'allowAll',
  enableMemory: false,
});

// Shared context
await agent.prompt('Read the database schema in src/db/schema.ts');

// Fork 3 children — each explores the same prompt independently
const branches = await agent.fork('Propose a migration strategy for adding soft deletes', 3);

for (const [i, branch] of branches.entries()) {
  const last = branch.agent.state.messages
    .filter((m: any) => m.role === 'assistant').at(-1);
  const text = (last?.content as any[])?.[0]?.text ?? '';
  console.log(`Branch ${i}: ${text.slice(0, 200)}`);
}

// Always dispose children when done
for (const b of branches) await b.dispose();
await agent.dispose();
```

### How it works internally

1. **Optimization (OpenAI-compatible)** — If the model supports the native `n` parameter (via `openai-completions` API style) and no custom `streamFn` is provided, the SDK makes **one** LLM call requesting `n` completions. This significantly reduces input token costs and latency for the initial response of all branches.
2. **Fallback** — If the model does not support `n` (e.g., Anthropic) or if the optimized responses contain tool calls, the SDK transparently falls back to parallel individual prompts for each child.
3. **Deep-clone history** — The parent's current `messages` are deep-cloned via `structuredClone`.
4. **Independent instances** — N fresh `Agent` instances are created via `createAgent` (same config, no `sessionId` or `autoFork`).
5. **Seeding** — Each child is seeded with the cloned history and its respective (optimized or standard) response to the `message`.
6. **Parallelism** — All children run their initial turns in parallel.

### When to use

- **Parallel exploration** — try multiple approaches to the same problem simultaneously.
- **Best-of-N sampling** — generate N solutions, score them, keep the best.
- **Search trees** — explore a decision space by branching at each step.

---

## Token Efficiency & Native `n` Support

For OpenAI-compatible models, `fork(message, n)` is optimized to use the model's native `n` parameter.

| Feature | standard `fork` | optimized `fork` (OpenAI-compatible) |
|---|---|---|
| LLM Calls | N separate calls | 1 call with `n` completions |
| Input Tokens | Parent context * N | Parent context * 1 |
| Output Tokens | Child 1 + ... + Child N | Child 1 + ... + Child N |
| Tool Calls | Supported | Supported (triggers fallback per child) |

This optimization is active when:
1. `config.model.api` is `'openai-completions'` or `'openai-responses'`.
2. No custom `streamFn` is provided in the config.
3. `n > 1`.

If a response contains tool calls, the SDK falls back to a standard prompt call for that specific child to ensure full tool-execution capabilities. This means you get the best of both worlds: extreme token efficiency for pure text explorations, and full correctness for tool-heavy explorations.

---

## Fork from Snapshot

`forkFrom(snapshot, message, n)` is like `fork` but starts from a **previously captured snapshot** instead of the current state. This is useful when the parent has moved on but you want to branch from a known-good earlier point.

```typescript
const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  cwd: process.cwd(),
  permissionMode: 'allowAll',
  enableMemory: false,
});

await agent.prompt('Analyze the test suite and identify gaps');
const analysisCheckpoint = agent.snapshot();

// Parent continues down one path
await agent.prompt('Write integration tests for the API layer');

// Fork from the earlier analysis — parent state is unchanged
const unitTestBranches = await agent.forkFrom(
  analysisCheckpoint,
  'Write unit tests for the utility functions',
  2,
);

for (const b of unitTestBranches) await b.dispose();
await agent.dispose();
```

### When to use

- **Branching from a common starting point** — run multiple downstream tasks from a shared analysis step.
- **Deferred exploration** — capture a checkpoint, continue working, then come back and explore alternatives from that checkpoint later.

---

## promptFork

`promptFork(message, n)` is an alias for `fork(message, n)`. Both create N children from the current state and prompt them in parallel. Use whichever name reads better in your code.

```typescript
// These are equivalent:
const a = await agent.fork('Suggest improvements', 3);
const b = await agent.promptFork('Suggest improvements', 3);
```

---

## Auto-Fork

The `autoFork` config option automatically forks after every LLM turn. This is useful for building evaluation harnesses or search algorithms that need to explore multiple continuations at each step.

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';
import type { Agent } from '@researchcomputer/agents-sdk';

const allBranches: Agent[][] = [];

const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  cwd: process.cwd(),
  permissionMode: 'allowAll',
  enableMemory: false,
  autoFork: {
    branches: 3,
    onBranches: async (children) => {
      allBranches.push(children);
      // Score, compare, log, or discard children here
    },
  },
});

await agent.prompt('Fix the failing test in src/auth.test.ts');

// After each LLM turn, 3 alternative branches were spawned
console.log(`Auto-forked ${allBranches.length} time(s)`);

// Clean up
for (const group of allBranches) {
  for (const b of group) await b.dispose();
}
await agent.dispose();
```

### How it works

1. The agent subscribes to its own events.
2. On `message_start` with `role: 'user'`, the user's text is captured.
3. On `turn_end`, `fork(capturedMessage, branches)` is called asynchronously.
4. The resulting child agents are passed to `onBranches`.
5. Exceptions in `onBranches` are caught and ignored — the parent agent is never interrupted.

### When to use

- **Evaluation harnesses** — compare the primary agent's response against N alternatives on every turn.
- **Genetic algorithms** — evolve agent trajectories by scoring and selecting branches.
- **Monte Carlo tree search** — build a search tree over agent trajectories.

---

## API Reference

### `AgentSnapshot`

```typescript
interface AgentSnapshot {
  id: string;           // UUID, generated at snapshot time
  messages: AgentMessage[];  // Deep-cloned conversation history
  createdAt: number;    // Date.now() at capture time
}
```

### `Agent` methods

| Method | Signature | Description |
|---|---|---|
| `snapshot()` | `() => AgentSnapshot` | Capture current message history. Throws if streaming. |
| `restore(snap)` | `(snapshot: AgentSnapshot) => void` | Replace messages with a previous snapshot. Throws if streaming. |
| `fork(msg, n)` | `(message: string, n: number) => Promise<Agent[]>` | Create N children from current state, prompt each with `msg`. |
| `forkFrom(snap, msg, n)` | `(snapshot: AgentSnapshot, message: string, n: number) => Promise<Agent[]>` | Create N children from a snapshot, prompt each with `msg`. |
| `promptFork(msg, n)` | `(message: string, n: number) => Promise<Agent[]>` | Alias for `fork`. |

### `AutoForkConfig`

```typescript
interface AutoForkConfig {
  branches: number;
  onBranches: (agents: Agent[]) => void | Promise<void>;
}
```

---

## Patterns & Recipes

### Best-of-N with custom scoring

```typescript
const branches = await agent.fork('Write a parser for cron expressions', 5);

// Score by whatever metric matters to you
function score(branch: Agent): number {
  const msgs = branch.agent.state.messages;
  const last = msgs.filter((m: any) => m.role === 'assistant').at(-1);
  const text = (last?.content as any[])?.[0]?.text ?? '';
  // Example: prefer longer, more detailed responses
  return text.length;
}

const best = branches.reduce((a, b) => score(a) > score(b) ? a : b);
console.log('Best branch score:', score(best));

for (const b of branches) await b.dispose();
```

### Checkpoint ladder

Take multiple checkpoints as you go, roll back to any of them:

```typescript
const checkpoints: AgentSnapshot[] = [];

await agent.prompt('Step 1: Read the codebase');
checkpoints.push(agent.snapshot());

await agent.prompt('Step 2: Propose architecture');
checkpoints.push(agent.snapshot());

await agent.prompt('Step 3: Implement (risky!)');

// Roll back to step 2 if step 3 went wrong
agent.restore(checkpoints[1]);
```

### Fan-out / fan-in

Fork for parallel research, then synthesize results in the parent:

```typescript
await agent.prompt('Read the project README');

const branches = await agent.fork('Find all security vulnerabilities in src/', 3);

// Collect results from each branch
const findings: string[] = [];
for (const branch of branches) {
  const last = branch.agent.state.messages
    .filter((m: any) => m.role === 'assistant').at(-1);
  findings.push((last?.content as any[])?.[0]?.text ?? '');
  await branch.dispose();
}

// Feed aggregated findings back to the parent
await agent.prompt(
  `Here are security findings from 3 parallel scans:\n\n${findings.join('\n\n---\n\n')}\n\nSynthesize a final report.`
);
```

---

## Constraints & Caveats

1. **Message-only** — snapshots capture conversation history, not file system state, environment variables, or MCP server state. If a forked agent writes files, those writes persist on disk even if you discard the branch.

2. **No streaming** — `snapshot()` and `restore()` throw `Error` if the agent is currently streaming. Wait for the current prompt to complete first.

3. **Cost multiplier** — each forked child makes its own LLM calls. Forking N branches from a long conversation means N times the input tokens. Use `n` judiciously.

4. **Independent cost tracking** — each child has its own `CostTracker`. The parent's tracker does not include child costs. Aggregate manually if needed.

5. **No `sessionId` or `autoFork` inheritance** — child agents are created without `sessionId` (they don't persist sessions) and without `autoFork` (to prevent recursive fork storms).

6. **Dispose children** — forked agents hold MCP connections and other resources. Always call `dispose()` on every child when done.

7. **`n = 0` is valid** — `fork(msg, 0)` returns an empty array. Negative `n` throws `RangeError`.

---

## See Also

- [Getting Started: Snapshot & Fork](./getting-started.md#snapshot--fork) — quick overview
- [Core Concepts: Snapshot & Fork](./concepts.md#snapshot--fork) — architecture context
- [Examples: Snapshot & Fork Patterns](./examples.md#snapshot--fork-patterns) — inline code recipes
- [`examples/snapshot-restore.ts`](../examples/snapshot-restore.ts) — runnable snapshot/restore demo
- [`examples/fork-best-of-n.ts`](../examples/fork-best-of-n.ts) — runnable best-of-N demo
- [`examples/fork-from-snapshot.ts`](../examples/fork-from-snapshot.ts) — runnable forkFrom demo
- [`examples/auto-fork.ts`](../examples/auto-fork.ts) — runnable auto-fork demo
