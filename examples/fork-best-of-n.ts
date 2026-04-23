/**
 * Best-of-N fork example.
 *
 * Forks an agent into N branches exploring the same prompt in parallel,
 * then picks the branch with the longest (most detailed) response.
 *
 * Usage:
 *   npx tsx examples/fork-best-of-n.ts [N] [prompt]
 *
 * Requires OPENAI_API_KEY (or whichever provider you configure).
 */
import { createAgent } from '../src/index.js';
import { getModel } from '@researchcomputer/ai-provider';

const N = parseInt(process.argv[2] ?? '3', 10);
const prompt = process.argv[3] ?? 'List 5 creative project ideas for a weekend hackathon';

const model = getModel('openai', 'gpt-4o-mini');

const agent = await createAgent({
  model,
  cwd: process.cwd(),
  permissionMode: 'allowAll',
  enableMemory: false,
});

console.log(`Forking ${N} branches for: "${prompt}"\n`);

const branches = await agent.fork(prompt, N);

// Score each branch by response length
let bestIdx = 0;
let bestLen = 0;

for (const [i, branch] of branches.entries()) {
  const msgs = branch.agent.state.messages;
  const lastAssistant = msgs.filter((m: any) => m.role === 'assistant').at(-1);
  const text = (lastAssistant?.content as any[])?.[0]?.text ?? '';
  const len = text.length;

  console.log(`Branch ${i}: ${len} chars`);
  if (len > bestLen) {
    bestIdx = i;
    bestLen = len;
  }
}

console.log(`\nBest: Branch ${bestIdx} (${bestLen} chars)\n`);

const bestMsgs = branches[bestIdx].agent.state.messages;
const bestText = bestMsgs
  .filter((m: any) => m.role === 'assistant')
  .at(-1);
console.log((bestText?.content as any[])?.[0]?.text ?? '(no output)');

// Clean up
for (const branch of branches) await branch.dispose();
await agent.dispose();
