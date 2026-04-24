/**
 * Shared model resolver for the examples.
 *
 * Lets every example work against either the OpenAI API directly or any
 * OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM, a RC proxy, etc.)
 * without each file re-implementing the same env-var dance.
 *
 * Env vars:
 *   MODEL_ID         - model id (default: gpt-4o-mini)
 *   OPENAI_BASE_URL  - if set, use a Model<any> descriptor pointing at this
 *                      URL instead of looking up MODEL_ID in the OpenAI
 *                      registry. Useful when MODEL_ID isn't an OpenAI model.
 *
 * If OPENAI_BASE_URL is unset AND MODEL_ID isn't in the registry, throws
 * a clear error rather than a confusing downstream `undefined` crash.
 */
import { getModel, type Model } from '@researchcomputer/ai-provider';

export function resolveModel(): Model<any> {
  // Treat empty env vars as unset (common when a shell exports defaults).
  const modelId = process.env.MODEL_ID?.trim() || 'gpt-4o-mini';
  const baseUrl = process.env.OPENAI_BASE_URL?.trim() || undefined;

  if (baseUrl) {
    return {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: 'openai-compatible',
      baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 32_768,
    } as Model<any>;
  }

  // Look up in the OpenAI registry. `as any` because env-var strings
  // can't satisfy the generic literal-type constraint.
  const model = getModel('openai' as any, modelId as any) as Model<any> | undefined;
  if (!model) {
    throw new Error(
      `Model '${modelId}' is not a known OpenAI model. Either set MODEL_ID to ` +
      `a valid OpenAI model (e.g. 'gpt-4o-mini') or set OPENAI_BASE_URL to an ` +
      `OpenAI-compatible endpoint that serves '${modelId}'.`,
    );
  }
  return model;
}
