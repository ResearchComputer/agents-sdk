import { describe, it, expect, afterEach, vi } from 'vitest';
import { createWebFetchTool, type WebFetchToolOptions } from './web-fetch.js';
import { ToolExecutionError } from '../../core/errors.js';

describe('createWebFetchTool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Default lookup stub: every hostname resolves to a public address.
  // Individual tests override for cases that need a different resolution.
  const publicLookup: WebFetchToolOptions['lookupHost'] = async () => [
    { address: '93.184.216.34', family: 4 },
  ];

  function makeTool(options: Partial<WebFetchToolOptions> = {}) {
    return createWebFetchTool({ lookupHost: publicLookup, ...options });
  }

  function stubFetchOnce(impl: () => Promise<Response> | Response) {
    const fn = vi.fn(impl);
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  function textResponse(body: string, contentType = 'text/plain', status = 200): Response {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(body);
    let consumed = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (consumed) {
          controller.close();
          return;
        }
        controller.enqueue(bytes);
        consumed = true;
        controller.close();
      },
    });
    return new Response(stream, {
      status,
      headers: { 'content-type': contentType },
    });
  }

  function redirectResponse(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  it('declares correct metadata', () => {
    const tool = makeTool();
    expect(tool.name).toBe('WebFetch');
    expect(tool.capabilities).toEqual(['network:egress']);
  });

  it('returns body text on 200 response', async () => {
    stubFetchOnce(async () => textResponse('hello world', 'text/plain'));
    const tool = makeTool();
    const result = await tool.execute('c1', { url: 'https://example.test/' });
    expect((result.content[0] as { text: string }).text).toBe('hello world');
    expect(result.details).toMatchObject({
      url: 'https://example.test/',
      status: 200,
      truncated: false,
    });
  });

  it('truncates large bodies and reports truncated=true', async () => {
    const big = 'x'.repeat(200 * 1024);
    stubFetchOnce(async () => textResponse(big, 'text/plain'));
    const tool = makeTool();
    const result = await tool.execute('c1', { url: 'https://example.test/big' });
    const text = (result.content[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(100 * 1024);
    expect((result.details as { truncated: boolean }).truncated).toBe(true);
  });

  it('rejects non-http(s) schemes', async () => {
    const tool = makeTool();
    await expect(tool.execute('c1', { url: 'file:///etc/passwd' })).rejects.toThrow(
      /\[invalid_input\] scheme not allowed/,
    );
    await expect(tool.execute('c1', { url: 'data:text/plain,hi' })).rejects.toThrow(
      /\[invalid_input\] scheme not allowed/,
    );
  });

  it('rejects malformed URLs', async () => {
    const tool = makeTool();
    await expect(tool.execute('c1', { url: 'not a url' })).rejects.toThrow(
      /\[invalid_input\] invalid URL/,
    );
  });

  it('rejects loopback IPv4 literal (127.0.0.1)', async () => {
    const tool = makeTool();
    await expect(
      tool.execute('c1', { url: 'http://127.0.0.1/' }),
    ).rejects.toThrow(/\[invalid_input\] host not allowed/);
  });

  it('rejects cloud IMDS (169.254.169.254)', async () => {
    const tool = makeTool();
    await expect(
      tool.execute('c1', { url: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toThrow(/\[invalid_input\] host not allowed/);
  });

  it('rejects RFC1918 (10.0.0.1, 192.168.1.1)', async () => {
    const tool = makeTool();
    await expect(tool.execute('c1', { url: 'http://10.0.0.1/' })).rejects.toThrow(
      /\[invalid_input\] host not allowed/,
    );
    await expect(tool.execute('c1', { url: 'http://192.168.1.1/' })).rejects.toThrow(
      /\[invalid_input\] host not allowed/,
    );
  });

  it('rejects IPv6 loopback (::1)', async () => {
    const tool = makeTool();
    await expect(tool.execute('c1', { url: 'http://[::1]/' })).rejects.toThrow(
      /\[invalid_input\] host not allowed/,
    );
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    const tool = makeTool({
      lookupHost: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    await expect(tool.execute('c1', { url: 'http://any-host/' })).rejects.toThrow(
      /\[invalid_input\] host not allowed/,
    );
  });

  it('rejects hostnames where ANY resolved address is private (dual-stack)', async () => {
    const tool = makeTool({
      lookupHost: async () => [
        { address: '93.184.216.34', family: 4 }, // public
        { address: '::1', family: 6 }, // private — still blocked
      ],
    });
    await expect(tool.execute('c1', { url: 'http://dual-stack/' })).rejects.toThrow(
      /\[invalid_input\] host not allowed/,
    );
  });

  it('re-validates the host on redirect', async () => {
    let call = 0;
    const fetchFn = vi.fn(async (url: any) => {
      call++;
      if (call === 1) {
        // First request goes to public host; returns a 302 to loopback.
        return redirectResponse('http://127.0.0.1/meta');
      }
      return textResponse('should not be reached');
    });
    vi.stubGlobal('fetch', fetchFn);
    const tool = makeTool();
    await expect(
      tool.execute('c1', { url: 'https://example.test/redirect' }),
    ).rejects.toThrow(/host not allowed|invalid_input/);
    // We should NOT have followed the redirect to loopback
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('follows redirects up to MAX_REDIRECTS (5) then refuses', async () => {
    let hop = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        hop++;
        return redirectResponse(`https://example.test/hop-${hop}`);
      }),
    );
    const tool = makeTool();
    await expect(tool.execute('c1', { url: 'https://example.test/' })).rejects.toThrow(
      /\[invalid_input\] too many redirects/,
    );
  });

  it('rejects non-allowed content types (e.g. application/octet-stream)', async () => {
    stubFetchOnce(async () =>
      textResponse('\x00\x01binary', 'application/octet-stream'),
    );
    const tool = makeTool();
    await expect(
      tool.execute('c1', { url: 'https://example.test/bin' }),
    ).rejects.toThrow(/\[invalid_input\] content type not allowed/);
  });

  it('accepts application/json', async () => {
    stubFetchOnce(async () => textResponse('{"x":1}', 'application/json'));
    const tool = makeTool();
    const result = await tool.execute('c1', { url: 'https://example.test/api' });
    expect((result.content[0] as { text: string }).text).toBe('{"x":1}');
  });

  it('does NOT embed the URL or errno in error messages', async () => {
    stubFetchOnce(async () => {
      throw new Error('ECONNREFUSED /home/user/secret.txt');
    });
    const tool = makeTool();
    try {
      await tool.execute('c1', { url: 'https://example.test/SECRET=abc' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError);
      expect((err as Error).message).not.toContain('example.test');
      expect((err as Error).message).not.toContain('SECRET');
      expect((err as Error).message).not.toContain('/home/user');
    }
  });

  it('non-2xx status maps to fetch_failed without leaking body', async () => {
    stubFetchOnce(async () => textResponse('INTERNAL ERROR DETAILS', 'text/plain', 500));
    const tool = makeTool();
    await expect(tool.execute('c1', { url: 'https://example.test/' })).rejects.toThrow(
      /\[fetch_failed\]/,
    );
  });
});
