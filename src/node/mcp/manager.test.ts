import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  Client: vi.fn(),
  StdioClientTransport: vi.fn(),
  SSEClientTransport: vi.fn(),
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: mocks.Client,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mocks.StdioClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: mocks.SSEClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: mocks.StreamableHTTPClientTransport,
}));

import { createMcpManager } from './manager.js';

describe('createMcpManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.listTools.mockResolvedValue({
      tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
    });
    mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'pong' }] });
    mocks.close.mockResolvedValue(undefined);
    mocks.Client.mockImplementation(() => ({
      connect: mocks.connect,
      listTools: mocks.listTools,
      callTool: mocks.callTool,
      close: mocks.close,
    }));
    mocks.StdioClientTransport.mockImplementation((options) => ({ kind: 'stdio', options }));
    mocks.SSEClientTransport.mockImplementation((url, options) => ({ kind: 'sse', url, options }));
    mocks.StreamableHTTPClientTransport.mockImplementation((url, options) => ({ kind: 'http', url, options }));
  });

  it('connects streamable HTTP MCP servers and exposes their tools', async () => {
    const manager = createMcpManager();
    await manager.connect({
      name: 'remote',
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer token' },
    });

    expect(mocks.StreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('https://example.test/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer token' } } },
    );
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'http' }));
    expect(manager.getTools().map((tool) => tool.name)).toEqual(['mcp__remote__ping']);
  });

  it('requires urls for HTTP MCP servers before constructing a transport', async () => {
    const manager = createMcpManager();
    await expect(manager.connect({ name: 'remote', transport: 'http' })).rejects.toThrow(/HTTP transport requires a url/);
    expect(mocks.StreamableHTTPClientTransport).not.toHaveBeenCalled();
  });
});
