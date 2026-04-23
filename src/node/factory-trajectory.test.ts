import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getModel } from '@researchcomputer/ai-provider';
import { createAssistantMessageEventStream } from '@researchcomputer/ai-provider';
import { createAgent } from './factory.js';
import { createValidator } from '../core/spec/validator.js';
import { findSpecDir, loadSchema } from './spec/loader.js';
import { Type } from '@sinclair/typebox';
import type { StreamFn } from '@mariozechner/pi-agent-core';

describe('createAgent trajectory integration', () => {
  let sessionDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'traj-sess-'));
    memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'traj-mem-'));
  });

  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true });
    await fs.rm(memoryDir, { recursive: true, force: true });
  });

  it('writes a trajectory JSONL file with session_start and session_end', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 'test-jwt',
      sessionDir,
      memoryDir,
    });

    await agent.dispose();

    const entries = await fs.readdir(sessionDir);
    const trajFiles = entries.filter(e => e.endsWith('.trajectory.jsonl'));
    expect(trajFiles).toHaveLength(1);

    const content = await fs.readFile(path.join(sessionDir, trajFiles[0]), 'utf-8');
    const lines = content.trim().split('\n').map(l => JSON.parse(l));
    const types = lines.map(l => l.event_type);
    expect(types).toContain('session_start');
    expect(types).toContain('session_end');
    // session_start must be first (parent null)
    expect(lines[0].event_type).toBe('session_start');
    expect(lines[0].parent_event_id).toBeNull();
    // session_end must be last
    expect(lines[lines.length - 1].event_type).toBe('session_end');
    // All events share a single trajectory_id
    const tids = new Set(lines.map(l => l.trajectory_id));
    expect(tids.size).toBe(1);
  });

  it('every emitted event validates against trajectory-event.v1 schema', async () => {
    const v = createValidator();
    const specDir = await findSpecDir();
    v.register('trajectory-event', '1', await loadSchema('trajectory-event', '1', specDir));

    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 'test-jwt',
      sessionDir,
      memoryDir,
    });
    await agent.dispose();

    const entries = await fs.readdir(sessionDir);
    const trajFile = entries.find(e => e.endsWith('.trajectory.jsonl'))!;
    const content = await fs.readFile(path.join(sessionDir, trajFile), 'utf-8');
    for (const line of content.trim().split('\n')) {
      const event = JSON.parse(line);
      const result = v.validate('trajectory-event', '1', event);
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error('Failed:', event.event_type, JSON.stringify((result.error.details as any)?.errors, null, 2));
      }
      expect(result.ok).toBe(true);
    }
  });

  it('session_start references the configured model + system prompt hash', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 'test-jwt',
      sessionDir,
      memoryDir,
      systemPrompt: 'You are a test agent.',
    });
    await agent.dispose();

    const entries = await fs.readdir(sessionDir);
    const trajFile = entries.find(e => e.endsWith('.trajectory.jsonl'))!;
    const firstLine = (await fs.readFile(path.join(sessionDir, trajFile), 'utf-8'))
      .split('\n')[0];
    const sessionStart = JSON.parse(firstLine);
    expect(sessionStart.payload.model_id).toBe(model.id);
    expect(sessionStart.payload.provider_name).toBe(model.provider);
    expect(sessionStart.payload.system_prompt_hash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('records nonzero tool_result durations in trajectory events', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    let turn = 0;
    const streamFn: StreamFn = (m) => {
      turn++;
      const stream = createAssistantMessageEventStream();
      const msg = {
        role: 'assistant' as const,
        content: turn === 1
          ? [{ type: 'toolCall' as const, id: 'call-1', name: 'SlowTool', arguments: {} }]
          : [{ type: 'text' as const, text: 'done' }],
        stopReason: turn === 1 ? 'toolUse' as const : 'stop' as const,
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
      stream.push({ type: 'done', reason: msg.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: msg });
      return stream;
    };
    const slowTool = {
      name: 'SlowTool',
      label: 'Slow Tool',
      description: 'Sleeps briefly',
      parameters: Type.Object({}),
      capabilities: [],
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { content: [{ type: 'text' as const, text: 'ok' }], details: {} };
      },
    };

    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 'test-jwt',
      sessionDir,
      memoryDir,
      tools: [slowTool],
      streamFn,
    });
    await agent.prompt('call the slow tool');
    await agent.dispose();

    const entries = await fs.readdir(sessionDir);
    const trajFile = entries.find(e => e.endsWith('.trajectory.jsonl'))!;
    const events = (await fs.readFile(path.join(sessionDir, trajFile), 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const result = events.find((event) => event.event_type === 'tool_result' && event.payload.tool_call_id === 'call-1');

    expect(result).toBeDefined();
    expect(result.payload.duration_ms).toBeGreaterThan(0);
  });
});
