/**
 * Read-only agent example.
 *
 * Builds an agent whose tool surface is limited to Read / Glob / Grep — no
 * writes, no shell, no network. Useful for inspection tasks (code review,
 * documentation generation, audits) where you want to mathematically rule
 * out mutation.
 *
 * A scratch temp directory is seeded with a tiny sample project so the
 * agent has something to explore without touching the real repo.
 *
 * Usage:
 *   npx tsx examples/read-only.ts
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
import {
  createAgent,
  createReadTool,
  createGlobTool,
  createGrepTool,
} from '../src/node/index.js';
import { resolveModel } from './_model.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-readonly-'));
console.log(`Scratch dir: ${scratch}\n`);

// Seed a tiny sample project for the agent to explore.
fs.mkdirSync(path.join(scratch, 'src'));
fs.writeFileSync(
  path.join(scratch, 'src/auth.ts'),
  [
    'export function login(user: string, password: string) {',
    '  // TODO: hash the password before comparing',
    '  return user === "admin" && password === "admin";',
    '}',
    '',
    'export function logout() {',
    '  // TODO: invalidate the session token',
    '}',
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(scratch, 'src/api.ts'),
  [
    'export async function fetchUser(id: string) {',
    '  // TODO: add retry logic for 5xx responses',
    '  const res = await fetch(`/users/${id}`);',
    '  return res.json();',
    '}',
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(scratch, 'README.md'),
  '# Sample Project\n\nA tiny fixture for the read-only example.\n',
);

try {
  const agent = await createAgent({
    model: resolveModel(),
    cwd: scratch,
    // Only allow the three read-only tools. No Write/Edit/Bash/WebFetch.
    tools: [
      createReadTool({ cwd: scratch }),
      createGlobTool({ cwd: scratch }),
      createGrepTool({ cwd: scratch }),
    ],
    permissionMode: 'allowAll',
    enableMemory: false,
    getApiKey: async () => process.env.OPENAI_API_KEY,
  });

  await agent.prompt(
    'Find every TODO comment in this project and produce a bullet list: ' +
    'file:line — the TODO text. Do not modify anything.',
  );

  const last = agent.agent.state.messages
    .filter((m: any) => m.role === 'assistant').at(-1);
  const text = (last?.content as any[])?.[0]?.text ?? '';
  console.log(text);

  await agent.dispose();
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
