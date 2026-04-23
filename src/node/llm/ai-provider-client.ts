import { streamSimple, completeN } from '@researchcomputer/ai-provider';
import type { LlmClient } from '../../core/llm/client.js';

/**
 * Node default LlmClient: delegates to @researchcomputer/ai-provider.
 * streamSimple matches StreamFn's shape by construction (StreamFn is
 * `Parameters<typeof streamSimple> -> ReturnType<typeof streamSimple>`).
 */
export function createAiProviderLlmClient(): LlmClient {
  return {
    stream: streamSimple,
    completeN,
  };
}
