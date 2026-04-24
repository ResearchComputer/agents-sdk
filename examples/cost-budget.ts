/**
 * Cost & budget tracking example.
 *
 * Runs a short series of prompts against the agent, checks the running
 * cost between turns, and stops early when a soft budget is exceeded.
 * At the end prints a per-model breakdown via `costTracker.perModel()`.
 *
 * Usage:
 *   npx tsx examples/cost-budget.ts
 *
 * Environment variables:
 *   OPENAI_API_KEY  - required
 *   MODEL_ID        - optional (default: gpt-4o-mini)
 *   OPENAI_BASE_URL - optional; point at an OpenAI-compatible endpoint
 *                     (use this when MODEL_ID isn't a hosted OpenAI model)
 *   MAX_COST_USD    - optional (default: 0.05) - soft cap; check happens between turns
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgent } from '../src/node/index.js';
import { resolveModel } from './_model.js';

const maxCostUsd = Number(process.env.MAX_COST_USD ?? '0.05');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-budget-'));
console.log(`Scratch dir: ${scratch}`);
console.log(`Budget cap:  $${maxCostUsd.toFixed(4)}\n`);

const prompts = [
  'Give me a one-sentence definition of dependency injection.',
  'Give me a one-sentence definition of a monad (for programmers).',
  'Give me a one-sentence definition of an interpreter vs compiler.',
  'Give me a one-sentence definition of eventual consistency.',
  'Give me a one-sentence definition of CRDTs.',
];

try {
  const agent = await createAgent({
    model: resolveModel(),
    cwd: scratch,
    permissionMode: 'allowAll',
    enableMemory: false,
    getApiKey: async () => process.env.OPENAI_API_KEY,
  });

  for (const [i, prompt] of prompts.entries()) {
    const { cost: before } = agent.costTracker.total();
    if (before >= maxCostUsd) {
      console.log(`\n[budget] cap reached ($${before.toFixed(4)} >= $${maxCostUsd.toFixed(4)}); stopping at prompt ${i}/${prompts.length}`);
      break;
    }

    await agent.prompt(prompt);

    const { tokens, cost } = agent.costTracker.total();
    const last = agent.agent.state.messages
      .filter((m: any) => m.role === 'assistant').at(-1);
    const text = (last?.content as any[])?.[0]?.text ?? '';
    console.log(`[${i + 1}/${prompts.length}] tokens=${tokens} cost=$${cost.toFixed(6)}`);
    console.log(`     Q: ${prompt}`);
    console.log(`     A: ${text.replace(/\s+/g, ' ').slice(0, 140)}`);
  }

  // Final report
  const total = agent.costTracker.total();
  console.log(`\n=== Final ===`);
  console.log(`Tokens: ${total.tokens}`);
  console.log(`Cost:   $${total.cost.toFixed(6)}`);
  console.log(`Per model:`);
  for (const [id, usage] of agent.costTracker.perModel()) {
    console.log(`  ${id.padEnd(30)} ${String(usage.tokens).padStart(8)} tokens  $${usage.cost.toFixed(6)}`);
  }

  await agent.dispose();
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
