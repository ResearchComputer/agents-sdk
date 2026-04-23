import { describe, it, expect, vi } from 'vitest';
import { runPreToolUseHooks, runPostToolUseHooks, runLifecycleHooks } from './hooks.js';
import type { HookHandler, RunContext } from '../types.js';
import { createRunContext } from '../context/run-context.js';

function makeRunContext(): RunContext {
  return createRunContext({ cwd: '/tmp' });
}

describe('runPreToolUseHooks', () => {
  it('runs matching PreToolUse hooks and returns updated args', async () => {
    const hooks: HookHandler[] = [
      {
        event: 'PreToolUse',
        handler: async (ctx) => ({ updatedArgs: { ...(ctx.toolArgs as object), extra: true } }),
      },
    ];
    const result = await runPreToolUseHooks(hooks, 'ReadFile', { path: '/tmp' }, makeRunContext());
    expect(result).toEqual({ path: '/tmp', extra: true });
  });

  it('chains args through multiple hooks', async () => {
    const hooks: HookHandler[] = [
      {
        event: 'PreToolUse',
        handler: async (ctx) => ({ updatedArgs: { ...(ctx.toolArgs as object), first: true } }),
      },
      {
        event: 'PreToolUse',
        handler: async (ctx) => ({ updatedArgs: { ...(ctx.toolArgs as object), second: true } }),
      },
    ];
    const result = await runPreToolUseHooks(hooks, 'ReadFile', { path: '/tmp' }, makeRunContext());
    expect(result).toEqual({ path: '/tmp', first: true, second: true });
  });

  it('returns original args if no hooks match', async () => {
    const hooks: HookHandler[] = [
      { event: 'PostToolUse', handler: async () => ({}) },
    ];
    const args = { path: '/tmp' };
    const result = await runPreToolUseHooks(hooks, 'ReadFile', args, makeRunContext());
    expect(result).toBe(args);
  });

  it('skips hooks whose matcher does not match toolName', async () => {
    const handler = vi.fn().mockResolvedValue({ updatedArgs: { changed: true } });
    const hooks: HookHandler[] = [
      { event: 'PreToolUse', matcher: 'WriteFile', handler },
    ];
    const result = await runPreToolUseHooks(hooks, 'ReadFile', { path: '/tmp' }, makeRunContext());
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ path: '/tmp' });
  });

  it('runs hooks when matcher matches toolName', async () => {
    const handler = vi.fn().mockResolvedValue({ updatedArgs: { changed: true } });
    const hooks: HookHandler[] = [
      { event: 'PreToolUse', matcher: 'ReadFile', handler },
    ];
    const result = await runPreToolUseHooks(hooks, 'ReadFile', { path: '/tmp' }, makeRunContext());
    expect(handler).toHaveBeenCalled();
    expect(result).toEqual({ changed: true });
  });

  it('preserves args if hook returns void', async () => {
    const hooks: HookHandler[] = [
      { event: 'PreToolUse', handler: async () => undefined },
    ];
    const args = { path: '/tmp' };
    const result = await runPreToolUseHooks(hooks, 'ReadFile', args, makeRunContext());
    expect(result).toBe(args);
  });

  it('preserves args if hook returns empty object', async () => {
    const hooks: HookHandler[] = [
      { event: 'PreToolUse', handler: async () => ({}) },
    ];
    const args = { path: '/tmp' };
    const result = await runPreToolUseHooks(hooks, 'ReadFile', args, makeRunContext());
    expect(result).toBe(args);
  });

  it('passes toolCallId to PreToolUse hooks', async () => {
    const received: string[] = [];
    const hook: HookHandler = {
      event: 'PreToolUse',
      handler: async (ctx) => { received.push(ctx.toolCallId ?? 'missing'); },
    };
    await runPreToolUseHooks([hook], 'Read', {}, makeRunContext(), 'call-abc');
    expect(received).toEqual(['call-abc']);
  });
});

