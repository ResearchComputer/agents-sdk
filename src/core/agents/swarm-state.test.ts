import { describe, it, expect } from 'vitest';
import { createSwarmManager } from './swarm.js';
import { createAssistantMessageEventStream } from '@researchcomputer/ai-provider';
import type { Model } from '@researchcomputer/ai-provider';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

function fakeModel(): Model<any> {
  return {
    id: 'test',
    name: 'test',
    api: 'openai-completions',
    provider: 'openai' as any,
    baseUrl: 'http://x',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 500,
  } as unknown as Model<any>;
}

function makeSwarm(): ReturnType<typeof createSwarmManager> {
  return createSwarmManager({
    model: fakeModel(),
    convertToLlm: (msgs: AgentMessage[]) => msgs as any,
  });
}

function makeTextStreamFn(outputs: string[]) {
  let index = 0;
  return ((model: Model<any>) => {
    const stream = createAssistantMessageEventStream();
    const text = outputs[index++] ?? outputs[outputs.length - 1] ?? '';
    const msg = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
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

async function waitFor(assertion: () => boolean | undefined, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(assertion()).toBe(true);
}

describe('swarm.serializeState', () => {
  it('returns { teams: [] } when no teams exist', () => {
    const s = makeSwarm();
    expect(s.serializeState().teams).toEqual([]);
  });

  it('includes team name, leader taskId, and empty teammates for a bare team', () => {
    const s = makeSwarm();
    s.createTeam({ name: 'squad-1' });
    const state = s.serializeState();
    expect(state.teams).toHaveLength(1);
    expect(state.teams[0].name).toBe('squad-1');
    expect(state.teams[0].leaderTaskId).toBe('team-squad-1-leader');
    expect(state.teams[0].teammates).toEqual([]);
  });

  it('captures stub teammate records inserted via hydrateTeammateStub', () => {
    const s = makeSwarm();
    s.createTeam({ name: 'default' });
    s.hydrateTeammateStub('default', {
      name: 'alice',
      taskId: 'task-1',
      status: 'idle',
      budget: { maxTurns: 10 },
      terminationReason: 'taskComplete',
    });
    const state = s.serializeState();
    const t = state.teams[0].teammates[0];
    expect(t.name).toBe('alice');
    expect(t.taskId).toBe('task-1');
    expect(t.status).toBe('idle');
    expect(t.terminationReason).toBe('taskComplete');
    expect(t.budget.maxTurns).toBe(10);
  });
});

describe('swarm.hydrateTeammateStub', () => {
  it('inserts a TeamAgent record without starting an agent', () => {
    const s = makeSwarm();
    s.createTeam({ name: 'default' });
    s.hydrateTeammateStub('default', {
      name: 'stub-1',
      taskId: 'task-stub',
      status: 'idle',
      budget: { maxTurns: 5 },
    });
    const team = s.getTeam('default')!;
    const teammate = team.teammates.get('stub-1');
    expect(teammate).toBeDefined();
    expect(teammate!.status).toBe('idle');
    expect(teammate!.budget.maxTurns).toBe(5);
  });

  it('throws TEAM_NOT_FOUND when the team does not exist', () => {
    const s = makeSwarm();
    expect(() =>
      s.hydrateTeammateStub('ghost', {
        name: 'x',
        taskId: 't',
        status: 'idle',
        budget: { maxTurns: 1 },
      }),
    ).toThrow(/TEAM_NOT_FOUND|not found/);
  });

  it('throws TEAMMATE_NOT_FOUND when sendMessage targets an unknown recipient', () => {
    const s = makeSwarm();
    s.createTeam({ name: 'default' });
    expect(() =>
      s.sendMessage('leader', 'who-is-this', { role: 'user', content: 'hi' } as unknown as AgentMessage),
    ).toThrow(/TEAMMATE_NOT_FOUND|not found/i);
  });

  it('removeTeammate aborts and clears the mailbox for a live teammate', async () => {
    const stubStreamFn = (() => {
      const stream = createAssistantMessageEventStream();
      const msg = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'hi' }],
        stopReason: 'stop' as const,
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'test',
        timestamp: Date.now(),
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: 'start', partial: msg });
      stream.push({ type: 'done', reason: 'stop', message: msg });
      return stream;
    }) as any;

    const s = createSwarmManager({
      model: fakeModel(),
      convertToLlm: (msgs: AgentMessage[]) => msgs as any,
      streamFn: stubStreamFn,
    });
    s.createTeam({ name: 'default' });
    await s.spawnTeammate('default', {
      name: 'live-1',
      taskId: 't-live',
      prompt: 'work on it',
      budget: { maxTurns: 1 },
    });
    await s.removeTeammate('default', 'live-1');
    const team = s.getTeam('default')!;
    expect(team.teammates.has('live-1')).toBe(false);
  });

  it('removeTeammate is a no-op when the team does not exist', async () => {
    const s = makeSwarm();
    await expect(s.removeTeammate('ghost', 'anyone')).resolves.toBeUndefined();
  });

  it('removeTeammate is a no-op when the teammate does not exist', async () => {
    const s = makeSwarm();
    s.createTeam({ name: 'default' });
    await expect(s.removeTeammate('default', 'missing')).resolves.toBeUndefined();
  });

  it('throws TEAMMATE_STUB when sendMessage targets a stub', () => {
    const s = makeSwarm();
    s.createTeam({ name: 'default' });
    s.hydrateTeammateStub('default', {
      name: 'stub-mail',
      taskId: 't',
      status: 'idle',
      budget: { maxTurns: 1 },
    });
    expect(() =>
      s.sendMessage('leader', 'stub-mail', { role: 'user', content: 'hi' } as unknown as AgentMessage),
    ).toThrow(/stub|re-dispatch/i);
  });

  it('delivers a completed teammate result as a swarmReport to the leader', async () => {
    const s = createSwarmManager({
      model: fakeModel(),
      convertToLlm: (msgs: AgentMessage[]) => msgs as any,
      streamFn: makeTextStreamFn(['teammate findings', 'leader acknowledged']),
    });
    s.createTeam({ name: 'default' });

    const teammate = await s.spawnTeammate('default', {
      name: 'researcher',
      taskId: 'task-report',
      prompt: 'inspect the repo',
      budget: { maxTurns: 5 },
    });
    const team = s.getTeam('default')!;
    const leaderAgent = (team.leader as any).agent;

    await waitFor(() =>
      leaderAgent.state.messages.some((m: any) => m.role === 'swarmReport' && m.content === 'teammate findings'),
    );
    await leaderAgent.waitForIdle();

    const report = leaderAgent.state.messages.find((m: any) => m.role === 'swarmReport') as any;
    expect(report.fromAgent).toBe('researcher');
    expect(report.taskId).toBe('task-report');
    expect(teammate.status).toBe('idle');
    expect(teammate.terminationReason).toBe('taskComplete');
    expect(
      leaderAgent.state.messages.some((m: any) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some((part: any) => part.type === 'text' && part.text === 'leader acknowledged'),
      ),
    ).toBe(true);
  });
});
