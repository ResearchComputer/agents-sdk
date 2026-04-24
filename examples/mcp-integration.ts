/**
 * MCP integration example.
 *
 * Connects the official `@modelcontextprotocol/server-filesystem` MCP
 * server via stdio and asks the agent to use it. Demonstrates:
 *   - `mcpServers` config with the stdio transport
 *   - Allowing MCP tools via a `permissionRules` entry that targets the
 *     whole server, so individual tool names don't need enumeration
 *   - Scoping the MCP server to a scratch temp directory so it cannot
 *     touch the user's real files
 *
 * Usage:
 *   npx tsx examples/mcp-integration.ts
 *
 * Environment variables:
 *   OPENAI_API_KEY - required
 *   MODEL_ID        - optional (default: gpt-4o-mini)
 *   OPENAI_BASE_URL - optional; point at an OpenAI-compatible endpoint
 *                     (use this when MODEL_ID isn't a hosted OpenAI model)
 *
 * Requires `npx` in PATH (the MCP server is fetched on demand).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgent } from '../src/node/index.js';
import { resolveModel } from './_model.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mcp-'));
console.log(`Scratch dir (MCP server sandbox): ${scratch}\n`);

// Seed a few files for the MCP server to list.
fs.writeFileSync(path.join(scratch, 'notes.md'), '# Notes\n\n- buy milk\n- ship PR\n');
fs.writeFileSync(path.join(scratch, 'todo.txt'), 'feed cat\nwater plants\n');
fs.mkdirSync(path.join(scratch, 'archive'));
fs.writeFileSync(path.join(scratch, 'archive/old.txt'), 'archived\n');

try {
  const agent = await createAgent({
    model: resolveModel(),
    cwd: scratch,
    // Don't load the built-in fs tools — we want the agent to reach the
    // filesystem via the MCP server so the example actually exercises MCP.
    tools: [],
    mcpServers: [
      {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', scratch],
      },
    ],
    permissionMode: 'rulesOnly',
    // One rule is enough — 'mcp' target with just `server` allows every
    // tool exposed by that server.
    permissionRules: [
      { target: { type: 'mcp', server: 'fs' }, behavior: 'allow', source: 'user' },
    ],
    enableMemory: false,
    getApiKey: async () => process.env.OPENAI_API_KEY,
  });

  await agent.prompt(
    'Use the filesystem MCP server to list every file (including inside ' +
    'subfolders), then summarize what each one contains.',
  );

  const last = agent.agent.state.messages
    .filter((m: any) => m.role === 'assistant').at(-1);
  console.log((last?.content as any[])?.[0]?.text ?? '');

  await agent.dispose();
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
