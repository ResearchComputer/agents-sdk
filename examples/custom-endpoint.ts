/**
 * Custom OpenAI-compatible endpoint example.
 *
 * Shows how to point the SDK at any OpenAI-compatible API (Ollama, vLLM,
 * LiteLLM, Together, etc.) instead of a first-party provider.
 *
 * Usage:
 *   npx tsx examples/custom-endpoint.ts
 *
 * Environment variables:
 *   ENDPOINT   - Base URL of the OpenAI-compatible API (default: http://localhost:11434/v1)
 *   MODEL_ID   - Model identifier to request (default: llama3.2)
 *   API_KEY    - API key, if the endpoint requires one
 */
import { createAgent } from '../src/node/index.js';
import type { Model } from '@researchcomputer/ai-provider';

const endpoint = process.env.ENDPOINT ?? 'http://localhost:11434/v1';
const modelId = process.env.MODEL_ID ?? 'llama3.2';
const apiKey = process.env.API_KEY ?? '';

// Build a Model descriptor that targets the custom endpoint.
// Set `api` to 'openai-completions' for /v1/chat/completions or
// 'openai-responses' for /v1/responses.
const model: Model<any> = {
  id: modelId,
  name: modelId,
  api: 'openai-completions',
  provider: 'openai-compatible',
  baseUrl: endpoint,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_768,
};

const agent = await createAgent({
  model,
  cwd: process.cwd(),
  permissionMode: 'allowAll',
  enableMemory: false,
  getApiKey: async () => apiKey,
});

console.log(`Using ${modelId} via ${endpoint}\n`);

// Stream assistant text as it arrives
agent.agent.subscribe((event: any) => {
  if (
    event.type === 'message_update' &&
    event.assistantMessageEvent?.type === 'text_delta'
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt('List the files in the current directory and briefly describe what this project does.');
console.log(); // trailing newline after streamed output

await agent.dispose();