describe('runPostToolUseHooks', () => {
  it('runs matching PostToolUse hooks and returns updated result', async () => {
    const hooks: HookHandler[] = [
      {
        event: 'PostToolUse',
        handler: async () => ({
          updatedResult: { content: [{ type: 'text' as const, text: 'modified' }], details: {} },
        }),
      },
    ];
    const original = { content: [{ type: 'text' as const, text: 'original' }], details: {} };
    const result = await runPostToolUseHooks(hooks, 'ReadFile', original, makeRunContext());
    expect(result.content[0]).toEqual({ type: 'text', text: 'modified' });
  });

  it('chains results through multiple hooks', async () => {
    const hooks: HookHandler[] = [
      {
        event: 'PostToolUse',
        handler: async (ctx) => ({
          updatedResult: { content: [{ type: 'text' as const, text: 'step1' }], details: ctx.toolResult?.details },
        }),
      },
      {
        event: 'PostToolUse',
        handler: async (ctx) => ({
          updatedResult: { content: [{ type: 'text' as const, text: 'step2' }], details: ctx.toolResult?.details },
        }),
      },
    ];
    const original = { content: [{ type: 'text' as const, text: 'original' }], details: {} };
    const result = await runPostToolUseHooks(hooks, 'ReadFile', original, makeRunContext());
    expect(result.content[0]).toEqual({ type: 'text', text: 'step2' });
  });

  it('returns original result if no hooks match', async () => {
    const hooks: HookHandler[] = [
      { event: 'PreToolUse', handler: async () => ({}) },
    ];
    const original = { content: [{ type: 'text' as const, text: 'original' }], details: {} };
    const result = await runPostToolUseHooks(hooks, 'ReadFile', original, makeRunContext());
    expect(result).toBe(original);
  });

  it('skips hooks with non-matching matcher', async () => {
    const handler = vi.fn().mockResolvedValue({
      updatedResult: { content: [{ type: 'text' as const, text: 'changed' }], details: {} },
    });
    const hooks: HookHandler[] = [
      { event: 'PostToolUse', matcher: 'WriteFile', handler },
    ];
    const original = { content: [{ type: 'text' as const, text: 'original' }], details: {} };
    const result = await runPostToolUseHooks(hooks, 'ReadFile', original, makeRunContext());
    expect(handler).not.toHaveBeenCalled();
    expect(result).toBe(original);
  });

  it('passes toolCallId to PostToolUse hooks', async () => {
    const received: string[] = [];
    const hook: HookHandler = {
      event: 'PostToolUse',
      handler: async (ctx) => { received.push(ctx.toolCallId ?? 'missing'); },
    };
    const result = { content: [{ type: 'text', text: 'ok' }], details: {} } as any;
    await runPostToolUseHooks([hook], 'Read', result, makeRunContext(), 'call-xyz');
    expect(received).toEqual(['call-xyz']);
  });
});

describe('runLifecycleHooks', () => {
  it('runs all matching lifecycle hooks', async () => {
    const handler1 = vi.fn().mockResolvedValue(undefined);
    const handler2 = vi.fn().mockResolvedValue(undefined);
    const hooks: HookHandler[] = [
      { event: 'SessionStart', handler: handler1 },
      { event: 'SessionStart', handler: handler2 },
      { event: 'SessionEnd', handler: vi.fn() },
    ];
    await runLifecycleHooks(hooks, 'SessionStart', makeRunContext());
    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it('passes extra context to hook', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const hooks: HookHandler[] = [
      { event: 'SessionStart', handler },
    ];
    const extra = { agentName: 'test' };
    await runLifecycleHooks(hooks, 'SessionStart', makeRunContext(), extra);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      event: 'SessionStart',
      agentName: 'test',
    }));
  });

  it('does nothing when no hooks match', async () => {
    const handler = vi.fn();
    const hooks: HookHandler[] = [
      { event: 'SessionEnd', handler },
    ];
    await runLifecycleHooks(hooks, 'SessionStart', makeRunContext());
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores matcher for lifecycle hooks', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const hooks: HookHandler[] = [
      { event: 'SessionStart', matcher: 'SomeTool', handler },
    ];
    // Lifecycle hooks should still run even with a matcher set (matcher is for tool hooks)
    await runLifecycleHooks(hooks, 'SessionStart', makeRunContext());
    expect(handler).toHaveBeenCalled();
  });

  it('swallows lifecycle-hook exceptions and continues with later hooks', async () => {
    const throwingHandler = vi.fn().mockRejectedValue(new Error('boom'));
    const laterHandler = vi.fn().mockResolvedValue(undefined);
    const hooks: HookHandler[] = [
      { event: 'SessionStart', handler: throwingHandler },
      { event: 'SessionStart', handler: laterHandler },
    ];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(runLifecycleHooks(hooks, 'SessionStart', makeRunContext())).resolves.toBeUndefined();
      expect(throwingHandler).toHaveBeenCalled();
      expect(laterHandler).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('includes the matcher in the warning label when a matcher is set', async () => {
    const hooks: HookHandler[] = [
      { event: 'SessionStart', matcher: 'Greeter', handler: vi.fn().mockRejectedValue(new Error('nope')) },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runLifecycleHooks(hooks, 'SessionStart', makeRunContext());
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain('SessionStart(Greeter)');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs the raw thrown value when a hook throws a non-Error', async () => {
    const hooks: HookHandler[] = [
      { event: 'SessionStart', handler: vi.fn().mockRejectedValue('string panic') },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runLifecycleHooks(hooks, 'SessionStart', makeRunContext());
      expect(warnSpy).toHaveBeenCalled();
      const raw = warnSpy.mock.calls[0]?.[1];
      expect(raw).toBe('string panic');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
