/**
 * Auto-fork example.
 *
 * Demonstrates the `autoFork` config option, which automatically spawns
 * N alternative branches after every LLM turn. Each batch of branches is
 * scored and the best response is printed.
 *
 * Usage:
 *   npx tsx examples/auto-fork.ts
 *
 * Requires OPENAI_API_KEY (or whichever provider you configure).
 */
import { createAgent } from '../src/node/index.js';
import { getModel } from '@researchcomputer/ai-provider';
import type { Agent } from '../src/node/index.js';

const model = getModel('openai', 'gpt-4o-mini');

interface ForkResult {
  turnIndex: number;
  branches: Agent[];
  bestIndex: number;
  bestLength: number;
}

const results: ForkResult[] = [];
let turnIndex = 0;

const agent = await createAgent({
  model,
  cwd: process.cwd(),
  permissionMode: 'allowAll',
  enableMemory: false,
  autoFork: {
    branches: 3,
    onBranches: async (children) => {
      // Score each branch by response length (simple heuristic)
      let bestIdx = 0;
      let bestLen = 0;

      for (const [i, child] of children.entries()) {
        const msgs = child.agent.state.messages;
        const lastAssistant = msgs.filter((m: any) => m.role === 'assistant').at(-1);
        const text = (lastAssistant?.content as any[])?.[0]?.text ?? '';
        if (text.length > bestLen) {
          bestIdx = i;
          bestLen = text.length;
        }
      }

      results.push({
        turnIndex: turnIndex++,
        branches: children,
        bestIndex: bestIdx,
        bestLength: bestLen,
      });
    },
  },
});

// Each prompt triggers an LLM turn, which triggers an auto-fork
console.log('--- Turn 1: Building context ---');
await agent.prompt('You are helping me design a REST API for a task management app.');

console.log('--- Turn 2: Generating endpoints ---');
await agent.prompt('List the core endpoints with HTTP methods and brief descriptions.');

// Wait a moment for async forks to settle
await new Promise((resolve) => setTimeout(resolve, 2000));

// Report results
console.log(`\n=== Auto-Fork Results ===`);
console.log(`Total turns forked: ${results.length}`);

for (const r of results) {
  console.log(`\nTurn ${r.turnIndex}: best branch = ${r.bestIndex} (${r.bestLength} chars)`);

  // Print the best branch's response
  const best = r.branches[r.bestIndex];
  const lastMsg = best.agent.state.messages
    .filter((m: any) => m.role === 'assistant').at(-1);
  const text = (lastMsg?.content as any[])?.[0]?.text ?? '';
  console.log(text.slice(0, 300));
  if (text.length > 300) console.log('...');
}

// Clean up all branches
for (const r of results) {
  for (const b of r.branches) await b.dispose();
}
await agent.dispose();
