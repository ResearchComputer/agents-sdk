/**
 * Fork-from-snapshot example.
 *
 * Demonstrates `forkFrom()`: the parent builds context, takes a snapshot,
 * continues working, then forks N branches from the earlier snapshot.
 * The parent's state is unaffected by the fork.
 *
 * Usage:
 *   npx tsx examples/fork-from-snapshot.ts
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

// Step 1: Build shared analysis context
console.log('--- Step 1: Shared analysis ---');
await agent.prompt(
  'You are helping me plan a CLI tool written in TypeScript. ' +
  'The tool should parse command-line arguments, read a config file, and output results as JSON.',
);

// Step 2: Snapshot the analysis
const analysisSnapshot = agent.snapshot();
console.log(`Snapshot taken (id: ${analysisSnapshot.id}, ${analysisSnapshot.messages.length} messages)\n`);

// Step 3: Parent continues down one path (argument parsing)
console.log('--- Parent path: argument parsing ---');
await agent.prompt('Design the argument parsing module. What library should we use and why?');

const parentMsg = agent.agent.state.messages
  .filter((m: any) => m.role === 'assistant').at(-1);
console.log((parentMsg?.content as any[])?.[0]?.text?.slice(0, 200) ?? '');
console.log(`Parent now has ${agent.agent.state.messages.length} messages\n`);

// Step 4: Fork from the earlier snapshot to explore config file handling
console.log('--- Forking 2 branches from snapshot for config file design ---');
const configBranches = await agent.forkFrom(
  analysisSnapshot,
  'Design the config file module. Compare YAML vs TOML vs JSON for the config format.',
  2,
);

for (const [i, branch] of configBranches.entries()) {
  const msgs = branch.agent.state.messages;
  const last = msgs.filter((m: any) => m.role === 'assistant').at(-1);
  const text = (last?.content as any[])?.[0]?.text ?? '';
  console.log(`\nBranch ${i} (${msgs.length} messages, ${text.length} chars):`);
  console.log(text.slice(0, 200));
  if (text.length > 200) console.log('...');
}

// Parent state is unchanged — still has the argument parsing work
console.log(`\nParent still has ${agent.agent.state.messages.length} messages (unchanged)`);

// Clean up
for (const b of configBranches) await b.dispose();
await agent.dispose();
