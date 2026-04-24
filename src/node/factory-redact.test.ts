import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getModel } from '@researchcomputer/ai-provider';
import { createAssistantMessageEventStream } from '@researchcomputer/ai-provider';
import { Type } from '@sinclair/typebox';
import { createAgent } from './factory.js';
import { createKeyRedactor, createContentRedactor } from '../core/trajectory/redactors.js';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import type { Capability } from '../core/types.js';

/**
 * These tests drive real tool calls through a mocked streamFn and then
 * inspect the trajectory JSONL on disk to confirm redaction actually applied.
 * The previous version of this file called `redactor(...)` directly and
 * asserted `snap.version === 2` — neither proved wiring worked.
 */

function makeToolCallStream(toolName: string, args: Record<string, unknown>): StreamFn {
  let turn = 0;
  return (m) => {
    turn++;
    const stream = createAssistantMessageEventStream();
    const msg = {
      role: 'assistant' as const,
      content:
        turn === 1
          ? [{ type: 'toolCall' as const, id: 'tc-1', name: toolName, arguments: args }]
          : [{ type: 'text' as const, text: 'done' }],
      stopReason: turn === 1 ? ('toolUse' as const) : ('stop' as const),
      api: m.api,
      provider: m.provider,
      model: m.id,
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
    stream.push({
      type: 'done',
      reason: msg.stopReason === 'toolUse' ? 'toolUse' : 'stop',
      message: msg,
    });
    return stream;
  };
}

const echoTool = {
  name: 'EchoTool',
  label: 'Echo Tool',
  description: 'Echoes its command argument',
  parameters: Type.Object({
    command: Type.String(),
    apiKey: Type.Optional(Type.String()),
  }),
  capabilities: [] as Capability[],
  async execute() {
    return { content: [{ type: 'text' as const, text: 'ok' }], details: {} };
  },
};

describe('createAgent — Phase 5 redaction', () => {
  let sessionDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p5-sess-'));
    memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p5-mem-'));
  });
  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true });
    await fs.rm(memoryDir, { recursive: true, force: true });
  });

  async function readTrajectoryEvents(): Promise<Record<string, unknown>[]> {
    const entries = await fs.readdir(sessionDir);
    const trajFile = entries.find((e) => e.endsWith('.trajectory.jsonl'))!;
    const raw = await fs.readFile(path.join(sessionDir, trajFile), 'utf-8');
    return raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  }

  it('redactArgs scrubs tool_call args written to the trajectory JSONL', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      tools: [echoTool],
      streamFn: makeToolCallStream('EchoTool', { command: 'echo hello', apiKey: 'sk-secret' }),
      redactArgs: createKeyRedactor(['apiKey']),
    });
    await agent.prompt('run it');
    await agent.dispose();

    const events = await readTrajectoryEvents();
    const toolCall = events.find(
      (e) =>
        e.event_type === 'tool_call' &&
        (e.payload as { tool_call_id?: string }).tool_call_id === 'tc-1',
    );
    expect(toolCall).toBeDefined();
    const args = (toolCall!.payload as { args: { command: string; apiKey: string } }).args;
    expect(args.apiKey).toBe('[redacted]');
    expect(args.command).toBe('echo hello'); // non-sensitive field preserved
  });

  it('redactMessages scrubs secrets from llm_api_call.request_messages', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      streamFn: (m) => {
        const stream = createAssistantMessageEventStream();
        const msg = {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'ok' }],
          stopReason: 'stop' as const,
          api: m.api,
          provider: m.provider,
          model: m.id,
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
      },
      redactMessages: createContentRedactor(),
    });
    await agent.prompt('my key is sk-abcdefghijklmnopqrstuvwxyz1234 please help');
    await agent.dispose();

    const events = await readTrajectoryEvents();
    const llmCall = events.find((e) => e.event_type === 'llm_api_call');
    expect(llmCall).toBeDefined();
    const serialized = JSON.stringify(
      (llmCall!.payload as { request_messages: unknown }).request_messages,
    );
    expect(serialized).not.toContain('sk-abcdef');
    expect(serialized).toContain('[redacted]');
  });

  it('llm_api_call.request_messages contains turn-input only, not the just-emitted assistant reply', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    let turn = 0;
    const streamFn: StreamFn = (m) => {
      turn++;
      const stream = createAssistantMessageEventStream();
      const msg = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: `reply-${turn}` }],
        stopReason: 'stop' as const,
        api: m.api,
        provider: m.provider,
        model: m.id,
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
    };

    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      streamFn,
    });
    await agent.prompt('first');
    await agent.prompt('second');
    await agent.dispose();

    const events = await readTrajectoryEvents();
    const llmCalls = events.filter((e) => e.event_type === 'llm_api_call');
    expect(llmCalls).toHaveLength(2);

    const turn2Messages = (llmCalls[1].payload as { request_messages: unknown[] })
      .request_messages;
    const serialized = JSON.stringify(turn2Messages);
    // The assistant's own turn-2 reply must NOT appear in turn 2's request
    expect(serialized).not.toContain('reply-2');
    // But turn 1's reply (historical context) IS part of turn 2's input
    expect(serialized).toContain('reply-1');
  });

  it('a throwing redactArgs emits a redact_args_failed warning but does NOT abort the tool call', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      tools: [echoTool],
      streamFn: makeToolCallStream('EchoTool', { command: 'echo ok' }),
      redactArgs: () => {
        throw new Error('redactArgs bug');
      },
    });
    await agent.prompt('go');
    await agent.dispose();

    const warnings = agent.getWarnings();
    expect(warnings.some((w) => w.code === 'redact_args_failed')).toBe(true);

    // Tool call still completed — trajectory has a tool_result
    const events = await readTrajectoryEvents();
    expect(events.some((e) => e.event_type === 'tool_result')).toBe(true);
  });

  it('a throwing redactMessages emits a redact_messages_failed warning and does not break the session', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      streamFn: (m) => {
        const stream = createAssistantMessageEventStream();
        const msg = {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'ok' }],
          stopReason: 'stop' as const,
          api: m.api,
          provider: m.provider,
          model: m.id,
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
      },
      redactMessages: () => {
        throw new Error('redactMessages bug');
      },
    });
    await agent.prompt('hello');
    await agent.dispose();

    const warnings = agent.getWarnings();
    expect(warnings.some((w) => w.code === 'redact_messages_failed')).toBe(true);
    // Trajectory still got written
    const events = await readTrajectoryEvents();
    expect(events.some((e) => e.event_type === 'llm_api_call')).toBe(true);
  });
});
