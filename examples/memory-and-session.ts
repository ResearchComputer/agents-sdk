/**
 * Memory + session persistence example.
 *
 * Runs two agent "sessions" back-to-back in a scratch temp directory to
 * show that:
 *   1. Memories written by the first session survive into the second
 *      (filesystem-backed MemoryStore).
 *   2. Session snapshots saved on dispose() can be resumed by passing
 *      the session id back in on the next createAgent() call.
 *
 * In a real app these two runs would be separate process invocations; we
 * collapse them here so the whole lifecycle fits in one script.
 *
 * Usage:
 *   npx tsx examples/memory-and-session.ts
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-memory-session-'));
const memoryDir = path.join(scratch, 'memory');
const sessionDir = path.join(scratch, 'sessions');
console.log(`Scratch dir: ${scratch}\n`);

try {
  // ── Session 1 ─────────────────────────────────────────────────────────
  console.log('--- Session 1 ---');
  const agent1 = await createAgent({
    model: resolveModel(),
    cwd: scratch,
    memoryDir,
    sessionDir,
    enableMemory: true,
    permissionMode: 'allowAll',
    getApiKey: async () => process.env.OPENAI_API_KEY,
  });

  // Teach the agent a project-specific fact by saving a memory directly.
  await agent1.memory.save({
    name: 'preferred-logger',
    description: 'Which logging library this codebase uses',
    type: 'project',
    content: 'This project uses pino for all logging. Prefer pino.info() over console.log.',
  });

  await agent1.prompt('What logging library should I use when adding new code here?');
  const ans1 = agent1.agent.state.messages
    .filter((m: any) => m.role === 'assistant').at(-1);
  console.log((ans1?.content as any[])?.[0]?.text ?? '');

  await agent1.dispose(); // persists session to sessionDir

  // Grab the most recent session id to resume.
  const sessions = await agent1.sessions.list();
  const resumedId = sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
  if (!resumedId) throw new Error('no session was persisted');
  console.log(`\nPersisted session id: ${resumedId}\n`);

  // ── Session 2 (fresh agent, same memory + session dirs) ──────────────
  console.log('--- Session 2 (resumed) ---');
  const agent2 = await createAgent({
    model: resolveModel(),
    cwd: scratch,
    memoryDir,
    sessionDir,
    sessionId: resumedId,
    enableMemory: true,
    permissionMode: 'allowAll',
    getApiKey: async () => process.env.OPENAI_API_KEY,
  });

  // Memory round-trip check: the on-disk markdown file written by
  // agent1 should load cleanly in agent2.
  const loaded = await agent2.memory.load();
  console.log(`Memories on disk: ${loaded.map((m) => m.name).join(', ') || '(none)'}`);

  // Same question — the resumed agent should still know the answer,
  // both from the replayed trajectory and the re-injected memory.
  await agent2.prompt('Remind me which logger this codebase prefers, in one line.');
  const ans2 = agent2.agent.state.messages
    .filter((m: any) => m.role === 'assistant').at(-1);
  console.log((ans2?.content as any[])?.[0]?.text ?? '');

  await agent2.dispose();
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
