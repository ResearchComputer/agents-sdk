import { describe, it, expect } from 'vitest';
import { estimateTokens, segmentMessages, createCompressionMiddleware, messageText } from './compression.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { UserMessage, AssistantMessage, ToolResultMessage } from '@researchcomputer/ai-provider';
import type { MemoryInjectionMessage, CompactionSummaryMessage } from '../types.js';

function makeUser(text: string, ts = 1): UserMessage {
  return { role: 'user', content: text, timestamp: ts };
}

function makeAssistant(text: string, ts = 2): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-3',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: ts,
  };
}

function makeToolResult(text: string, ts = 3): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 'tc1',
    toolName: 'Read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: ts,
  };
}

describe('estimateTokens', () => {
  it('returns ceil(length / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});

describe('messageText', () => {
  it('extracts text from string content', () => {
    expect(messageText(makeUser('hello') as AgentMessage)).toBe('hello');
  });

  it('extracts text from array content with TextContent', () => {
    expect(messageText(makeAssistant('world') as AgentMessage)).toBe('world');
  });

  it('extracts text from toolResult', () => {
    expect(messageText(makeToolResult('result') as AgentMessage)).toBe('result');
  });

  it('falls back to JSON.stringify for unknown content', () => {
    const msg = { role: 'memory', content: 'remembered', sources: [], timestamp: 1 } as unknown as AgentMessage;
    const text = messageText(msg);
    expect(text).toContain('remembered');
  });

  it('returns empty string for null input', () => {
    expect(messageText(null as unknown as AgentMessage)).toBe('');
  });

  it('returns empty string for non-object input', () => {
    expect(messageText('raw' as unknown as AgentMessage)).toBe('');
    expect(messageText(42 as unknown as AgentMessage)).toBe('');
  });

  it('falls back to JSON.stringify when content is a non-text-part array', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'toolUse', id: 'a' }],
      timestamp: 1,
    } as unknown as AgentMessage;
    const text = messageText(msg);
    expect(text).toContain('toolUse');
  });

  it('falls back to JSON.stringify when text-part array has no string text', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'text', text: 42 }],
      timestamp: 1,
    } as unknown as AgentMessage;
    const text = messageText(msg);
    expect(text).toContain('42');
  });
});

describe('segmentMessages', () => {
  it('groups consecutive messages by segment type', () => {
    const msgs: AgentMessage[] = [
      makeUser('q1') as AgentMessage,
      makeAssistant('a1') as AgentMessage,
      makeToolResult('r1') as AgentMessage,
      makeToolResult('r2') as AgentMessage,
      makeUser('q2') as AgentMessage,
    ];
    const segments = segmentMessages(msgs);

    expect(segments).toHaveLength(4);
    expect(segments[0].type).toBe('user');
    expect(segments[0].messages).toHaveLength(1);
    expect(segments[1].type).toBe('assistant');
    expect(segments[1].messages).toHaveLength(1);
    expect(segments[2].type).toBe('toolIO');
    expect(segments[2].messages).toHaveLength(2);
    expect(segments[3].type).toBe('user');
    expect(segments[3].messages).toHaveLength(1);
  });

  it('identifies memory messages as memory segment', () => {
    const mem: MemoryInjectionMessage = { role: 'memory', content: 'fact', sources: [], timestamp: 1 };
    const segments = segmentMessages([mem as AgentMessage]);
    expect(segments[0].type).toBe('memory');
  });

  it('identifies summary messages as summary segment', () => {
    const sum: CompactionSummaryMessage = { role: 'summary', content: 'sum', compactedCount: 5, timestamp: 1 };
    const segments = segmentMessages([sum as AgentMessage]);
    expect(segments[0].type).toBe('summary');
  });

  it('returns empty array for empty input', () => {
    expect(segmentMessages([])).toEqual([]);
  });
});

