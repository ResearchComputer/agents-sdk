import { describe, it, expect, vi } from 'vitest';
import { createSwarmTools } from './tools.js';
import type { SwarmManager } from '../types.js';

function createMockSwarmManager(): SwarmManager {
  return {
    createTeam: vi.fn(),
    spawnTeammate: vi.fn().mockResolvedValue({ name: 'worker', taskId: 'task-1', status: 'running', budget: { maxTurns: 20 } }),
    sendMessage: vi.fn(),
    removeTeammate: vi.fn().mockResolvedValue(undefined),
    destroyTeam: vi.fn().mockResolvedValue(undefined),
    getTeam: vi.fn(),
    serializeState: vi.fn().mockReturnValue({ teams: [] }),
    hydrateTeammateStub: vi.fn(),
  };
}

describe('createSwarmTools', () => {
  it('returns three tools', () => {
    const swarm = createMockSwarmManager();
    const tools = createSwarmTools('test-team', swarm);
    expect(tools).toHaveLength(3);
  });

  it('has SpawnTeammate tool', () => {
    const swarm = createMockSwarmManager();
    const tools = createSwarmTools('test-team', swarm);
    const spawn = tools.find(t => t.name === 'SpawnTeammate');
    expect(spawn).toBeDefined();
    expect(spawn!.description).toContain('Spawn');
    expect(spawn!.capabilities).toEqual(['swarm:mutate']);
  });

  it('has SendMessage tool', () => {
    const swarm = createMockSwarmManager();
    const tools = createSwarmTools('test-team', swarm);
    const send = tools.find(t => t.name === 'SendMessage');
    expect(send).toBeDefined();
    expect(send!.description).toContain('message');
  });

  it('has DismissTeammate tool', () => {
    const swarm = createMockSwarmManager();
    const tools = createSwarmTools('test-team', swarm);
    const dismiss = tools.find(t => t.name === 'DismissTeammate');
    expect(dismiss).toBeDefined();
    expect(dismiss!.description).toContain('Remove');
  });

  it('SpawnTeammate calls swarm.spawnTeammate', async () => {
    const swarm = createMockSwarmManager();
    const tools = createSwarmTools('test-team', swarm);
    const spawn = tools.find(t => t.name === 'SpawnTeammate')!;
    const result = await spawn.execute('call-1', { name: 'worker', prompt: 'do stuff' });
    expect(swarm.spawnTeammate).toHaveBeenCalledWith('test-team', expect.objectContaining({
      name: 'worker',
      prompt: 'do stuff',
    }));
    expect(result.content[0]).toHaveProperty('text');
  });

  it('SendMessage calls swarm.sendMessage', async () => {
    const swarm = createMockSwarmManager();
    const tools = createSwarmTools('test-team', swarm);
    const send = tools.find(t => t.name === 'SendMessage')!;
    await send.execute('call-2', { to: 'worker', message: 'hello' });
    expect(swarm.sendMessage).toHaveBeenCalledWith('test-team', 'worker', expect.objectContaining({
      role: 'user',
      content: 'hello',
    }));
  });

  it('DismissTeammate calls swarm.removeTeammate', async () => {
    const swarm = createMockSwarmManager();
    const tools = createSwarmTools('test-team', swarm);
    const dismiss = tools.find(t => t.name === 'DismissTeammate')!;
    await dismiss.execute('call-3', { name: 'worker' });
    expect(swarm.removeTeammate).toHaveBeenCalledWith('test-team', 'worker');
  });
});
