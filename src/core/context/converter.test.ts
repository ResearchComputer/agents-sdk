import { describe, it, expect } from 'vitest';
import { convertToLlm } from './converter.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { UserMessage, AssistantMessage, ToolResultMessage } from '@researchcomputer/ai-provider';
import type { MemoryInjectionMessage, CompactionSummaryMessage, SwarmReportMessage } from '../types.js';

describe('convertToLlm', () => {
  it('passes through UserMessage unchanged', () => {
    const user: UserMessage = { role: 'user', content: 'hello', timestamp: 1 };
    const result = convertToLlm([user as AgentMessage]);
    expect(result).toEqual([user]);
  });

  it('passes through AssistantMessage unchanged', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-3',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 1,
    };
    const result = convertToLlm([assistant as AgentMessage]);
    expect(result).toEqual([assistant]);
  });

  it('passes through ToolResultMessage unchanged', () => {
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'tc1',
      toolName: 'Read',
      content: [{ type: 'text', text: 'file content' }],
      isError: false,
      timestamp: 1,
    };
    const result = convertToLlm([toolResult as AgentMessage]);
    expect(result).toEqual([toolResult]);
  });

  it('converts MemoryInjectionMessage to UserMessage with [Memory] prefix', () => {
    const memory: MemoryInjectionMessage = {
      role: 'memory',
      content: 'remembered fact',
      sources: ['file.md'],
      timestamp: 100,
    };
    const result = convertToLlm([memory as AgentMessage]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: '[Memory] remembered fact',
      timestamp: 100,
    });
  });

  it('converts CompactionSummaryMessage to UserMessage with [Context Summary] prefix', () => {
    const summary: CompactionSummaryMessage = {
      role: 'summary',
      content: 'conversation summary here',
      compactedCount: 10,
      timestamp: 200,
    };
    const result = convertToLlm([summary as AgentMessage]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: '[Context Summary] conversation summary here',
      timestamp: 200,
    });
  });

  it('converts SwarmReportMessage to UserMessage with [Agent Report: <name>] prefix', () => {
    const report: SwarmReportMessage = {
      role: 'swarmReport',
      content: 'task completed',
      fromAgent: 'worker-1',
      taskId: 'task-abc',
      timestamp: 300,
    };
    const result = convertToLlm([report as AgentMessage]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: '[Agent Report: worker-1] task completed',
      timestamp: 300,
    });
  });

  it('skips unknown roles', () => {
    const unknown = { role: 'unknown', content: 'mystery', timestamp: 1 } as unknown as AgentMessage;
    const result = convertToLlm([unknown]);
    expect(result).toEqual([]);
  });

  it('handles mixed message types in order', () => {
    const user: UserMessage = { role: 'user', content: 'hello', timestamp: 1 };
    const memory: MemoryInjectionMessage = { role: 'memory', content: 'fact', sources: [], timestamp: 2 };
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-3',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 3,
    };
    const unknown = { role: 'alien', timestamp: 4 } as unknown as AgentMessage;

    const result = convertToLlm([user as AgentMessage, memory as AgentMessage, assistant as AgentMessage, unknown]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(user);
    expect((result[1] as UserMessage).content).toBe('[Memory] fact');
    expect(result[2]).toEqual(assistant);
  });

  it('returns empty array for empty input', () => {
    expect(convertToLlm([])).toEqual([]);
  });

  it('skips non-object messages', () => {
    const result = convertToLlm([
      null as unknown as AgentMessage,
      'raw string' as unknown as AgentMessage,
      42 as unknown as AgentMessage,
    ]);
    expect(result).toEqual([]);
  });

  it('skips messages whose role is not a string', () => {
    const result = convertToLlm([
      { role: 1, content: 'x', timestamp: 1 } as unknown as AgentMessage,
      { content: 'no role', timestamp: 2 } as unknown as AgentMessage,
    ]);
    expect(result).toEqual([]);
  });
});