describe('createCompressionMiddleware', () => {
  it('returns messages unchanged when under 80% of maxTokens', async () => {
    const msgs: AgentMessage[] = [
      makeUser('short question') as AgentMessage,
      makeAssistant('short answer') as AgentMessage,
    ];
    const middleware = createCompressionMiddleware({ maxTokens: 1000, strategy: 'truncate' });
    const result = await middleware(msgs);
    expect(result).toEqual(msgs);
  });

  it('truncates older messages when over budget', async () => {
    // Create messages that exceed 80% of maxTokens
    const longText = 'x'.repeat(400); // 100 tokens each
    const msgs: AgentMessage[] = [
      makeUser(longText, 1) as AgentMessage,      // old
      makeAssistant(longText, 2) as AgentMessage,  // old
      makeUser(longText, 3) as AgentMessage,       // old
      makeAssistant(longText, 4) as AgentMessage,  // old
      makeUser(longText, 5) as AgentMessage,       // old
      makeAssistant(longText, 6) as AgentMessage,  // old
      // Recent turns (protected by default 3 turns * 3 = 9 messages, but we only have these)
      makeUser('recent q1', 7) as AgentMessage,
      makeAssistant('recent a1', 8) as AgentMessage,
      makeToolResult('recent r1', 9) as AgentMessage,
      makeUser('recent q2', 10) as AgentMessage,
      makeAssistant('recent a2', 11) as AgentMessage,
      makeToolResult('recent r2', 12) as AgentMessage,
      makeUser('recent q3', 13) as AgentMessage,
      makeAssistant('recent a3', 14) as AgentMessage,
      makeToolResult('recent r3', 15) as AgentMessage,
    ];

    // Total tokens: 6*100 + 9*~3 = ~627 tokens
    // maxTokens = 200, so 80% = 160, definitely over budget
    const middleware = createCompressionMiddleware({ maxTokens: 200, strategy: 'truncate' });
    const result = await middleware(msgs);

    // Should have fewer messages than original (some older ones truncated)
    expect(result.length).toBeLessThan(msgs.length);
    // Should always include the recent protected messages
    expect(result[result.length - 1]).toEqual(msgs[msgs.length - 1]);
  });

  it('protects the specified number of recent turns', async () => {
    const longText = 'x'.repeat(400); // 100 tokens
    const msgs: AgentMessage[] = [
      makeUser(longText, 1) as AgentMessage,
      makeAssistant(longText, 2) as AgentMessage,
      makeUser('q1', 3) as AgentMessage,
      makeAssistant('a1', 4) as AgentMessage,
    ];

    const middleware = createCompressionMiddleware({
      maxTokens: 50,
      strategy: 'truncate',
      protectedRecentTurns: 1, // protect last 3 messages
    });
    const result = await middleware(msgs);

    // The last 3 messages should be protected
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[result.length - 1]).toEqual(msgs[msgs.length - 1]);
    expect(result[result.length - 2]).toEqual(msgs[msgs.length - 2]);
  });

  it('summarize strategy falls back to truncate', async () => {
    const longText = 'x'.repeat(400);
    const msgs: AgentMessage[] = [
      makeUser(longText, 1) as AgentMessage,
      makeAssistant(longText, 2) as AgentMessage,
      makeUser('recent', 3) as AgentMessage,
      makeAssistant('recent', 4) as AgentMessage,
    ];
    const middleware = createCompressionMiddleware({
      maxTokens: 50,
      strategy: 'summarize',
      protectedRecentTurns: 1,
    });
    const result = await middleware(msgs);
    expect(result.length).toBeLessThanOrEqual(msgs.length);
  });

  it('handles abort signal', async () => {
    const msgs: AgentMessage[] = [makeUser('hi') as AgentMessage];
    const controller = new AbortController();
    const middleware = createCompressionMiddleware({ maxTokens: 1000, strategy: 'truncate' });
    const result = await middleware(msgs, controller.signal);
    expect(result).toEqual(msgs);
  });
});
