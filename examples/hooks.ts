/**
 * Hooks example: audit logging + command blocking.
 *
 * Registers three `HookHandler`s on the agent:
 *   1. PreToolUse  (no matcher) — appends a JSONL audit entry before every tool call
 *   2. PostToolUse (no matcher) — appends a JSONL audit entry after every tool call
 *   3. PreToolUse  (matcher: 'Bash') — throws if the command looks like `rm ...`,
 *      aborting that specific tool call. The agent sees the thrown error as a
 *      tool failure and can react (apologize, try a different approach, etc.).
 *
 * Everything happens in a scratch temp directory, including the audit log.
 *
 * Usage:
 *   npx tsx examples/hooks.ts
 *
 * Environment variables:
 *   OPENAI_API_KEY - required
 *   MODEL_ID        - optional (default: gpt-4o-mini)
 *   OPENAI_BASE_URL - optional; point at an OpenAI-compatible endpoint
 *                     (use this when MODEL_ID isn't a hosted OpenAI model)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgent } from '../src/node/index.js';
import { resolveModel } from './_model.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hooks-'));
const auditPath = path.join(scratch, 'audit.jsonl');
console.log(`Scratch dir: ${scratch}`);
console.log(`Audit log:   ${auditPath}\n`);

// Seed a file the agent can legitimately read.
fs.writeFileSync(path.join(scratch, 'note.txt'), 'important\n');

try {
  const agent = await createAgent({
    model: resolveModel(),
    cwd: scratch,
    permissionMode: 'allowAll',
    enableMemory: false,
    getApiKey: async () => process.env.OPENAI_API_KEY,
    hooks: [
      {
        event: 'PreToolUse',
        handler: async ({ toolName, toolArgs }) => {
          fs.appendFileSync(
            auditPath,
            JSON.stringify({
              ts: Date.now(),
              phase: 'pre',
              tool: toolName,
              args: toolArgs,
            }) + '\n',
          );
        },
      },
      {
        event: 'PostToolUse',
        handler: async ({ toolName, toolResult }) => {
          fs.appendFileSync(
            auditPath,
            JSON.stringify({
              ts: Date.now(),
              phase: 'post',
              tool: toolName,
              // Don't dump the full tool result — just its size class.
              resultLen: JSON.stringify(toolResult ?? {}).length,
            }) + '\n',
          );
        },
      },
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        handler: async ({ toolArgs }) => {
          const cmd = (toolArgs as { command?: string }).command ?? '';
          if (/\brm\b/.test(cmd)) {
            throw new Error(
              `Blocked by policy: rm is not allowed in this agent (got: ${cmd})`,
            );
          }
        },
      },
    ],
  });

  // Ask the agent to do something benign (which the hooks will audit)
  // and something forbidden (which the Bash-matcher hook will veto).
  await agent.prompt(
    'First, read note.txt and tell me what it says. Then try to delete it ' +
    'with `rm note.txt` — I expect that to fail. Report both outcomes.',
  );

  const last = agent.agent.state.messages
    .filter((m: any) => m.role === 'assistant').at(-1);
  console.log('--- Agent summary ---');
  console.log((last?.content as any[])?.[0]?.text ?? '');
  console.log();

  // Show the audit trail.
  console.log('--- Audit trail ---');
  if (fs.existsSync(auditPath)) {
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
    console.log(`${lines.length} entries`);
    for (const line of lines) {
      const rec = JSON.parse(line);
      const detail = rec.phase === 'pre'
        ? JSON.stringify(rec.args).slice(0, 80)
        : `result=${rec.resultLen}B`;
      console.log(`  ${rec.phase.toUpperCase().padEnd(4)} ${rec.tool.padEnd(10)} ${detail}`);
    }
  }

  // Confirm the file survived.
  console.log(`\nnote.txt still present: ${fs.existsSync(path.join(scratch, 'note.txt'))}`);

  await agent.dispose();
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
