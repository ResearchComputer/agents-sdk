import { describe, it, expect } from 'vitest';
import { createRunContext } from './run-context.js';

describe('createRunContext', () => {
  it('creates a RunContext with required cwd', () => {
    const ctx = createRunContext({ cwd: '/tmp' });
    expect(ctx.cwd).toBe('/tmp');
    expect(ctx.sessionId).toBeTruthy();
    expect(ctx.traceId).toBeTruthy();
    expect(ctx.signal).toBeDefined();
    expect(ctx.costTracker).toBeDefined();
    expect(ctx.permissionDecisions).toEqual([]);
  });

  it('uses provided sessionId and traceId', () => {
    const ctx = createRunContext({ cwd: '/tmp', sessionId: 'my-session', traceId: 'my-trace' });
    expect(ctx.sessionId).toBe('my-session');
    expect(ctx.traceId).toBe('my-trace');
  });

  it('uses provided signal', () => {
    const controller = new AbortController();
    const ctx = createRunContext({ cwd: '/tmp', signal: controller.signal });
    expect(ctx.signal).toBe(controller.signal);
  });

  it('generates unique sessionIds and traceIds', () => {
    const ctx1 = createRunContext({ cwd: '/tmp' });
    const ctx2 = createRunContext({ cwd: '/tmp' });
    expect(ctx1.sessionId).not.toBe(ctx2.sessionId);
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });

  it('costTracker works correctly', () => {
    const ctx = createRunContext({ cwd: '/tmp' });
    expect(ctx.costTracker.total()).toEqual({ tokens: 0, cost: 0 });
  });
});
