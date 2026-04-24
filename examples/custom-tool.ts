/**
 * Custom tool example.
 *
 * Defines a `Deploy` tool alongside the default tool set, then wires an
 * `onPermissionAsk` callback that only auto-approves staging deploys —
 * production deploys would prompt in a real app (we just log and deny
 * here to keep the example non-interactive).
 *
 * The tool does NOT actually deploy anything — it just returns a string.
 * Swap the body of `execute` for your real deploy logic.
 *
 * Usage:
 *   npx tsx examples/custom-tool.ts
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
import { Type, type Static } from '@sinclair/typebox';
import { createAgent, getAllTools } from '../src/node/index.js';
import type { SdkTool } from '../src/node/index.js';
import { resolveModel } from './_model.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-customtool-'));
console.log(`Scratch dir: ${scratch}\n`);

const DeployParams = Type.Object({
  environment: Type.Union(
    [Type.Literal('staging'), Type.Literal('production')],
    { description: 'Target deploy environment.' },
  ),
  service: Type.String({ description: 'Service name to deploy.' }),
});

const deployTool: SdkTool<typeof DeployParams> = {
  name: 'Deploy',
  label: 'Deploy a service',
  description:
    'Deploys the given service to the specified environment. ' +
    'Production deploys require explicit user approval.',
  parameters: DeployParams,
  // `process:spawn` because a real deploy would exec kubectl/etc.;
  // listing the capability lets permission rules target it generically.
  capabilities: ['process:spawn'],
  async execute(_id, params: Static<typeof DeployParams>) {
    const text = `[MOCK] Deployed '${params.service}' to ${params.environment}.`;
    return {
      content: [{ type: 'text', text }],
      details: params,
    };
  },
};

try {
  const agent = await createAgent({
    model: resolveModel(),
    cwd: scratch,
    // Defaults + our custom one. Defaults already provide Read/Write/Bash/etc.
    tools: [...getAllTools({ cwd: scratch }), deployTool],
    permissionMode: 'default',
    enableMemory: false,
    getApiKey: async () => process.env.OPENAI_API_KEY,
    onPermissionAsk: async (toolName, args) => {
      if (toolName !== 'Deploy') return true;
      const env = (args as { environment?: string }).environment;
      if (env === 'production') {
        // In a real CLI: prompt the user via readline.
        // Here we deny to keep the example non-interactive and deterministic.
        console.log(`[policy] Denying production deploy of ${(args as any).service}`);
        return false;
      }
      console.log(`[policy] Auto-approving staging deploy of ${(args as any).service}`);
      return true;
    },
  });

  await agent.prompt(
    'Please deploy the "checkout-service" to both staging and production, ' +
    'in that order. Report what happened for each.',
  );

  const last = agent.agent.state.messages
    .filter((m: any) => m.role === 'assistant').at(-1);
  console.log('\n--- Agent report ---');
  console.log((last?.content as any[])?.[0]?.text ?? '');

  await agent.dispose();
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
