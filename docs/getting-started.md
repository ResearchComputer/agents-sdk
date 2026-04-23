# Getting Started

> *Audience: Node.js developers using `@researchcomputer/agents-sdk` as a library. For non-Node hosts, see [Embedding the Core](./embedding-core.md).*

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Authentication](#authentication)
- [Configuration](#configuration)
- [Built-in Tools](#built-in-tools)
- [Permission Modes](#permission-modes)
- [Memory](#memory)
- [Sessions](#sessions)
- [MCP Servers](#mcp-servers)
- [Snapshot & Fork](#snapshot--fork)
- [Skills](#skills)
- [Multi-Agent Swarm](#multi-agent-swarm)
- [Cost Tracking](#cost-tracking)
- [Troubleshooting](#troubleshooting)

---

## Requirements

- **Node.js** >= 20.0.0
- **npm** or compatible package manager (yarn, pnpm)
- **API Key** for your chosen LLM provider (OpenAI, Anthropic, etc.)

## Installation

Install the SDK and the AI provider package:

```bash
npm install @researchcomputer/agents-sdk @researchcomputer/ai-provider
```

### Setting Up API Keys

For direct provider access, set your API key as an environment variable:

```bash
# OpenAI
export OPENAI_API_KEY=sk-...

# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# Or use a .env file with dotenv
```

If you prefer hosted login instead of provider-specific keys, see [Authentication](#authentication).

## Quick Start

### Minimal Agent

```typescript
import { createAgent } from '@researchcomputer/agents-sdk';
import { getModel } from '@researchcomputer/ai-provider';

const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  cwd: process.cwd(),
  getApiKey: async () => process.env.OPENAI_API_KEY,
});

await agent.prompt('What files are in the current directory?');
await agent.dispose();
```

### With Images

```typescript
import { readFileSync } from 'fs';

const imageData = readFileSync('./diagram.png').toString('base64');

await agent.prompt('What does this diagram show?', [
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } }
]);
```

### Interactive Agent

```typescript
import * as readline from 'readline/promises';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  cwd: process.cwd(),
  getApiKey: async () => process.env.OPENAI_API_KEY,
  onQuestion: async (question) => {
    return rl.question(`Agent asks: ${question}\nYour answer: `);
  },
});

await agent.prompt('Help me debug this code');
await agent.dispose();
rl.close();
```

---

## Authentication

The SDK supports two auth modes:

1. Provider API keys passed through `getApiKey`.
2. Hosted login/session auth using `initiateLogin()` and a stored session in `~/.rc-agents/auth.json`.

### Provider API Keys

Use `getApiKey` when you want to call the model provider directly:

```typescript
const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
  getApiKey: async (provider) => {
    if (provider === 'openai') return process.env.OPENAI_API_KEY;
    if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
    return undefined;
  },
});
```

### Hosted Login

Use the hosted login flow when your deployment expects Research Computer auth tokens instead of raw provider keys.

Required environment variables:

```bash
export RC_LLM_PROXY_URL=https://api.research.computer
export STYTCH_PUBLIC_TOKEN=public-token-...
```

Login once:

```typescript
import { initiateLogin } from '@researchcomputer/agents-sdk';

await initiateLogin();
```

That opens a browser, exchanges the returned Stytch token at `RC_LLM_PROXY_URL`, and saves the session to `~/.rc-agents/auth.json`.

Then create agents without providing `getApiKey`:

```typescript
import { createAgent, getSession } from '@researchcomputer/agents-sdk';

const session = await getSession(); // refreshes automatically when expiry is near
console.log(session?.email);

const agent = await createAgent({
  model: getModel('openai', 'gpt-4o'),
});
```

When `getApiKey` is not provided, `createAgent()` resolves auth in this order:

1. `config.authToken`
2. `RC_AUTH_TOKEN`
3. `~/.rc-agents/auth.json` via `getSession()`
4. Legacy telemetry API key fallbacks

If no auth source is available, it throws `AuthRequiredError`.

### Logout

```typescript
import { logout } from '@researchcomputer/agents-sdk';

await logout();
```

`logout()` best-effort revokes the stored `sessionToken` through `RC_LLM_PROXY_URL/auth/stytch/revoke`, then deletes `~/.rc-agents/auth.json`.

---

## Configuration

`createAgent` returns a `Agent` that wraps the underlying agent with helpers for prompting, session management, memory, MCP, and cost tracking. Call `dispose()` when done to flush sessions and disconnect MCP servers.

### Full Configuration Example

```typescript
const agent = await createAgent({
  // Required
  model: getModel('openai', 'gpt-4o'),
  
  // Optional: Working directory (defaults to process.cwd())
  cwd: '/path/to/project',
  
  // Optional: Custom system prompt
  systemPrompt: 'You are a helpful coding assistant...',
  
  // Optional: Tool configuration
  tools: getAllTools({ cwd: '/path/to/project' }),
  
  // Optional: Permission configuration
  permissionMode: 'default',
  permissionRules: [
    { target: { type: 'capability', capability: 'fs:read' }, behavior: 'allow', source: 'user' },
  ],
  onPermissionAsk: async (toolName, args) => {
    // Handle interactive permission prompts
    return true; // or false
  },
  
  // Optional: Memory configuration
  enableMemory: true,
  memoryDir: './agent-memory',
  
  // Optional: Session configuration
  sessionDir: './agent-sessions',
  sessionId: 'previous-session-id', // Resume existing session
  
  // Optional: MCP servers
  mcpServers: [
    {
      name: 'git',
      transport: 'stdio',
      command: 'mcp-server-git',
      args: ['--repository', process.cwd()],
    },
  ],
  
  // Optional: Hooks
  hooks: [
    {
      event: 'PreToolUse',
      handler: async ({ toolName, toolArgs }) => {
        console.log(`Running tool: ${toolName}`);
        return {};
      },
    },
  ],
  
  // Optional: Context compression
  maxContextTokens: 100000,
  compressionStrategy: 'truncate', // or 'summarize'
  
  // Optional: Multi-agent swarm
  enableSwarm: false,
  
  // Optional: Cost tracking callback
  getApiKey: async (provider) => process.env[`${provider.toUpperCase()}_API_KEY`],

  // Optional: Explicit auth token for hosted/proxy auth
  authToken: process.env.RC_AUTH_TOKEN,

  // Optional: Telemetry — pass `false` to opt out, or override endpoint/apiKey
  telemetry: { endpoint: 'https://telemetry.example.com', captureTrajectory: false },
  // telemetry: false,  // opt out entirely
});
```

---

## Built-in Tools

The SDK ships with tools that are included by default:

| Tool | What it does | Capabilities required |
|---|---|---|
| `Read` | Read files with optional line range | `fs:read` |
| `Write` | Create or overwrite files | `fs:write` |
| `Edit` | Replace strings within a file | `fs:write` |
| `Glob` | Find files by glob pattern | `fs:read` |
| `Grep` | Search file contents with ripgrep | `fs:read` |
| `Bash` | Run shell commands | `process:spawn`, `fs:write`, `network:egress` |
| `WebFetch` | Fetch URL as text | `network:egress` |
| `WebSearch` | Web search (requires configuration) | `network:egress` |
| `NotebookEdit` | Edit Jupyter notebook cells | `fs:write` |
| `AskUser` | Ask a question and wait for user input | — |

### Customizing Tool Sets

You can replace the default set by passing `tools` in the config:

```typescript
import { createReadTool, createBashTool, getAllTools } from '@researchcomputer/agents-sdk';

// All built-in tools
const agent = await createAgent({ 
  model, 
  tools: getAllTools({ cwd }) 
});

// Only specific tools (read-only agent)
const agent = await createAgent({
  model,
  tools: [
    createReadTool({ cwd }),
    createGlobTool({ cwd }),
    createGrepTool({ cwd }),
  ],
});
```

---

## Permission Modes

Control what the agent can do without asking:

### Mode: `default` (Recommended)

Allows reads freely, asks before writes and shell commands:

```typescript
const agent = await createAgent({ 
  model, 
  permissionMode: 'default' 
});
```

### Mode: `allowAll`

Skip all permission checks (useful for trusted environments):

```typescript
const agent = await createAgent({ 
  model, 
  permissionMode: 'allowAll' 
});
```

### Mode: `rulesOnly`

Deny anything not explicitly allowed by rules:

```typescript
const agent = await createAgent({ 
  model, 
  permissionMode: 'rulesOnly',
  permissionRules: [
    { target: { type: 'capability', capability: 'fs:read' }, behavior: 'allow', source: 'user' },
    { target: { type: 'tool', name: 'Bash' }, behavior: 'deny', source: 'user' },
  ],
});
```

### Interactive Permission Prompts

Supply `onPermissionAsk` to handle interactive prompts:

```typescript
const agent = await createAgent({
  model,
  permissionMode: 'default',
  onPermissionAsk: async (toolName, args) => {
    const answer = await readline(`Allow ${toolName}? [y/n] `);
    return answer === 'y';
  },
});
```

---

## Memory

Memory is enabled by default (`enableMemory: true`). The agent can remember things across sessions using Markdown files with YAML frontmatter, stored in `memoryDir` (defaults to `~/.rc-agents/memory`).

### Memory File Format

Create a memory file at `~/.rc-agents/memory/user-preferences.md`:

```markdown
---
name: user-preferences
description: User's coding preferences and expertise
type: user
---

The user prefers TypeScript over JavaScript.
They are experienced with React and Node.js.
They like concise explanations without unnecessary preamble.
```

### Configuration

```typescript
const agent = await createAgent({
  model,
  // enableMemory: true,        // already the default
  memoryDir: '/home/user/.rc-agents/memory',
});
```

To disable memory:

```typescript
const agent = await createAgent({
  model,
  enableMemory: false,
});
```

Memories are retrieved automatically based on relevance to the current conversation.

---

## Sessions

Resume a previous conversation by passing a `sessionId`:

```typescript
// Start a session and record the ID
const agent = await createAgent({ model, sessionDir: './sessions' });
await agent.prompt('Let\'s build a feature...');
const sessions = await agent.sessions.list();
const id = sessions[0]?.id; // save this
await agent.dispose();

// Resume later
const agent2 = await createAgent({
  model,
  sessionDir: './sessions',
  sessionId: id,
});
await agent2.prompt('What were we working on?'); // Has context from previous session
```

---

## MCP Servers

Connect external tool servers via the Model Context Protocol:

```typescript
const agent = await createAgent({
  model,
  mcpServers: [
    {
      name: 'git',
      transport: 'stdio',
      command: 'mcp-git',
      args: ['--repo', process.cwd()],
    },
    {
      name: 'browser',
      transport: 'sse',  // also supports 'http'
      url: 'http://localhost:3001/sse',
    },
  ],
  // Allow all git MCP tools
  permissionRules: [
    { target: { type: 'mcp', server: 'git' }, behavior: 'allow', source: 'user' },
  ],
});
```

MCP tools are named `mcp__<server>__<tool>` and are available alongside built-in tools.

### MCP Transport Types

| Transport | Use Case | Configuration |
|---|---|---|
| `stdio` | Local CLI tools | `command`, `args`, `env` |
| `sse` | Remote servers (Server-Sent Events) | `url`, `headers` |
| `http` | Remote servers (HTTP POST) | `url`, `headers` |

---

## Snapshot & Fork

Checkpoint agent state and branch into parallel explorations:

```typescript
// Checkpoint before a risky operation
const checkpoint = agent.snapshot();

await agent.prompt('Refactor the auth module');

// Not happy? Roll back
agent.restore(checkpoint);

// Or fork N parallel branches from the current state
const branches = await agent.fork('Propose a migration strategy', 3);

// Or fork from an earlier checkpoint
const branches2 = await agent.forkFrom(checkpoint, 'Try a different approach', 2);

// Clean up branches when done
for (const b of [...branches, ...branches2]) await b.dispose();
```

See [Examples](./examples.md#snapshot--restore) for more patterns.

---

## Skills

Skills are the extension mechanism for packaging reusable agent capabilities. Each skill can contribute tools, hooks, MCP servers, permission rules, and prompt sections:

```typescript
const agent = await createAgent({
  model,
  skills: [
    {
      id: 'my-skill',
      description: 'Provides custom analysis tools',
      promptSections: ['Always explain your reasoning step by step.'],
      tools: [myCustomTool],
      hooks: [myHook],
      mcpServers: [myMcpServer],
      permissionRules: [myRule],
    },
  ],
});
```

See [API Reference](./api-reference.md#skills-utilities) for the `composeAgentConfig` function.

---

## Multi-Agent Swarm

Enable swarm mode to let the agent spawn and coordinate sub-agents:

```typescript
const agent = await createAgent({
  model,
  enableSwarm: true,
});
```

When swarm is enabled, the agent gains `SpawnTeammate`, `SendMessage`, and `DismissTeammate` tools. The leader can delegate tasks, receive reports, and communicate with teammates in parallel.

See [Core Concepts](./concepts.md#swarm-multi-agent) for detailed documentation.

---

## Cost Tracking

Track token usage and estimated costs:

```typescript
await agent.prompt('Refactor this file');

const { tokens, cost } = agent.costTracker.total();
console.log(`Used ${tokens} tokens, cost $${cost.toFixed(4)}`);

for (const [modelId, usage] of agent.costTracker.perModel()) {
  console.log(`  ${modelId}: ${usage.tokens} tokens`);
}
```

---

## Troubleshooting

### "Cannot find module" errors

Make sure you're using ES modules. Your `package.json` should include:

```json
{
  "type": "module"
}
```

Or use `.mjs` file extensions.

### API Key errors

Ensure your API key is set correctly:

```bash
# Check if key is set
echo $OPENAI_API_KEY

# Set it if missing
export OPENAI_API_KEY=sk-...
```

### Permission denied errors

If you get permission errors when the agent tries to use tools:

1. Check your `permissionMode` setting
2. Add explicit `permissionRules` for the tools you want to allow
3. Provide an `onPermissionAsk` handler for interactive approval

### MCP connection errors

If MCP servers fail to connect:

1. Verify the command/path is correct
2. Check that the MCP server is installed (`npm install -g <server>` or `pip install <server>`)
3. Review the MCP server logs for errors
4. Check the `trustLevel` setting in your MCP config

### Context limit exceeded

If you hit token limits:

1. Increase `maxContextTokens` (default is 80% of model's context window)
2. Use `compressionStrategy: 'summarize'` for long conversations
3. Start a new session periodically

### TypeScript errors

If you see TypeScript errors:

1. Ensure you're using TypeScript >= 5.7.0
2. Check that your `tsconfig.json` has `"moduleResolution": "bundler"` or `"node"`
3. Make sure `@types/node` is installed

### AuthRequiredError

If `createAgent()` throws `AUTH_REQUIRED`:

1. Pass `getApiKey` for direct provider access, or
2. Set `RC_AUTH_TOKEN`, or
3. Run `initiateLogin()` after setting `RC_LLM_PROXY_URL` and `STYTCH_PUBLIC_TOKEN`

---

## Next Steps

- Explore [Core Concepts](./concepts.md) to understand the architecture and the core/node split
- Browse [Examples](./examples.md) for practical patterns, including [embedding the core](./examples.md#embedding-the-core-in-a-non-node-host) in non-Node hosts
- Read the [API Reference](./api-reference.md) for complete type documentation, the [Core factory](./api-reference.md#core-factory), and [Adapter interfaces](./api-reference.md#adapter-interfaces)
