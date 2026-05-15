import type { Model } from '@researchcomputer/ai-provider';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { SdkTool } from './tools.js';

export interface TaskBudget { maxTurns: number; maxTokens?: number; timeoutMs?: number; }
export interface TeammateConfig { name: string; prompt: string; taskId: string; parentTaskId?: string; budget: TaskBudget; mergeStrategy?: 'report' | 'diff' | 'pr'; systemPrompt?: string; model?: Model<any>; tools?: SdkTool<any, any>[]; isolate?: boolean; }
export interface TeamAgent { name: string; taskId: string; status: 'idle' | 'running' | 'stopped'; budget: TaskBudget; terminationReason?: 'taskComplete' | 'budgetExhausted' | 'parentAbort' | 'error'; error?: string; }
export interface Team { name: string; leader: TeamAgent; teammates: Map<string, TeamAgent>; }
export interface TeamConfig { name: string; leaderSystemPrompt?: string; model?: Model<any>; }

/**
 * Snapshot of swarm topology for durable-session-state persistence. Does
 * NOT carry Agent instances, mailbox contents, or abort state — resumed
 * teammates come up as idle stubs and the leader re-dispatches.
 */
export interface SerializedSwarmState {
  teams: Array<{
    name: string;
    leaderTaskId: string;
    teammates: Array<{
      name: string;
      taskId: string;
      status: 'idle' | 'running' | 'stopped';
      terminationReason?: 'taskComplete' | 'budgetExhausted' | 'parentAbort' | 'error';
      budget: TaskBudget;
      error?: string;
    }>;
  }>;
}

export interface SwarmManager {
  createTeam(config: TeamConfig): Team;
  spawnTeammate(teamName: string, config: TeammateConfig): Promise<TeamAgent>;
  sendMessage(from: string, to: string, message: AgentMessage): void;
  removeTeammate(teamName: string, name: string): Promise<void>;
  destroyTeam(teamName: string): Promise<void>;
  getTeam(name: string): Team | undefined;
  /** Phase 4 — snapshot swarm topology for persistence. */
  serializeState(): SerializedSwarmState;
  /**
   * Phase 4 — insert a "stub" teammate record (metadata only, no Agent
   * instance) into an existing team. Used by the factory on resume to
   * rebuild the `Team.teammates` map in a visibly-idle shape. Interaction
   * via `sendMessage` to a stub throws until the leader re-dispatches with
   * `spawnTeammate`.
   */
  hydrateTeammateStub(teamName: string, record: TeamAgent): void;
}
