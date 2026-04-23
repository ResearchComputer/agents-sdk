import { describe, it, expect, vi } from 'vitest';
import { composePipeline } from './pipeline.js';
import type { HookHandler, RunContext } from '../types.js';
import type { BeforeToolCallContext, AfterToolCallContext, BeforeToolCallResult, AfterToolCallResult } from '@mariozechner/pi-agent-core';
import { createRunContext } from '../context/run-context.js';

function makeRunContext(): RunContext {
  return createRunContext({ cwd: '/tmp' });
}

function makeBeforeContext(toolName: string, args: Record<string, any> = {}): BeforeToolCallContext {
  return {
    assistantMessage: {
      role: 'assistant',
      content: [],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
    toolCall: { type: 'toolCall', id: 'tc-1', name: toolName, arguments: args },
    args,
    context: { systemPrompt: '', messages: [], tools: [] },
  };
}

function makeAfterContext(toolName: string, args: Record<string, any> = {}): AfterToolCallContext {
  return {
    assistantMessage: {
      role: 'assistant',
      content: [],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
    toolCall: { type: 'toolCall', id: 'tc-1', name: toolName, arguments: args },
    args,
    result: { content: [{ type: 'text', text: 'original' }], details: {} },
    isError: false,
    context: { systemPrompt: '', messages: [], tools: [] },
  };
}

describe('composePipeline', () => {
  it('returns a pipeline with beforeToolCall and afterToolCall', () => {
    const pipeline = composePipeline({
      hooks: [],
      permissionGate: async () => undefined,
      runContext: makeRunContext(),
    });
    expect(pipeline.beforeToolCall).toBeTypeOf('function');
    expect(pipeline.afterToolCall).toBeTypeOf('function');
  });

  describe('beforeToolCall', () => {
    it('runs PreToolUse hooks before permission gate', async () => {
      const order: string[] = [];
      const hooks: HookHandler[] = [
        {
          event: 'PreToolUse',
          handler: async () => { order.push('hook'); return undefined; },
        },
      ];
      const permissionGate = vi.fn().mockImplementation(async () => {
        order.push('permission');
        return undefined;
      });

      const pipeline = composePipeline({ hooks, permissionGate, runContext: makeRunContext() });
      await pipeline.beforeToolCall(makeBeforeContext('ReadFile'));
      expect(order).toEqual(['hook', 'permission']);
    });

    it('PreToolUse hooks can modify args passed to permission gate', async () => {
      const hooks: HookHandler[] = [
        {
          event: 'PreToolUse',
          handler: async () => ({ updatedArgs: { command: 'git status' } }),
        },
      ];
      const permissionGate = vi.fn().mockResolvedValue(undefined);

      const pipeline = composePipeline({ hooks, permissionGate, runContext: makeRunContext() });
      const ctx = makeBeforeContext('Bash', { command: 'rm -rf /' });
      await pipeline.beforeToolCall(ctx);

      // The context args should be updated before permission gate sees it
      expect(permissionGate).toHaveBeenCalledWith(
        expect.objectContaining({ args: { command: 'git status' } }),
        undefined,
      );
    });

    it('permission gate can veto (block) the tool call', async () => {
      const permissionGate = vi.fn().mockResolvedValue({ block: true, reason: 'denied' });

      const pipeline = composePipeline({
        hooks: [],
        permissionGate,
        runContext: makeRunContext(),
      });
      const result = await pipeline.beforeToolCall(makeBeforeContext('WriteFile'));
      expect(result).toEqual({ block: true, reason: 'denied' });
    });

    it('returns undefined (allow) when no hooks and permission allows', async () => {
      const pipeline = composePipeline({
        hooks: [],
        permissionGate: async () => undefined,
        runContext: makeRunContext(),
      });
      const result = await pipeline.beforeToolCall(makeBeforeContext('ReadFile'));
      expect(result).toBeUndefined();
    });

    it('PreToolUse hooks CANNOT veto (block is ignored)', async () => {
      // PreToolUse hooks can only modify args, not block
      const hooks: HookHandler[] = [
        {
          event: 'PreToolUse',
          handler: async () => ({ updatedArgs: { modified: true } }),
        },
      ];
      const pipeline = composePipeline({
        hooks,
        permissionGate: async () => undefined,
        runContext: makeRunContext(),
      });
      const result = await pipeline.beforeToolCall(makeBeforeContext('ReadFile'));
      expect(result).toBeUndefined();
    });
  });

  describe('afterToolCall', () => {
    it('runs PostToolUse hooks and returns modified result', async () => {
      const hooks: HookHandler[] = [
        {
          event: 'PostToolUse',
          handler: async () => ({
            updatedResult: { content: [{ type: 'text' as const, text: 'modified' }], details: {} },
          }),
        },
      ];
      const pipeline = composePipeline({
        hooks,
        permissionGate: async () => undefined,
        runContext: makeRunContext(),
      });
      const result = await pipeline.afterToolCall(makeAfterContext('ReadFile'));
      expect(result).toEqual({ content: [{ type: 'text', text: 'modified' }], details: {} });
    });

    it('returns undefined when no PostToolUse hooks modify the result', async () => {
      const pipeline = composePipeline({
        hooks: [],
        permissionGate: async () => undefined,
        runContext: makeRunContext(),
      });
      const result = await pipeline.afterToolCall(makeAfterContext('ReadFile'));
      expect(result).toBeUndefined();
    });

    it('chains PostToolUse hooks', async () => {
      const hooks: HookHandler[] = [
        {
          event: 'PostToolUse',
          handler: async () => ({
            updatedResult: { content: [{ type: 'text' as const, text: 'step1' }], details: {} },
          }),
        },
        {
          event: 'PostToolUse',
          handler: async () => ({
            updatedResult: { content: [{ type: 'text' as const, text: 'step2' }], details: {} },
          }),
        },
      ];
      const pipeline = composePipeline({
        hooks,
        permissionGate: async () => undefined,
        runContext: makeRunContext(),
      });
      const result = await pipeline.afterToolCall(makeAfterContext('ReadFile'));
      expect(result).toEqual({ content: [{ type: 'text', text: 'step2' }], details: {} });
    });
  });

  it('passes runContext to hooks', async () => {
    const runContext = makeRunContext();
    let capturedCtx: RunContext | undefined;
    const hooks: HookHandler[] = [
      {
        event: 'PreToolUse',
        handler: async (ctx) => { capturedCtx = ctx.runContext; return undefined; },
      },
    ];
    const pipeline = composePipeline({
      hooks,
      permissionGate: async () => undefined,
      runContext,
    });
    await pipeline.beforeToolCall(makeBeforeContext('ReadFile'));
    expect(capturedCtx).toBe(runContext);
  });
});
