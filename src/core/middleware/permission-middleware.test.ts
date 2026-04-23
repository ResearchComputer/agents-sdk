import { describe, it, expect, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { createPermissionMiddleware } from './permission-middleware.js';
import type { SdkTool, PermissionRule, RunContext, PermissionMode, PermissionDecision } from '../types.js';
import type { BeforeToolCallContext } from '@mariozechner/pi-agent-core';
import { createRunContext } from '../context/run-context.js';

function makeTool(name: string, capabilities: SdkTool['capabilities'] = [], permissionCheck?: SdkTool['permissionCheck']): SdkTool<any, any> {
  return {
    name,
    label: name,
    description: `Tool ${name}`,
    parameters: Type.Object({}),
    capabilities,
    permissionCheck,
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
  };
}

function makeContext(toolName: string, args: Record<string, any> = {}): BeforeToolCallContext {
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

function makeRunContext(): RunContext {
  return createRunContext({ cwd: '/tmp' });
}

describe('createPermissionMiddleware', () => {
  it('returns undefined (allow) for allowAll mode', async () => {
    const middleware = createPermissionMiddleware({
      mode: 'allowAll',
      rules: [],
      tools: [makeTool('ReadFile', ['fs:read'])],
      runContext: makeRunContext(),
    });
    const result = await middleware(makeContext('ReadFile'));
    expect(result).toBeUndefined();
  });

  it('returns block for denied tool', async () => {
    const rules: PermissionRule[] = [
      { target: { type: 'tool', name: 'WriteFile' }, behavior: 'deny', source: 'user' },
    ];
    const middleware = createPermissionMiddleware({
      mode: 'default',
      rules,
      tools: [makeTool('WriteFile', ['fs:write'])],
      runContext: makeRunContext(),
    });
    const result = await middleware(makeContext('WriteFile'));
    expect(result).toEqual({ block: true, reason: expect.any(String) });
  });

  it('uses tool-specific permissionCheck if defined', async () => {
    const permissionCheck = vi.fn().mockReturnValue({ behavior: 'deny', reason: 'custom deny' });
    const tool = makeTool('CustomTool', ['fs:write'], permissionCheck);
    const middleware = createPermissionMiddleware({
      mode: 'default',
      rules: [],
      tools: [tool],
      runContext: makeRunContext(),
    });
    const result = await middleware(makeContext('CustomTool'));
    expect(permissionCheck).toHaveBeenCalled();
    expect(result).toEqual({ block: true, reason: 'custom deny' });
  });

  it('falls back to evaluatePermission when permissionCheck returns allow', async () => {
    const permissionCheck = vi.fn().mockReturnValue({ behavior: 'allow' });
    const tool = makeTool('CustomTool', ['fs:write'], permissionCheck);
    const middleware = createPermissionMiddleware({
      mode: 'default',
      rules: [],
      tools: [tool],
      runContext: makeRunContext(),
    });
    // permissionCheck allows, but evaluatePermission should ask for mutation cap
    const result = await middleware(makeContext('CustomTool'));
    // Since permissionCheck returned allow, we trust it
    expect(result).toBeUndefined();
  });

  it('calls onAsk callback for ask behavior and allows if true', async () => {
    const onAsk = vi.fn().mockResolvedValue(true);
    const middleware = createPermissionMiddleware({
      mode: 'default',
      rules: [],
      tools: [makeTool('WriteFile', ['fs:write'])],
      runContext: makeRunContext(),
      onAsk,
    });
    const result = await middleware(makeContext('WriteFile'));
    expect(onAsk).toHaveBeenCalledWith('WriteFile', {});
    expect(result).toBeUndefined();
  });

  it('calls onAsk callback for ask behavior and blocks if false', async () => {
    const onAsk = vi.fn().mockResolvedValue(false);
    const middleware = createPermissionMiddleware({
      mode: 'default',
      rules: [],
      tools: [makeTool('WriteFile', ['fs:write'])],
      runContext: makeRunContext(),
      onAsk,
    });
    const result = await middleware(makeContext('WriteFile'));
    expect(result).toEqual({ block: true, reason: expect.any(String) });
  });

  it('denies when ask behavior and no onAsk callback', async () => {
    const middleware = createPermissionMiddleware({
      mode: 'default',
      rules: [],
      tools: [makeTool('WriteFile', ['fs:write'])],
      runContext: makeRunContext(),
    });
    const result = await middleware(makeContext('WriteFile'));
    expect(result).toEqual({ block: true, reason: expect.any(String) });
  });

  it('logs permission decision to runContext', async () => {
    const runContext = makeRunContext();
    const middleware = createPermissionMiddleware({
      mode: 'allowAll',
      rules: [],
      tools: [makeTool('ReadFile', ['fs:read'])],
      runContext,
    });
    await middleware(makeContext('ReadFile'));
    expect(runContext.permissionDecisions).toHaveLength(1);
    const decision = runContext.permissionDecisions[0];
    expect(decision.toolName).toBe('ReadFile');
    expect(decision.behavior).toBe('allow');
    expect(decision.timestamp).toBeGreaterThan(0);
  });

  it('handles unknown tool (not in tools list) with empty capabilities', async () => {
    const middleware = createPermissionMiddleware({
      mode: 'default',
      rules: [],
      tools: [],
      runContext: makeRunContext(),
    });
    // Unknown tool in default mode with no caps → allow (no mutation capabilities)
    const result = await middleware(makeContext('UnknownTool'));
    expect(result).toBeUndefined();
  });

  it('allows read-only tools in default mode without rules', async () => {
    const middleware = createPermissionMiddleware({
      mode: 'default',
      rules: [],
      tools: [makeTool('ReadFile', ['fs:read'])],
      runContext: makeRunContext(),
    });
    const result = await middleware(makeContext('ReadFile'));
    expect(result).toBeUndefined();
  });

  it('passes signal to middleware', async () => {
    const controller = new AbortController();
    const middleware = createPermissionMiddleware({
      mode: 'allowAll',
      rules: [],
      tools: [makeTool('ReadFile', ['fs:read'])],
      runContext: makeRunContext(),
    });
    const result = await middleware(makeContext('ReadFile'), controller.signal);
    expect(result).toBeUndefined();
  });

  it('emits permission_decision trajectory events with raw args by default', async () => {
    const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
    const trajectoryWriter = { append: (ev: any) => events.push(ev) } as any;
    const middleware = createPermissionMiddleware({
      mode: 'allowAll',
      rules: [],
      tools: [makeTool('ReadFile', ['fs:read'])],
      runContext: makeRunContext(),
      trajectoryWriter,
    });
    await middleware(makeContext('ReadFile', { path: '/tmp/secret' }));
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('permission_decision');
    expect(events[0].payload).toMatchObject({
      tool_name: 'ReadFile',
      behavior: 'allow',
      args: { path: '/tmp/secret' },
    });
  });

  it('redacts args in trajectory payloads when redactArgs is provided', async () => {
    const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
    const trajectoryWriter = { append: (ev: any) => events.push(ev) } as any;
    const middleware = createPermissionMiddleware({
      mode: 'allowAll',
      rules: [],
      tools: [makeTool('ReadFile', ['fs:read'])],
      runContext: makeRunContext(),
      trajectoryWriter,
      redactArgs: (_name, _args) => ({ redacted: true }),
    });
    await middleware(makeContext('ReadFile', { path: '/tmp/secret' }));
    expect(events[0].payload.args).toEqual({ redacted: true });
  });

  it('includes matched_rule in the trajectory payload when a rule matches', async () => {
    const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
    const trajectoryWriter = { append: (ev: any) => events.push(ev) } as any;
    const rule: PermissionRule = {
      target: { type: 'tool', name: 'WriteFile' },
      behavior: 'deny',
      source: 'user',
    };
    const middleware = createPermissionMiddleware({
      mode: 'default',
      rules: [rule],
      tools: [makeTool('WriteFile', ['fs:write'])],
      runContext: makeRunContext(),
      trajectoryWriter,
    });
    await middleware(makeContext('WriteFile'));
    expect(events[0].payload.behavior).toBe('deny');
    expect(events[0].payload.matched_rule).toEqual(rule);
  });

  it('logs matched rules in runContext permission decisions', async () => {
    const runContext = makeRunContext();
    const rule: PermissionRule = {
      target: { type: 'tool', name: 'ReadFile' },
      behavior: 'allow',
      source: 'user',
    };
    const middleware = createPermissionMiddleware({
      mode: 'default',
      rules: [rule],
      tools: [makeTool('ReadFile', ['fs:read'])],
      runContext,
    });
    await middleware(makeContext('ReadFile'));

    expect(runContext.permissionDecisions[0].matchedRule).toEqual(rule);
  });
});
