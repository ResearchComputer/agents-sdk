import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuthRequiredError, SdkError } from '../../core/errors.js';
import os from 'node:os';
import path from 'node:path';

// Mock fs/promises before dynamic import of session module
const mockReadFile  = vi.fn();
const mockWriteFile = vi.fn();
const mockRename    = vi.fn();
const mockUnlink    = vi.fn();
const mockMkdir     = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: {
    readFile:  (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    rename:    (...args: unknown[]) => mockRename(...args),
    unlink:    (...args: unknown[]) => mockUnlink(...args),
    mkdir:     (...args: unknown[]) => mockMkdir(...args),
  },
}));

const { saveSession, getSession, logout } = await import('./session.js');

const AUTH_DIR  = path.join(os.homedir(), '.rc-agents');
const AUTH_PATH = path.join(AUTH_DIR, 'auth.json');
const AUTH_TMP  = AUTH_PATH + '.tmp';

function makeSession(overrides: Partial<import('./session.js').Session> = {}): import('./session.js').Session {
  return {
    sessionJwt:   'jwt.token.here',
    sessionToken: 'session_token_here',
    jwtExpiresAt: Date.now() + 10 * 60 * 1000,
    email:        'user@example.com',
    ...overrides,
  };
}

describe('AuthRequiredError', () => {
  it('extends SdkError with code AUTH_REQUIRED and retryable=false', () => {
    const err = new AuthRequiredError();
    expect(err).toBeInstanceOf(SdkError);
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('AuthRequiredError');
  });
});

describe('saveSession', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates parent directory with mode 0o700 (recursive)', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    await saveSession(makeSession());

    expect(mockMkdir).toHaveBeenCalledWith(AUTH_DIR, { recursive: true, mode: 0o700 });
  });

  it('writes to .tmp path with mode 0o600', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    await saveSession(makeSession());

    expect(mockWriteFile).toHaveBeenCalledWith(
      AUTH_TMP,
      expect.any(String),
      { encoding: 'utf-8', mode: 0o600 },
    );
  });

  it('renames .tmp to auth.json', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    await saveSession(makeSession());

    expect(mockRename).toHaveBeenCalledWith(AUTH_TMP, AUTH_PATH);
  });

  it('serializes all session fields to JSON', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    const session = makeSession({ email: 'test@example.com', jwtExpiresAt: 9999 });
    await saveSession(session);

    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as import('./session.js').Session;
    expect(written.email).toBe('test@example.com');
    expect(written.jwtExpiresAt).toBe(9999);
    expect(written.sessionJwt).toBe('jwt.token.here');
  });

  it('call order: mkdir → writeFile → rename', async () => {
    const calls: string[] = [];
    mockMkdir.mockImplementation(async () => { calls.push('mkdir'); });
    mockWriteFile.mockImplementation(async () => { calls.push('writeFile'); });
    mockRename.mockImplementation(async () => { calls.push('rename'); });

    await saveSession(makeSession());

    expect(calls).toEqual(['mkdir', 'writeFile', 'rename']);
  });
});

describe('getSession - no refresh needed', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns null when auth.json does not exist', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await getSession()).toBeNull();
  });

  it('returns null when auth.json contains invalid JSON', async () => {
    mockReadFile.mockResolvedValue('{ invalid }');
    expect(await getSession()).toBeNull();
  });

  it('returns null when sessionJwt is missing from the file', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      sessionToken: 'tok',
      jwtExpiresAt: Date.now() + 60000,
      email: '',
    }));
    expect(await getSession()).toBeNull();
  });

  it('returns null when sessionToken is missing from the file', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      sessionJwt: 'jwt',
      jwtExpiresAt: Date.now() + 60000,
      email: '',
    }));
    expect(await getSession()).toBeNull();
  });

  it('returns session unchanged when JWT has > 60s remaining', async () => {
    const stored = makeSession({ jwtExpiresAt: Date.now() + 5 * 60 * 1000 });
    mockReadFile.mockResolvedValue(JSON.stringify(stored));
    expect(await getSession()).toEqual(stored);
  });
});

