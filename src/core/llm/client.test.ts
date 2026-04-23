import { describe, it, expect, vi } from 'vitest';
import { getModel, createAssistantMessageEventStream } from '@researchcomputer/ai-provider';
import type { AssistantMessage } from '@researchcomputer/ai-provider';
import { createAgentCore, type CoreAdapters } from '../factory.js';
import { createTelemetryCollector } from '../telemetry/collector.js';
import type { LlmClient } from './client.js';

// Minimal in-memory adapter stubs. These exist so we can instantiate
// createAgentCore without touching the filesystem, the network,
// or @researchcomputer/ai-provider. The only adapter we actually care
// about is llmClient — everything else is no-op scaffolding.

function makeStubAdapters(llmClient: LlmClient): CoreAdapters {
  return {
    memoryStore: {
      load: async () => [],
      save: async () => {},
      remove: async () => {},
    },
    sessionStore: {
      load: async () => null,
      save: async () => {},
      list: async () => [],
    },
    telemetryCollector: createTelemetryCollector({ optOut: true }),
    telemetrySink: { flush: async () => {} },
    mcpManager: {
      connect: async () => {
        throw new Error('mcp disabled in this stub');
      },
      disconnect: async () => {},
      getTools: () => [],
      getConnections: () => [],
    },
    authTokenResolver: { resolve: async () => 'stub-token' },
    llmClient,
    telemetryOptOut: true,
  };
}

function makeAssistantMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'stop',
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o-mini',
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
}

describe('LlmClient adapter wiring', () => {
  it('createAgentCore routes Agent stream calls through adapters.llmClient.stream', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const streamFn = vi.fn((m: typeof model) => {
      const stream = createAssistantMessageEventStream();
      const msg = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'hi' }],
        stopReason: 'stop' as const,
        api: m.api,
        provider: m.provider,
        model: m.id,
        timestamp: Date.now(),
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: 'start', partial: msg });
      stream.push({ type: 'done', reason: 'stop', message: msg });
      return stream;
    });

    const llmClient: LlmClient = {
      stream: streamFn as unknown as LlmClient['stream'],
      completeN: vi.fn(),
    };

    const agent = await createAgentCore(
      {
        model,
        cwd: process.cwd(),
        permissionMode: 'allowAll',
        enableMemory: false,
        systemPromptHash: 'sha256:test',
      },
      makeStubAdapters(llmClient),
    );

    await agent.prompt('hello');
    expect(streamFn).toHaveBeenCalled();
    expect(llmClient.completeN).not.toHaveBeenCalled();

    await agent.dispose();
  });

  it('fork() routes completeN through adapters.llmClient.completeN when no streamFn override', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const completeNFn = vi.fn(async (_model, _ctx, n: number) =>
      Array.from({ length: n }, () => makeAssistantMessage()),
    );
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const msg = makeAssistantMessage();
      stream.push({ type: 'start', partial: msg });
      stream.push({ type: 'done', reason: 'stop', message: msg });
      return stream;
    });

    const llmClient: LlmClient = {
      stream: streamFn as unknown as LlmClient['stream'],
      completeN: completeNFn as unknown as LlmClient['completeN'],
    };

    const agent = await createAgentCore(
      {
        model,
        cwd: process.cwd(),
        permissionMode: 'allowAll',
        enableMemory: false,
        systemPromptHash: 'sha256:test',
      },
      makeStubAdapters(llmClient),
    );

    const children = await agent.fork('test', 3);
    expect(children).toHaveLength(3);
    expect(completeNFn).toHaveBeenCalledTimes(1);
    expect(completeNFn.mock.calls[0][2]).toBe(3);

    for (const child of children) await child.dispose();
    await agent.dispose();
  });
});
