import { describe, it, expect } from 'vitest';
import { createAssistantMessageEventStream, getModel } from '@researchcomputer/ai-provider';
import { runSubAgent } from './subagent.js';

function makeStreamFn(textChunks: string[] | null) {
  const model = getModel('openai', 'gpt-4o-mini');
  return (() => {
    const stream = createAssistantMessageEventStream();
    const msg = {
      role: 'assistant' as const,
      content:
        textChunks === null
          ? []
          : textChunks.map((t) => ({ type: 'text' as const, text: t })),
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
  }) as any;
}

describe('runSubAgent', () => {
  const model = getModel('openai', 'gpt-4o-mini');

  it('returns concatenated text from assistant content parts', async () => {
    const result = await runSubAgent('hi', {
      model,
      streamFn: makeStreamFn(['part one', 'part two']),
    });
    expect(result).toBe('part one\npart two');
  });

  it('returns empty string when the reply has no text parts', async () => {
    const result = await runSubAgent('hi', {
      model,
      streamFn: makeStreamFn([]),
    });
    expect(result).toBe('');
  });

  it('honors a custom systemPrompt without error', async () => {
    const result = await runSubAgent('hi', {
      model,
      systemPrompt: 'You are a pirate.',
      streamFn: makeStreamFn(['arr']),
    });
    expect(result).toBe('arr');
  });
});
