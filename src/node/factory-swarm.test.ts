import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getModel } from '@researchcomputer/ai-provider';
import { createAssistantMessageEventStream } from '@researchcomputer/ai-provider';
import { createAgent } from './factory.js';
import type { SessionSnapshot } from '../core/types.js';
import type { StreamFn } from '@mariozechner/pi-agent-core';

/**
 * Phase 4 — swarm topology survives a resume as idle stubs.
 */
describe('createAgent — Phase 4 swarm resume', () => {
  let sessionDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p4-sess-'));
    memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p4-mem-'));
  });
  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true });
    await fs.rm(memoryDir, { recursive: true, force: true });
  });

  it('persists serialized swarm state in contextState on dispose', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const a = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      enableSwarm: true,
    });
    // Inject a stub teammate directly — simulates a teammate that was
    // created mid-session. We avoid spawnTeammate here so we don't actually
    // trigger an LLM call.
    a.swarm!.hydrateTeammateStub('default', {
      name: 'alice',
      taskId: 'task-alpha',
      status: 'running',
      budget: { maxTurns: 5 },
    });
    await a.dispose();

    const files = await fs.readdir(sessionDir);
    const snapFile = files.find((f) => f.endsWith('.json') && !f.endsWith('.telemetry.json'))!;
    const snap = JSON.parse(await fs.readFile(path.join(sessionDir, snapFile), 'utf-8')) as SessionSnapshot;
    expect(snap.contextState?.swarmState).toBeDefined();
    expect(snap.contextState!.swarmState!.teams).toHaveLength(1);
    const team = snap.contextState!.swarmState!.teams[0];
    expect(team.name).toBe('default');
    // status was 'running' at stub-time; hydrateTeammateStub normalized it to idle.
    expect(team.teammates[0].name).toBe('alice');
    expect(team.teammates[0].status).toBe('idle');
    expect(team.teammates[0].taskId).toBe('task-alpha');
  });

  it('rehydrates teammate stubs on resume and emits interrupt warning for running ones', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const a = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      enableSwarm: true,
    });
    // Insert a teammate and then manually mark it running in the serialized
    // state. Easiest way is to write the snapshot directly rather than go
    // through hydrateTeammateStub (which forces idle).
    await a.dispose();

    const files = await fs.readdir(sessionDir);
    const snapFile = files.find((f) => f.endsWith('.json') && !f.endsWith('.telemetry.json'))!;
    const snap = JSON.parse(await fs.readFile(path.join(sessionDir, snapFile), 'utf-8')) as SessionSnapshot;
    // Mutate the saved state to carry a 'running' teammate.
    snap.contextState = {
      ...snap.contextState!,
      swarmState: {
        teams: [
          {
            name: 'default',
            leaderTaskId: 'team-default-leader',
            teammates: [
              { name: 'bob', taskId: 't-bob', status: 'running', budget: { maxTurns: 3 } },
            ],
          },
        ],
      },
    };
    await fs.writeFile(path.join(sessionDir, snapFile), JSON.stringify(snap, null, 2), 'utf-8');

    const resumed = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      enableSwarm: true,
      sessionId: snap.id,
    });
    const team = resumed.swarm!.getTeam('default')!;
    expect(team.teammates.has('bob')).toBe(true);
    expect(team.teammates.get('bob')!.status).toBe('idle');

    const warning = resumed.getWarnings().find((w) => w.code === 'swarm_teammates_interrupted');
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/bob/);
    await resumed.dispose();
  });

  it('sending a message to a stub raises a clear TEAMMATE_STUB error', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const a = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      enableSwarm: true,
    });
    a.swarm!.hydrateTeammateStub('default', {
      name: 'charlie',
      taskId: 't',
      status: 'idle',
      budget: { maxTurns: 1 },
    });
    expect(() =>
      a.swarm!.sendMessage('leader', 'charlie', { role: 'user', content: 'hi' } as any),
    ).toThrow(/stub|re-dispatch/i);
    await a.dispose();
  });

  it('passes resolved hosted auth tokens to spawned swarm teammates', async () => {
    const observedApiKeys: Array<string | undefined> = [];
    const streamFn: StreamFn = (model, _ctx, options) => {
      observedApiKeys.push((options as { apiKey?: string } | undefined)?.apiKey);
      const stream = createAssistantMessageEventStream();
      const msg = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'done' }],
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
    };

    const model = getModel('openai', 'gpt-4o-mini');
    const a = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      enableSwarm: true,
      streamFn,
    });

    await a.swarm!.spawnTeammate('default', {
      name: 'auth-child',
      taskId: 't-auth',
      prompt: 'do work',
      budget: { maxTurns: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(observedApiKeys).toContain('t');
    await a.dispose();
  });
});
