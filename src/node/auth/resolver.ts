import type { AuthTokenResolver } from '../../core/factory.js';
import type { AgentConfig } from '../../core/types.js';
import { getSession } from './session.js';

/**
 * Resolves the auth token for LLM proxy calls.
 * Priority:
 *   1. config.authToken
 *   2. RC_AUTH_TOKEN env var
 *   3. ~/.rc-agents/auth.json (via getSession)
 *
 * Returns null if none found (caller decides whether to throw).
 *
 * SECURITY NOTE: this intentionally does NOT fall back to the telemetry
 * API key. Telemetry ingest keys are scoped to upload-only; treating them
 * as LLM auth confused two trust scopes and made env-injected
 * RC_TELEMETRY_API_KEY a valid LLM credential.
 */
export async function resolveAuthToken(config: AgentConfig): Promise<string | null> {
  if (config.authToken) return config.authToken;
  if (process.env.RC_AUTH_TOKEN) return process.env.RC_AUTH_TOKEN;

  const session = await getSession();
  if (session) return session.sessionJwt;

  return null;
}

export function createNodeAuthTokenResolver(config: AgentConfig): AuthTokenResolver {
  return {
    async resolve(): Promise<string> {
      const token = await resolveAuthToken(config);
      if (token === null) {
        throw new Error('No auth token available');
      }
      return token;
    },
  };
}
