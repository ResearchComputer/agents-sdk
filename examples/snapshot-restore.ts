/**
 * Snapshot & restore example.
 *
 * Demonstrates checkpointing an agent, trying something, then rolling back
 * and trying a different approach from the same starting point.
 *
 * Usage:
 *   npx tsx examples/snapshot-restore.ts
 *
 * Requires OPENAI_API_KEY (or whichever provider you configure).
 */
import { createAgent } from '../src/index.js';
import { getModel } from '@researchcomputer/ai-provider';

const model = getModel('openai', 'gpt-4o-mini');

const agent = await createAgent({
  model,
  cwd: process.cwd(),
  permissionMode: 'allowAll',
  enableMemory: false,
});

// Step 1: Build shared context
console.log('--- Building context ---');
await agent.prompt('You are helping me name a new open-source CLI tool for managing dotfiles.');

// Step 2: Checkpoint
const checkpoint = agent.snapshot();
console.log(`Snapshot taken (id: ${checkpoint.id}, ${checkpoint.messages.length} messages)\n`);

// Step 3: Try approach A
console.log('--- Attempt A: playful names ---');
await agent.prompt('Suggest 5 playful, fun names');
const attemptA = agent.agent.state.messages
  .filter((m: any) => m.role === 'assistant')
  .at(-1);
console.log((attemptA?.content as any[])?.[0]?.text ?? '');

// Step 4: Roll back and try approach B
console.log('\n--- Rolling back to checkpoint ---');
agent.restore(checkpoint);
console.log(`Restored to ${agent.agent.state.messages.length} messages\n`);

console.log('--- Attempt B: professional names ---');
await agent.prompt('Suggest 5 professional, serious names');
const attemptB = agent.agent.state.messages
  .filter((m: any) => m.role === 'assistant')
  .at(-1);
console.log((attemptB?.content as any[])?.[0]?.text ?? '');

await agent.dispose();
