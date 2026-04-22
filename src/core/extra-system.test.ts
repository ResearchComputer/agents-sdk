import { describe, it, expect } from 'vitest';
import { getModel, createAssistantMessageEventStream } from '@researchcomputer/ai-provider';
import { createAgentCore } from './factory.js';
import { createTelemetryCollector } from './telemetry/collector.js';
import type { CoreAdapters } from './index.js';
import type { LlmClient } from './llm/client.js';

function mkStubAdapters(onSystemPrompt: (systemPrompt: string) => void): CoreAdapters {
  const streamFn = ((model: any, context: any, _options?: any) => {
    onSystemPrompt(context?.systemPrompt ?? '');
    const stream = createAssistantMessageEventStream();
    const msg = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'ok' }],
      stopReason: 'stop' as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    stream.push({ type: 'start', partial: msg });
    stream.push({ type: 'done', reason: 'stop', message: msg });
    return stream;
  }) as unknown as LlmClient['stream'];

  return {
    memoryStore: { load: async () => [], save: async () => {}, remove: async () => {} },
    sessionStore: { load: async () => null, save: async () => {}, list: async () => [] },
    telemetryCollector: createTelemetryCollector({ optOut: true }),
    telemetrySink: { flush: async () => {} },
    mcpManager: {
      connect: async () => {
        throw new Error('no mcp');
      },
      disconnect: async () => {},
      getTools: () => [],
      getConnections: () => [],
    },
    authTokenResolver: { resolve: async () => 'test' },
    telemetryOptOut: true,
    llmClient: {
      stream: streamFn,
      completeN: (async () => []) as unknown as LlmClient['completeN'],
    },
  };
}

describe('prompt extraSystem', () => {
  it('appends extraSystem to the system prompt for the turn only', async () => {
    const observed: string[] = [];
    const model = getModel('openai', 'gpt-4o-mini');
    const core = await createAgentCore(
      {
        model,
        systemPrompt: 'BASE',
        cwd: '/tmp',
        enableMemory: false,
        permissionMode: 'allowAll',
        tools: [],
        systemPromptHash: 'sha256:test',
      },
      mkStubAdapters((sp) => observed.push(sp)),
    );
    await core.prompt('first', undefined, '<memory>M1</memory>');
    await core.prompt('second');
    await core.dispose();
    expect(observed[0]).toContain('BASE');
    expect(observed[0]).toContain('<memory>M1</memory>');
    expect(observed[1]).toContain('BASE');
    expect(observed[1]).not.toContain('<memory>M1</memory>');
  });
});
