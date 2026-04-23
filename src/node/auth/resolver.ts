import type { AuthTokenResolver } from '../../core/factory.js';
import type { AgentConfig } from '../../core/types.js';
import { getSession } from './session.js';

/**
 * Resolves the auth token for LLM proxy and telemetry calls.
 * Priority:
 *   1. config.authToken
 *   2. RC_AUTH_TOKEN env var
 *   3. ~/.rc-agents/auth.json (via getSession)
 *   4. config.telemetry.apiKey (legacy)
 *   5. RC_TELEMETRY_API_KEY env var (legacy)
 *
 * Returns null if none found (caller decides whether to throw).
 */
export async function resolveAuthToken(config: AgentConfig): Promise<string | null> {
  if (config.authToken) return config.authToken;
  if (process.env.RC_AUTH_TOKEN) return process.env.RC_AUTH_TOKEN;

  const session = await getSession();
  if (session) return session.sessionJwt;

  if (typeof config.telemetry === 'object' && config.telemetry?.apiKey) {
    return config.telemetry.apiKey;
  }
  if (process.env.RC_TELEMETRY_API_KEY) return process.env.RC_TELEMETRY_API_KEY;

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
