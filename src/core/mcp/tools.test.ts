import { describe, it, expect, vi } from 'vitest';
import { wrapMcpTool, assertValidMcpServerName } from './tools.js';

describe('wrapMcpTool', () => {
  it('creates a tool with correct naming convention', () => {
    const callTool = vi.fn();
    const tool = wrapMcpTool('myserver', { name: 'doStuff', description: 'Does stuff' }, callTool);

    expect(tool.name).toBe('mcp__myserver__doStuff');
    expect(tool.description).toBe('Does stuff');
    expect(tool.capabilities).toEqual(['mcp:call']);
    expect(tool.label).toBe('MCP: myserver/doStuff');
  });

  it('calls callTool with the original tool name and args', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'result here' }],
    });

    const tool = wrapMcpTool('srv', { name: 'myTool' }, callTool);
    const result = await tool.execute('call-1', { key: 'value' });

    expect(callTool).toHaveBeenCalledWith('myTool', { key: 'value' });
    expect(result.content[0]).toEqual({ type: 'text', text: 'result here' });
  });

  it('handles empty content response', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const tool = wrapMcpTool('srv', { name: 'empty' }, callTool);
    const result = await tool.execute('call-2', {});

    expect(result.content[0]).toEqual({ type: 'text', text: 'Tool executed successfully.' });
  });

  it('converts input schema to TypeBox parameters', () => {
    const callTool = vi.fn();
    const tool = wrapMcpTool(
      'srv',
      {
        name: 'typed',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      callTool,
    );

    expect(tool.parameters).toBeDefined();
  });

  it('provides default description when none given', () => {
    const callTool = vi.fn();
    const tool = wrapMcpTool('srv', { name: 'noDesc' }, callTool);
    expect(tool.description).toBe('MCP tool: noDesc');
  });

  it('rejects server names containing "__" to avoid ambiguous parsing', () => {
    const callTool = vi.fn();
    expect(() => wrapMcpTool('foo__bar', { name: 'x' }, callTool)).toThrow(/must not contain "__"/);
  });

  it('rejects server names with invalid characters', () => {
    const callTool = vi.fn();
    expect(() => wrapMcpTool('bad name!', { name: 'x' }, callTool)).toThrow(/must match/);
    expect(() => wrapMcpTool('', { name: 'x' }, callTool)).toThrow(/non-empty/);
  });

  it('passes an empty object when execute is called with nullish args', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const tool = wrapMcpTool('srv', { name: 'nullishArgs' }, callTool);
    await tool.execute('c1', undefined as unknown as Record<string, unknown>);
    expect(callTool).toHaveBeenCalledWith('nullishArgs', {});
  });

  it('skips non-text content entries when joining output', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [
        { type: 'image' },
        { type: 'text', text: 'keep me' },
        { type: 'text' },
      ],
    });
    const tool = wrapMcpTool('srv', { name: 'mixed' }, callTool);
    const result = await tool.execute('c1', {});
    expect((result.content[0] as { text: string }).text).toBe('keep me');
  });

  it('assertValidMcpServerName accepts normal names', () => {
    expect(() => assertValidMcpServerName('filesystem')).not.toThrow();
    expect(() => assertValidMcpServerName('my_server')).not.toThrow();
    expect(() => assertValidMcpServerName('my.server-v2')).not.toThrow();
  });
});
