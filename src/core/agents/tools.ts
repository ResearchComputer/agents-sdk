import { Type } from '@sinclair/typebox';
import type { SdkTool, SwarmManager } from '../types.js';

/**
 * Creates swarm management tools for a team leader.
 */
export function createSwarmTools(teamName: string, swarm: SwarmManager): SdkTool<any, any>[] {
  const spawnTool: SdkTool<any, any> = {
    name: 'SpawnTeammate',
    label: 'Spawn Teammate',
    description: 'Spawn a new teammate agent to work on a task',
    parameters: Type.Object({
      name: Type.String({ description: 'Name for the teammate' }),
      prompt: Type.String({ description: 'Task prompt for the teammate' }),
      systemPrompt: Type.Optional(Type.String({ description: 'Optional system prompt override' })),
    }),
    capabilities: ['swarm:mutate'],
    async execute(_toolCallId, params) {
      const teammate = await swarm.spawnTeammate(teamName, {
        name: params.name,
        prompt: params.prompt,
        taskId: globalThis.crypto.randomUUID(),
        budget: { maxTurns: 20 },
        systemPrompt: params.systemPrompt,
      });
      return {
        content: [{ type: 'text' as const, text: `Spawned teammate "${teammate.name}" (task: ${teammate.taskId})` }],
        details: { name: teammate.name, taskId: teammate.taskId },
      };
    },
  };

  const sendTool: SdkTool<any, any> = {
    name: 'SendMessage',
    label: 'Send Message',
    description: 'Send a message to a teammate',
    parameters: Type.Object({
      to: Type.String({ description: 'Name of the recipient teammate' }),
      message: Type.String({ description: 'Message content to send' }),
    }),
    capabilities: ['swarm:mutate'],
    async execute(_toolCallId, params) {
      const agentMessage = {
        role: 'user' as const,
        content: params.message,
        timestamp: Date.now(),
      };
      swarm.sendMessage(teamName, params.to, agentMessage);
      return {
        content: [{ type: 'text' as const, text: `Message sent to "${params.to}"` }],
        details: { to: params.to },
      };
    },
  };

  const dismissTool: SdkTool<any, any> = {
    name: 'DismissTeammate',
    label: 'Dismiss Teammate',
    description: 'Remove a teammate from the team',
    parameters: Type.Object({
      name: Type.String({ description: 'Name of the teammate to dismiss' }),
    }),
    capabilities: ['swarm:mutate'],
    async execute(_toolCallId, params) {
      await swarm.removeTeammate(teamName, params.name);
      return {
        content: [{ type: 'text' as const, text: `Dismissed teammate "${params.name}"` }],
        details: { name: params.name },
      };
    },
  };

  return [spawnTool, sendTool, dismissTool];
}
