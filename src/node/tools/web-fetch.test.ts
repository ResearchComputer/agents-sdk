import { describe, it, expect, afterEach, vi } from 'vitest';
import { createWebFetchTool } from './web-fetch.js';
import { ToolExecutionError } from '../../core/errors.js';

describe('createWebFetchTool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('declares correct metadata', () => {
    const tool = createWebFetchTool();
    expect(tool.name).toBe('WebFetch');
    expect(tool.capabilities).toEqual(['network:egress']);
  });

  it('returns body text on 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return 'hello world';
        },
      })),
    );
    const tool = createWebFetchTool();
    const result = await tool.execute('call1', { url: 'https://example.test/' });
    expect((result.content[0] as { type: 'text'; text: string }).text).toBe('hello world');
    expect(result.details).toMatchObject({ url: 'https://example.test/', status: 200 });
  });

  it('truncates very large bodies', async () => {
    const big = 'x'.repeat(200 * 1024);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return big;
        },
      })),
    );
    const tool = createWebFetchTool();
    const result = await tool.execute('call1', { url: 'https://example.test/big' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text.length).toBeLessThan(big.length);
  });

  it('throws ToolExecutionError on non-ok HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        async text() {
          return '';
        },
      })),
    );
    const tool = createWebFetchTool();
    await expect(tool.execute('call1', { url: 'https://example.test/missing' })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('wraps network failures in ToolExecutionError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const tool = createWebFetchTool();
    try {
      await tool.execute('call1', { url: 'https://example.test/' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError);
      expect((err as Error).message).toMatch(/ECONNREFUSED/);
    }
  });
});
