import { describe, it, expect, vi } from 'vitest';
import { scopeAdaptersForChild } from './child-scope.js';
import type { CoreAdapters } from '../factory.js';
import type { McpManager, McpConnection } from '../types.js';

function makeFakeAdapters(overrides: Partial<CoreAdapters> = {}): CoreAdapters {
  const fakeConnections: McpConnection[] = [
    { name: 'server-a', config: { name: 'server-a', transport: 'stdio', command: 'x' }, async close() {} },
  ];
  const disconnectSpy = vi.fn(async () => {});
  const mcpManager: McpManager = {
    async connect() {
      return fakeConnections[0];
    },
    disconnect: disconnectSpy,
    getTools() {
      return [];
    },
    getConnections() {
      return fakeConnections;
    },
  };
  return {
    memoryStore: { async load() { return []; }, async save() {}, async remove() {} },
    sessionStore: { async save() {}, async load() { return null; }, async list() { return []; } },
    telemetryCollector: {
      onLlmCall: vi.fn(),
      onToolEvent: vi.fn(),
      finalize: () => ({
        schemaVersion: 1 as const,
        optOut: false,
        llmCalls: [],
        toolEvents: [],
        totalCost: 0,
        totalTokens: 0,
      }),
    },
    telemetrySink: { async flush() {} },
    mcpManager,
    authTokenResolver: { async resolve() { return 'tok'; } },
    llmClient: {
      stream: vi.fn(),
      completeN: vi.fn(),
    },
    ...overrides,
  } as unknown as CoreAdapters;
}

describe('scopeAdaptersForChild', () => {
  it('returns an empty connection list so dispose teardown is a no-op for children', () => {
    const parent = makeFakeAdapters();
    const child = scopeAdaptersForChild(parent, 'parent-session', 0);
    expect(child.mcpManager.getConnections()).toEqual([]);
    // Parent still sees its own connection
    expect(parent.mcpManager.getConnections()).toHaveLength(1);
  });

  it('child disconnect() is a silent no-op — never touches the parent', async () => {
    const parent = makeFakeAdapters();
    const child = scopeAdaptersForChild(parent, 'parent-session', 0);
    await child.mcpManager.disconnect('server-a');
    // The parent's disconnect must not have been called.
    expect(parent.mcpManager.disconnect).not.toHaveBeenCalled();
  });

  it('child getTools passes through to parent (shared tool surface)', () => {
    const tool = { name: 't', label: 't', description: 't', parameters: {} as any, capabilities: [] as any, execute: async () => ({ content: [], details: {} }) };
    const parent = makeFakeAdapters({
      mcpManager: {
        async connect() { throw new Error('unused'); },
        async disconnect() {},
        getTools() { return [tool as any]; },
        getConnections() { return []; },
      },
    });
    const child = scopeAdaptersForChild(parent, 'parent-session', 0);
    expect(child.mcpManager.getTools()).toEqual([tool]);
  });

  it('child gets a fresh telemetry collector (events do not double-count on parent)', () => {
    const parent = makeFakeAdapters();
    const child = scopeAdaptersForChild(parent, 'parent-session', 0);
    child.telemetryCollector.onLlmCall({
      timestamp: 1,
      modelId: 'm',
      inputTokens: 10,
      outputTokens: 20,
      cost: 0.01,
      latencyMs: 100,
    });
    const parentFinal = parent.telemetryCollector.finalize();
    // Parent totals are untouched — the child's event landed in the child's
    // own collector, not the parent's.
    expect(parentFinal.totalTokens).toBe(0);
    expect(parentFinal.llmCalls).toHaveLength(0);
    const childFinal = child.telemetryCollector.finalize();
    expect(childFinal.totalTokens).toBe(30);
  });

  it('shares memoryStore, sessionStore, llmClient (read-mostly surfaces)', () => {
    const parent = makeFakeAdapters();
    const child = scopeAdaptersForChild(parent, 'parent-session', 0);
    expect(child.memoryStore).toBe(parent.memoryStore);
    expect(child.sessionStore).toBe(parent.sessionStore);
    expect(child.llmClient).toBe(parent.llmClient);
    expect(child.authTokenResolver).toBe(parent.authTokenResolver);
  });
});
