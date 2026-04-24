/**
 * Quickstart example.
 *
 * The shortest path from zero to a running agent: create one, send a prompt,
 * stream the response, dispose. Runs in a scratch temp directory so the
 * agent's cwd is an empty sandbox.
 *
 * Usage:
 *   npx tsx examples/quickstart.ts
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-quickstart-'));
console.log(`Scratch dir: ${scratch}\n`);

try {
  const agent = await createAgent({
    model: resolveModel(),
    cwd: scratch,
    permissionMode: 'allowAll',
    enableMemory: false,
    getApiKey: async () => process.env.OPENAI_API_KEY,
  });

  // Stream assistant text as it arrives
  agent.agent.subscribe((event: any) => {
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'text_delta'
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  await agent.prompt('In one sentence, what is an LLM agent?');
  console.log(); // trailing newline after streamed output

  await agent.dispose();
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