describe('getSession - refresh path', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env['RC_LLM_PROXY_URL'];
  });

  const nearExpiry = () => makeSession({ jwtExpiresAt: Date.now() + 30 * 1000 }); // 30s left

  function makeProxyResponse(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        sessionJwt:   'new.jwt.token',
        sessionToken: 'new_session_token',
        jwtExpiresAt: Date.now() + 5 * 60 * 1000,
        email:        'user@example.com',
        ...overrides,
      }),
    };
  }

  function setupSuccessRefresh() {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
  }

  it('calls llm-proxy /auth/stytch/refresh with sessionToken when JWT near expiry', async () => {
    setupSuccessRefresh();
    mockReadFile.mockResolvedValue(JSON.stringify(nearExpiry()));
    const mockFetch = vi.fn().mockResolvedValue(makeProxyResponse());
    vi.stubGlobal('fetch', mockFetch);

    const session = await getSession();

    expect(session?.sessionJwt).toBe('new.jwt.token');
    expect(session?.sessionToken).toBe('new_session_token');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.test/auth/stytch/refresh');
    const body = JSON.parse(init.body as string) as { sessionToken: string };
    expect(body.sessionToken).toBe('session_token_here');
  });

  it('strips trailing slash from RC_LLM_PROXY_URL', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test/';
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify(nearExpiry()));
    const mockFetch = vi.fn().mockResolvedValue(makeProxyResponse());
    vi.stubGlobal('fetch', mockFetch);

    await getSession();

    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toBe('https://proxy.test/auth/stytch/refresh');
  });

  it('refreshes when JWT is already expired', async () => {
    setupSuccessRefresh();
    const expired = makeSession({ jwtExpiresAt: Date.now() - 1000 });
    mockReadFile.mockResolvedValue(JSON.stringify(expired));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeProxyResponse({ sessionJwt: 'refreshed.jwt' })));

    const session = await getSession();
    expect(session?.sessionJwt).toBe('refreshed.jwt');
  });

  it('returns null on HTTP 401 from refresh (session revoked)', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    mockReadFile.mockResolvedValue(JSON.stringify(nearExpiry()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect(await getSession()).toBeNull();
  });

  it('returns null on HTTP 403 from refresh', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    mockReadFile.mockResolvedValue(JSON.stringify(nearExpiry()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    expect(await getSession()).toBeNull();
  });

  it('returns stale stored session on network error during refresh (if still valid)', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    const stored = nearExpiry();
    mockReadFile.mockResolvedValue(JSON.stringify(stored));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    // Transient failure → fall back to stored session (still has JWT life)
    expect(await getSession()).toEqual(stored);
  });

  it('returns null on network error when stored JWT is fully expired', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    mockReadFile.mockResolvedValue(JSON.stringify(makeSession({ jwtExpiresAt: Date.now() - 1000 })));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    expect(await getSession()).toBeNull();
  });

  it('returns stale stored session on 5xx from refresh (if still valid)', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    const stored = nearExpiry();
    mockReadFile.mockResolvedValue(JSON.stringify(stored));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    expect(await getSession()).toEqual(stored);
  });

  it('returns stale stored session when RC_LLM_PROXY_URL is not set (if still valid)', async () => {
    // Explicitly do NOT set RC_LLM_PROXY_URL
    const stored = nearExpiry();
    mockReadFile.mockResolvedValue(JSON.stringify(stored));
    vi.stubGlobal('fetch', vi.fn());
    // Can't refresh without proxy URL, but stored JWT still has life → return it
    expect(await getSession()).toEqual(stored);
  });

  it('returns null when RC_LLM_PROXY_URL is not set AND stored JWT is fully expired', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(makeSession({ jwtExpiresAt: Date.now() - 1000 })));
    vi.stubGlobal('fetch', vi.fn());
    expect(await getSession()).toBeNull();
  });

  it('writes refreshed session atomically (mkdir + .tmp + rename)', async () => {
    setupSuccessRefresh();
    mockReadFile.mockResolvedValue(JSON.stringify(nearExpiry()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeProxyResponse()));

    await getSession();

    expect(mockMkdir).toHaveBeenCalledWith(AUTH_DIR, { recursive: true, mode: 0o700 });
    expect(mockWriteFile).toHaveBeenCalledWith(
      AUTH_TMP,
      expect.any(String),
      { encoding: 'utf-8', mode: 0o600 },
    );
    expect(mockRename).toHaveBeenCalledWith(AUTH_TMP, AUTH_PATH);
  });

  it('returns refreshed session even when saveSession fails on disk', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    mockReadFile.mockResolvedValue(JSON.stringify(nearExpiry()));
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockRejectedValue(new Error('disk full'));
    mockRename.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeProxyResponse({ sessionJwt: 'new.jwt' })));

    const session = await getSession();
    expect(session?.sessionJwt).toBe('new.jwt');
  });

  it('falls back to stale stored session when refresh returns unparseable JSON', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    const stored = nearExpiry();
    mockReadFile.mockResolvedValue(JSON.stringify(stored));
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      }),
    );

    const session = await getSession();
    expect(session).toEqual(stored);
  });

  it('rotates both sessionJwt and sessionToken on refresh', async () => {
    setupSuccessRefresh();
    mockReadFile.mockResolvedValue(JSON.stringify(nearExpiry()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeProxyResponse({
      sessionJwt:   'rotated.jwt',
      sessionToken: 'rotated_token',
    })));

    const session = await getSession();
    expect(session?.sessionJwt).toBe('rotated.jwt');
    expect(session?.sessionToken).toBe('rotated_token');
  });
});

describe('logout', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env['RC_LLM_PROXY_URL'];
  });

  it('calls llm-proxy /auth/stytch/revoke with sessionToken', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    mockReadFile.mockResolvedValue(JSON.stringify(makeSession({ sessionToken: 'tok_to_revoke' })));
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    mockUnlink.mockResolvedValue(undefined);

    await logout();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.test/auth/stytch/revoke');
    const body = JSON.parse(init.body as string) as { sessionToken: string };
    expect(body.sessionToken).toBe('tok_to_revoke');
  });

  it('deletes auth.json after revocation', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    mockReadFile.mockResolvedValue(JSON.stringify(makeSession()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    mockUnlink.mockResolvedValue(undefined);

    await logout();

    expect(mockUnlink).toHaveBeenCalledWith(AUTH_PATH);
  });

  it('deletes auth.json even when revoke call throws', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    mockReadFile.mockResolvedValue(JSON.stringify(makeSession()));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    mockUnlink.mockResolvedValue(undefined);

    await logout();

    expect(mockUnlink).toHaveBeenCalledWith(AUTH_PATH);
  });

  it('deletes auth.json even when RC_LLM_PROXY_URL is unset', async () => {
    // No RC_LLM_PROXY_URL — skip revoke, still delete local file
    mockReadFile.mockResolvedValue(JSON.stringify(makeSession()));
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    mockUnlink.mockResolvedValue(undefined);

    await logout();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(AUTH_PATH);
  });

  it('does not throw when auth.json does not exist', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.stubGlobal('fetch', vi.fn());
    mockUnlink.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(logout()).resolves.not.toThrow();
  });

  it('does not throw when file deletion fails', async () => {
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
    mockReadFile.mockResolvedValue(JSON.stringify(makeSession()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    mockUnlink.mockRejectedValue(new Error('Permission denied'));

    await expect(logout()).resolves.not.toThrow();
  });
});
