import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuthRequiredError } from '../core/errors.js';

vi.mock('./auth/session.js', () => ({
  getSession: vi.fn(),
}));

import { getSession } from './auth/session.js';
const mockGetSession = vi.mocked(getSession);

const { resolveAuthToken } = await import('./auth/resolver.js');
const { createAgent } = await import('./factory.js');
import type { AgentConfig } from '../core/types.js';

// Minimal config stub. resolveAuthToken only reads `authToken` and `telemetry`.
// Use `as unknown as AgentConfig` because AgentConfig requires `model`
// but resolveAuthToken doesn't touch it.
function cfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return ({ ...overrides } as unknown) as AgentConfig;
}

describe('resolveAuthToken', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['RC_AUTH_TOKEN'];
    delete process.env['RC_TELEMETRY_API_KEY'];
  });

  it('config.authToken takes highest priority', async () => {
    process.env['RC_AUTH_TOKEN'] = 'env-token';
    mockGetSession.mockResolvedValue({
      sessionJwt: 'session-jwt', sessionToken: 'st', jwtExpiresAt: 0, email: '',
    });

    expect(await resolveAuthToken(cfg({ authToken: 'config-token' }))).toBe('config-token');
  });

  it('RC_AUTH_TOKEN env var is second priority', async () => {
    process.env['RC_AUTH_TOKEN'] = 'env-jwt';
    mockGetSession.mockResolvedValue(null);

    expect(await resolveAuthToken(cfg())).toBe('env-jwt');
  });

  it('session JWT from auth.json is third priority', async () => {
    mockGetSession.mockResolvedValue({
      sessionJwt: 'file-jwt', sessionToken: 'st', jwtExpiresAt: 0, email: '',
    });

    expect(await resolveAuthToken(cfg())).toBe('file-jwt');
  });

  it('does NOT fall back to config.telemetry.apiKey for LLM auth (security)', async () => {
    // Previously this returned 'cfg-legacy-key' — telemetry keys were
    // accepted as LLM auth tokens. That conflated trust scopes and made
    // an env-injected telemetry key a valid LLM credential. The fallback
    // was removed; resolveAuthToken now returns null.
    mockGetSession.mockResolvedValue(null);
    expect(
      await resolveAuthToken(
        cfg({
          telemetry: { endpoint: 'https://e.com', apiKey: 'cfg-legacy-key' },
        }),
      ),
    ).toBeNull();
  });

  it('does NOT fall back to RC_TELEMETRY_API_KEY env var for LLM auth', async () => {
    process.env['RC_TELEMETRY_API_KEY'] = 'legacy-env-key';
    mockGetSession.mockResolvedValue(null);
    expect(await resolveAuthToken(cfg())).toBeNull();
  });

  it('returns null when nothing is configured', async () => {
    mockGetSession.mockResolvedValue(null);

    expect(await resolveAuthToken(cfg())).toBeNull();
  });

  it('does not treat telemetry:false as providing an apiKey', async () => {
    mockGetSession.mockResolvedValue(null);

    expect(await resolveAuthToken(cfg({ telemetry: false }))).toBeNull();
  });
});

describe('createAgent — auth integration', () => {
  afterEach(() => {
    delete process.env['RC_AUTH_TOKEN'];
    delete process.env['RC_TELEMETRY_API_KEY'];
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(null);
  });

  it('throws AuthRequiredError when no auth is configured and no getApiKey', async () => {
    // Use `as never` to skip full Model construction — createAgent will
    // throw AuthRequiredError before it touches the model.
    await expect(createAgent({
      model: null as never,
    })).rejects.toThrow(AuthRequiredError);
  });

  it('does NOT throw AuthRequiredError when config.authToken is provided', async () => {
    // With an auth token, createAgent proceeds past the guard.
    // It will still fail later trying to use the null model — so we
    // assert the error is NOT AuthRequiredError.
    let caught: unknown = null;
    try {
      await createAgent({
        model: null as never,
        authToken: 'some-jwt',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AuthRequiredError);
  });

  it('does NOT throw AuthRequiredError when config.getApiKey is provided', async () => {
    let caught: unknown = null;
    try {
      await createAgent({
        model: null as never,
        getApiKey: async () => 'some-key',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AuthRequiredError);
  });
});
