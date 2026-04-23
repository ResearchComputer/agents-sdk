import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SdkError } from '../../core/errors.js';

const mockWriteFile = vi.fn();
const mockRename    = vi.fn();
const mockReadFile  = vi.fn();
const mockMkdir     = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: {
    readFile:  (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    rename:    (...args: unknown[]) => mockRename(...args),
    mkdir:     (...args: unknown[]) => mockMkdir(...args),
    unlink:    vi.fn().mockResolvedValue(undefined),
  },
}));

const { exchangeToken } = await import('./login.js');

function makeProxyResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      sessionJwt:   'jwt.token',
      sessionToken: 'session_tok',
      jwtExpiresAt: Date.now() + 5 * 60 * 1000,
      email:        'user@example.com',
      ...overrides,
    }),
  };
}

describe('exchangeToken', () => {
  beforeEach(() => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    process.env['RC_LLM_PROXY_URL'] = 'https://proxy.test';
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env['RC_LLM_PROXY_URL'];
  });

  it('POSTs to llm-proxy /auth/stytch/exchange with { token, tokenType }', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeProxyResponse());
    vi.stubGlobal('fetch', mockFetch);

    await exchangeToken('stytch_token_abc', 'magic_links');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.test/auth/stytch/exchange');
    const body = JSON.parse(init.body as string) as { token: string; tokenType: string };
    expect(body.token).toBe('stytch_token_abc');
    expect(body.tokenType).toBe('magic_links');
  });

  it('accepts tokenType=oauth', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeProxyResponse());
    vi.stubGlobal('fetch', mockFetch);

    await exchangeToken('tok', 'oauth');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { tokenType: string };
    expect(body.tokenType).toBe('oauth');
  });

  it('throws SdkError(UNSUPPORTED_TOKEN_TYPE) for unknown tokenType', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(exchangeToken('tok', 'webauthn')).rejects.toThrow(SdkError);
    await expect(exchangeToken('tok', 'webauthn')).rejects.toMatchObject({
      code: 'UNSUPPORTED_TOKEN_TYPE',
    });
  });

  it('throws SdkError(CONFIG_MISSING) when RC_LLM_PROXY_URL is unset', async () => {
    delete process.env['RC_LLM_PROXY_URL'];
    vi.stubGlobal('fetch', vi.fn());

    await expect(exchangeToken('tok', 'magic_links')).rejects.toMatchObject({
      code: 'CONFIG_MISSING',
    });
  });

  it('returns session with fields from proxy response', async () => {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeProxyResponse({
      sessionJwt: 'the.jwt',
      sessionToken: 'the_token',
      jwtExpiresAt: expiresAt,
      email: 'a@b.com',
    })));

    const session = await exchangeToken('tok', 'magic_links');

    expect(session).toEqual({
      sessionJwt: 'the.jwt',
      sessionToken: 'the_token',
      jwtExpiresAt: expiresAt,
      email: 'a@b.com',
    });
  });

  it('calls saveSession atomically (mkdir + writeFile + rename)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeProxyResponse()));

    await exchangeToken('tok', 'magic_links');

    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.any(String),
      { encoding: 'utf-8', mode: 0o600 },
    );
    expect(mockRename).toHaveBeenCalled();
  });

  it('throws when llm-proxy returns non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));

    await expect(exchangeToken('bad_token', 'magic_links')).rejects.toThrow();
  });

  it('defaults to empty string when email is absent from proxy response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeProxyResponse({ email: '' })));

    const session = await exchangeToken('tok', 'magic_links');
    expect(session.email).toBe('');
  });
});
