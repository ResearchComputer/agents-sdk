# Examples

Practical usage patterns and recipes for the `@researchcomputer/agents-sdk`.

## Table of Contents

- [Basic Patterns](#basic-patterns)
  - [Read-Only Agent](#read-only-agent)
  - [Interactive Agent with Permission Prompts](#interactive-agent-with-permission-prompts)
  - [Agent with Strict Permission Rules](#agent-with-strict-permission-rules)
- [Session Management](#session-management)
  - [Persistent Agent with Memory and Sessions](#persistent-agent-with-memory-and-sessions)
- [Snapshot & Fork Patterns](#snapshot--fork-patterns)
  - [Snapshot & Restore](#snapshot--restore)
  - [Fork: Parallel Exploration](#fork-parallel-exploration)
  - [Fork from Snapshot](#fork-from-snapshot)
  - [Auto-Fork: Branch on Every Turn](#auto-fork-branch-on-every-turn)
  - [Best-of-N: Pick the Best Fork](#best-of-n-pick-the-best-fork)
- [MCP Integration](#mcp-integration)
  - [MCP-Powered Agent](#mcp-powered-agent)
- [Hooks & Observability](#hooks--observability)
  - [Audit Logging with Hooks](#audit-logging-with-hooks)
  - [Blocking Specific Commands with a Hook](#blocking-specific-commands-with-a-hook)
  - [Token Budget Management](#token-budget-management)
  - [Per-Model Cost Report](#per-model-cost-report)
- [Advanced Patterns](#advanced-patterns)
  - [Multi-Agent Swarm](#multi-agent-swarm)
  - [One-Shot Sub-Agent](#one-shot-sub-agent)
  - [Custom Tool](#custom-tool)
  - [Context Compression Configuration](#context-compression-configuration)
- [Embedding the core in a non-Node host](#embedding-the-core-in-a-non-node-host)

---

## Basic Patterns

### Read-Only Agent

An agent that can only read files — safe for inspection tasks:

```typescript
import { createAgent, createReadTool, createGlobTool, createGrepTool } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';

const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  cwd: '/path/to/project',
  tools: [
    createReadTool({ cwd: '/path/to/project' }),
    createGlobTool({ cwd: '/path/to/project' }),
    createGrepTool({ cwd: '/path/to/project' }),
  ],
  permissionMode: 'allowAll',
});

await agent.prompt('Find all TODO comments in the codebase and summarize them');
await agent.dispose();
```

**Use case:** Code review, documentation generation, security auditing where you want to prevent any modifications.

---

### Interactive Agent with Permission Prompts

Ask the user before any write or shell operation:

```typescript
import * as readline from 'readline/promises';
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const agent = await createAgent({
  model: getModel('anthropic', 'claude-opus-4-6'),
  cwd: process.cwd(),
  permissionMode: 'default',
  onPermissionAsk: async (toolName, args) => {
    const answer = await rl.question(`Allow ${toolName}? [y/N] `);
    return answer.toLowerCase() === 'y';
  },
  onQuestion: async (question) => {
    return rl.question(`Agent asks: ${question}\nYour answer: `);
  },
});

await agent.prompt(process.argv[2] ?? 'What can I help you with?');
await agent.dispose();
rl.close();
```

**Use case:** Interactive CLI tools where you want user oversight before destructive operations.

---

### Agent with Strict Permission Rules

Deny all writes, but allow specific bash commands:

```typescript
const agent = await createAgent({
  model,
  cwd: process.cwd(),
  permissionMode: 'rulesOnly',
  permissionRules: [
    // Allow all reads
    { target: { type: 'capability', capability: 'fs:read' }, behavior: 'allow', source: 'user' },
    // Deny writes
    { target: { type: 'capability', capability: 'fs:write' }, behavior: 'deny', source: 'user' },
    // Allow running tests
    { target: { type: 'tool', name: 'Bash' }, behavior: 'allow', source: 'user' },
  ],
});
```

**Use case:** CI/CD pipelines where you want fine-grained control over what the agent can do.

---

## Session Management

### Persistent Agent with Memory and Sessions

An agent that remembers things and can resume conversations:

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const SESSION_FILE = './.agent-session';
const model = getModel('anthropic', 'claude-opus-4-6');

// Load previous session ID if it exists
const sessionId = existsSync(SESSION_FILE)
  ? readFileSync(SESSION_FILE, 'utf-8').trim()
  : undefined;

const agent = await createAgent({
  model,
  cwd: process.cwd(),
  enableMemory: true,
  memoryDir: './agent-memory',
  sessionDir: './agent-sessions',
  sessionId,
});

await agent.prompt('What were we working on last time?');
await agent.dispose(); // saves session

// Save new session ID for next run
const sessions = await agent.sessions.list();
const id = sessions[0]?.id;
if (id) writeFileSync(SESSION_FILE, id);
```

**Use case:** Long-running projects where you want the agent to maintain context across multiple runs.

---

## Snapshot & Fork Patterns

### Snapshot & Restore

Checkpoint an agent's conversation state and roll back if needed:

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';

const agent = await createAgent({
  model: getModel('anthropic', 'claude-opus-4-6'),
  cwd: process.cwd(),
  permissionMode: 'allowAll',
});

// Build up some context
await agent.prompt('Read the README and summarize the project');

// Checkpoint before a risky operation
const checkpoint = agent.snapshot();

await agent.prompt('Refactor the auth module to use JWT');

// Not happy with the result? Roll back and try again
agent.restore(checkpoint);
await agent.prompt('Refactor the auth module to use session cookies instead');

await agent.dispose();
```

**Use case:** Experimenting with different approaches — try something, roll back if it doesn't work.

---

### Fork: Parallel Exploration

Fork an agent into N independent branches that explore different approaches in parallel:

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';

const agent = await createAgent({
  model: getModel('anthropic', 'claude-opus-4-6'),
  cwd: process.cwd(),
  permissionMode: 'allowAll',
});

// Give the agent shared context
await agent.prompt('Read src/database.ts and understand the current schema');

// Fork into 3 branches, each exploring a different migration strategy
const branches = await agent.fork('Propose a migration strategy for adding soft deletes', 3);

// Each branch ran independently — inspect their results
for (const [i, branch] of branches.entries()) {
  const lastMsg = branch.agent.state.messages.at(-1);
  const text = (lastMsg?.content as any[])?.[0]?.text ?? '';
  console.log(`\n--- Branch ${i} ---`);
  console.log(text.slice(0, 200));
  await branch.dispose();
}

await agent.dispose();
```

**Use case:** Exploring multiple solutions to a problem simultaneously and comparing results.

---

### Fork from Snapshot

Fork from an earlier checkpoint instead of the current state — useful when you want to branch from a known-good point after the parent has moved on:

```typescript
const agent = await createAgent({
  model: getModel('anthropic', 'claude-opus-4-6'),
  cwd: process.cwd(),
  permissionMode: 'allowAll',
});

await agent.prompt('Analyze the test suite and identify gaps');
const analysisCheckpoint = agent.snapshot();

// Parent continues down one path
await agent.prompt('Write integration tests for the API layer');

// Meanwhile, fork from the earlier analysis to explore unit tests
const unitTestBranches = await agent.forkFrom(
  analysisCheckpoint,
  'Write unit tests for the utility functions',
  2,
);

// Parent's state is unchanged — still has the integration test work
// Children started from the analysis checkpoint
for (const branch of unitTestBranches) await branch.dispose();
await agent.dispose();
```

**Use case:** Working on multiple features from a common starting point.

---

### Auto-Fork: Branch on Every Turn

Automatically fork after each LLM turn — useful for building evaluation harnesses or search trees:

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';
import type { Agent } from '@researchcomputer/agents-sdk';

const results: { prompt: string; branches: Agent[] }[] = [];

const agent = await createAgent({
  model: getModel('anthropic', 'claude-opus-4-6'),
  cwd: process.cwd(),
  permissionMode: 'allowAll',
  autoFork: {
    branches: 2,
    onBranches: async (agents) => {
      results.push({ prompt: 'auto', branches: agents });
    },
  },
});

await agent.prompt('Fix the failing test in src/auth.test.ts');

// results now contains the 2 alternative branches spawned after the turn
console.log(`Auto-forked ${results.length} time(s), ${results[0]?.branches.length} branches each`);

// Clean up
for (const r of results) {
  for (const b of r.branches) await b.dispose();
}
await agent.dispose();
```

**Use case:** Building evaluation harnesses, genetic algorithms, or tree search over agent trajectories.

---

### Best-of-N: Pick the Best Fork

A common pattern — fork N times, score each result, keep the best:

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';

const agent = await createAgent({
  model: getModel('anthropic', 'claude-opus-4-6'),
  cwd: process.cwd(),
  permissionMode: 'allowAll',
});

await agent.prompt('Read src/utils.ts');

// Fork 3 approaches to the same problem
const branches = await agent.fork(
  'Write a function that parses ISO 8601 duration strings. Include edge cases.',
  3,
);

// Simple scoring: pick the branch with the longest assistant response
let best = branches[0];
let bestLen = 0;
for (const branch of branches) {
  const msgs = branch.agent.state.messages;
  const lastAssistant = msgs.filter((m: any) => m.role === 'assistant').at(-1);
  const len = (lastAssistant?.content as any[])?.[0]?.text?.length ?? 0;
  if (len > bestLen) {
    best = branch;
    bestLen = len;
  }
}

// Use the best branch's result
const bestMsg = best.agent.state.messages.filter((m: any) => m.role === 'assistant').at(-1);
console.log('Best result:', (bestMsg?.content as any[])?.[0]?.text?.slice(0, 300));

for (const branch of branches) await branch.dispose();
await agent.dispose();
```

**Use case:** Quality assurance — generate multiple solutions and pick the best one.

---

## MCP Integration

### MCP-Powered Agent

Extend the agent with a Git MCP server:

```typescript
const agent = await createAgent({
  model,
  cwd: process.cwd(),
  mcpServers: [
    {
      name: 'git',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git', '--repository', process.cwd()],
    },
  ],
  // Allow all git MCP tools
  permissionRules: [
    { target: { type: 'mcp', server: 'git' }, behavior: 'allow', source: 'user' },
  ],
});

await agent.prompt('Show me the last 5 commits and summarize what changed');
await agent.dispose();
```

**Use case:** Integrating with external systems (git, databases, browsers, APIs) via MCP servers.

---

## Hooks & Observability

### Audit Logging with Hooks

Log every tool call to a file:

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { appendFileSync } from 'fs';

const agent = await createAgent({
  model,
  cwd: process.cwd(),
  hooks: [
    {
      event: 'PreToolUse',
      handler: async ({ toolName, toolArgs }) => {
        const entry = JSON.stringify({ ts: Date.now(), tool: toolName, args: toolArgs });
        appendFileSync('./audit.jsonl', entry + '\n');
        return {};
      },
    },
    {
      event: 'PostToolUse',
      handler: async ({ toolName, toolResult }) => {
        const entry = JSON.stringify({
          ts: Date.now(),
          tool: toolName,
          resultLen: JSON.stringify(toolResult ?? {}).length,
        });
        appendFileSync('./audit.jsonl', entry + '\n');
        return {};
      },
    },
  ],
});
```

**Use case:** Compliance, debugging, or understanding agent behavior.

---

### Blocking Specific Commands with a Hook

Prevent the agent from running `rm` commands:

```typescript
const agent = await createAgent({
  model,
  hooks: [
    {
      event: 'PreToolUse',
      matcher: 'Bash',
      handler: async ({ toolArgs }) => {
        const cmd = (toolArgs as any).command as string;
        if (/\brm\b/.test(cmd)) {
          throw new Error('rm commands are not allowed');
        }
        return {};
      },
    },
  ],
});
```

**Use case:** Additional safety layers beyond the permission system.

---

### Token Budget Management

Track and enforce a token budget across a session:

```typescript
import { createAgent, BudgetExhaustedError } from '@researchcomputer/agents-sdk';

const MAX_COST_USD = 0.50;

const agent = await createAgent({ model, cwd: process.cwd() });

const prompts = [
  'Analyze the authentication module',
  'Find potential security issues',
  'Suggest improvements',
];

for (const prompt of prompts) {
  const { cost } = agent.costTracker.total();
  if (cost >= MAX_COST_USD) {
    console.log(`Budget exhausted at $${cost.toFixed(4)}`);
    break;
  }
  await agent.prompt(prompt);
}

await agent.dispose();
const { tokens, cost } = agent.costTracker.total();
console.log(`Total: ${tokens} tokens, $${cost.toFixed(4)}`);
```

**Use case:** Cost control for production deployments or experiments.

---

### Per-Model Cost Report

Generate a detailed cost breakdown at the end of a session:

```typescript
await agent.prompt('...');
await agent.dispose();

const total = agent.costTracker.total();
console.log(`\nSession cost: $${total.cost.toFixed(4)} (${total.tokens} tokens)`);
console.log('\nPer model:');
for (const [modelId, usage] of agent.costTracker.perModel()) {
  console.log(`  ${modelId}: ${usage.tokens} tokens = $${usage.cost.toFixed(4)}`);
}
```

**Use case:** Understanding costs when using multiple models or providers.

---

## Advanced Patterns

### Multi-Agent Swarm

A team leader that delegates research to a sub-agent:

```typescript
const agent = await createAgent({
  model,
  cwd: process.cwd(),
  enableSwarm: true,
  systemPrompt: `You are a team lead. When asked to analyze a codebase, spawn a 
  researcher teammate to scan the files, then synthesize their findings.`,
});

await agent.prompt('Analyze the architecture of this project and produce a summary');
await agent.dispose();
```

The leader will use `SpawnTeammate` to create a sub-agent, that sub-agent will use file tools to explore the codebase, and its report will be fed back to the leader to synthesize.

**Use case:** Complex tasks that benefit from parallel work streams or specialized sub-agents.

---

### One-Shot Sub-Agent

Run a contained task without setting up a full `Agent`:

```typescript
import { runSubAgent, createReadTool, createGrepTool } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';

const cwd = process.cwd();
const model = getModel('anthropic', 'claude-opus-4-6');

const result = await runSubAgent(
  'Find all exported functions in src/ and list their names',
  {
    model,
    tools: [
      createReadTool({ cwd }),
      createGrepTool({ cwd }),
    ],
    getApiKey: async () => process.env.ANTHROPIC_API_KEY,
  },
);

console.log(result);
```

**Use case:** Simple, isolated tasks where you don't need full agent lifecycle management.

---

### Custom Tool

Add domain-specific tools to the default set:

```typescript
import { createAgent, getAllTools } from '@researchcomputer/agents-sdk';
import { Type } from '@sinclair/typebox';

const cwd = process.cwd();

const deployTool = {
  name: 'Deploy',
  description: 'Deploy the application to the specified environment',
  inputSchema: Type.Object({
    environment: Type.Union([
      Type.Literal('staging'),
      Type.Literal('production'),
    ], { description: 'Target environment' }),
  }),
  capabilities: ['process:spawn'] as const,
  execute: async ({ environment }) => {
    // your deploy logic
    return `Deployed to ${environment}`;
  },
};

const agent = await createAgent({
  model,
  cwd,
  tools: [...getAllTools({ cwd }), deployTool],
  // Require explicit approval for production deploys
  onPermissionAsk: async (toolName, args) => {
    if (toolName === 'Deploy' && (args as any).environment === 'production') {
      const answer = await promptUser('Deploy to PRODUCTION? [yes/no] ');
      return answer === 'yes';
    }
    return true;
  },
});
```

**Use case:** Integrating with internal systems, APIs, or custom workflows.

---

### Context Compression Configuration

Handle very long conversations without hitting the context limit:

```typescript
const agent = await createAgent({
  model,
  cwd: process.cwd(),
  maxContextTokens: 100_000,
  compressionStrategy: 'truncate', // drop oldest turns when >80% full
});
```

With `'summarize'` strategy, the agent will first generate a summary of the content it's about to drop, preserving important context in condensed form.

**Use case:** Long-running conversations, document analysis, or multi-step tasks.

---

## Embedding the core in a non-Node host

→ See [`docs/embedding-core.md`](./embedding-core.md) for the full guide.

The short version: `src/core/` has no `node:*` imports. You can import `createAgentCore` from `@researchcomputer/agents-sdk/core` and supply your own `CoreAdapters` implementations, or build `core.wasm` via `npm run build:wasm` and embed it as a WebAssembly Component. [`examples/python-stub/`](../examples/python-stub) is the reference implementation for the WASM path.

**Use case:** Running the agent loop in WASM/browser sandboxes, from Python, or in deterministic replay harnesses where ai-provider and the Node filesystem are unavailable.

## See Also

- [Getting Started](./getting-started.md) — Installation and basic configuration
- [Core Concepts](./concepts.md) — Architecture and design patterns
- [API Reference](./api-reference.md) — Complete type and function documentation
