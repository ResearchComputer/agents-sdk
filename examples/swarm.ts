/**
 * Multi-agent swarm example.
 *
 * Enables swarm mode so the top-level agent gets the `SpawnTeammate`
 * tool. The system prompt primes it as a team lead that delegates
 * codebase scanning to a researcher teammate, then synthesizes a report.
 *
 * The scratch temp directory is seeded with a small fake "codebase" so
 * the teammate has something concrete to read.
 *
 * Usage:
 *   npx tsx examples/swarm.ts
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-swarm-'));
console.log(`Scratch dir: ${scratch}\n`);

// Seed a tiny codebase for the teammate to explore.
fs.mkdirSync(path.join(scratch, 'src'));
fs.writeFileSync(
  path.join(scratch, 'src/db.ts'),
  [
    'export class Database {',
    '  // Uses a simple connection pool.',
    '  constructor(public readonly url: string) {}',
    '  async query<T>(sql: string): Promise<T[]> { return [] as T[]; }',
    '}',
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(scratch, 'src/cache.ts'),
  [
    'export class Cache {',
    '  // LRU with a 10k-entry ceiling.',
    '  private store = new Map<string, unknown>();',
    '  get(k: string) { return this.store.get(k); }',
    '  set(k: string, v: unknown) { this.store.set(k, v); }',
    '}',
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(scratch, 'src/api.ts'),
  [
    'import { Database } from "./db.js";',
    'import { Cache } from "./cache.js";',
    'export class Api {',
    '  constructor(private db: Database, private cache: Cache) {}',
    '  async getUser(id: string) {',
    '    const hit = this.cache.get(id);',
    '    if (hit) return hit;',
    '    const [u] = await this.db.query<{ id: string }>(`select * from users where id=${id}`);',
    '    this.cache.set(id, u);',
    '    return u;',
    '  }',
    '}',
    '',
  ].join('\n'),
);

try {
  const agent = await createAgent({
    model: resolveModel(),
    cwd: scratch,
    permissionMode: 'allowAll',
    enableMemory: false,
    enableSwarm: true,
    systemPrompt: [
      'You are a team lead reviewing an unfamiliar codebase.',
      'You have one SpawnTeammate tool available. When asked to analyze a codebase:',
      '  1. Spawn a single "researcher" teammate with a clear, bounded task ' +
      '(e.g. "list every file under src/ and summarize each in one line"), and a small budget.',
      '  2. When the researcher reports back, synthesize a short architectural summary for the user.',
      'Do not read files yourself — delegate to the researcher.',
    ].join('\n'),
    getApiKey: async () => process.env.OPENAI_API_KEY,
  });

  await agent.prompt(
    'Analyze the architecture of this project in three bullet points: what modules exist, ' +
    'how they depend on each other, and one risk you notice.',
  );

  const last = agent.agent.state.messages
    .filter((m: any) => m.role === 'assistant').at(-1);
  console.log('--- Leader summary ---');
  console.log((last?.content as any[])?.[0]?.text ?? '');

  await agent.dispose();
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
