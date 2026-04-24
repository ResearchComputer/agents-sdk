import { Agent as PiAgent } from '@mariozechner/pi-agent-core';
import type { AgentMessage, StreamFn, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Model } from '@researchcomputer/ai-provider';
import type {
  SdkTool,
  SerializedSwarmState,
  SwarmManager,
  Team,
  TeamAgent,
  TeamConfig,
  TeammateConfig,
} from '../types.js';
import { SdkError } from '../errors.js';
import { AsyncQueue } from './messages.js';

/**
 * Internal team agent with PiAgent instance, mailbox, and abort controller.
 */
interface InternalTeamAgent extends TeamAgent {
  agent: PiAgent;
  mailbox: AsyncQueue<AgentMessage>;
  abortController: AbortController;
}

/**
 * A teammate can be either a live InternalTeamAgent (has a PiAgent instance)
 * or a resumed stub carrying only metadata. Stubs exist so the public
 * `Team.teammates` map remains populated after session resume; the leader
 * re-dispatches via `spawnTeammate` to promote a stub back to a live
 * teammate.
 */
type TeammateEntry = InternalTeamAgent | TeamAgent;

interface InternalTeam extends Team {
  leader: InternalTeamAgent;
  teammates: Map<string, TeammateEntry>;
}

function isLive(t: TeammateEntry): t is InternalTeamAgent {
  return 'agent' in t && 'mailbox' in t;
}

export interface SwarmManagerDefaults {
  model: Model<any>;
  tools?: SdkTool<any, any>[];
  convertToLlm: (messages: AgentMessage[]) => import('@researchcomputer/ai-provider').Message[] | Promise<import('@researchcomputer/ai-provider').Message[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  beforeToolCall?: ConstructorParameters<typeof PiAgent>[0] extends infer O ? O extends { beforeToolCall?: infer B } ? B : never : never;
  afterToolCall?: ConstructorParameters<typeof PiAgent>[0] extends infer O ? O extends { afterToolCall?: infer A } ? A : never : never;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn?: StreamFn;
}

/**
 * Creates a SwarmManager for coordinating teams of agents.
 */
export function createSwarmManager(defaults: SwarmManagerDefaults): SwarmManager {
  const teams = new Map<string, InternalTeam>();

  function createInternalAgent(
    systemPrompt: string,
    model?: Model<any>,
    tools?: SdkTool<any, any>[],
    abortSignal?: AbortSignal,
  ): PiAgent {
    const agentModel = model ?? defaults.model;
    const agentTools = tools ?? defaults.tools ?? [];

    const agent = new PiAgent({
      initialState: {
        systemPrompt,
        model: agentModel,
        tools: agentTools,
        thinkingLevel: 'off' as ThinkingLevel,
      },
      convertToLlm: defaults.convertToLlm,
      beforeToolCall: defaults.beforeToolCall,
      afterToolCall: defaults.afterToolCall,
      transformContext: defaults.transformContext,
      getApiKey: defaults.getApiKey,
      toolExecution: 'parallel',
      streamFn: defaults.streamFn,
    });

    return agent;
  }

  return {
    createTeam(config: TeamConfig): Team {
      const abortController = new AbortController();
      const leaderSystemPrompt = config.leaderSystemPrompt ?? 'You are a team leader coordinating tasks.';
      const agent = createInternalAgent(leaderSystemPrompt, config.model);

      const leader: InternalTeamAgent = {
        name: 'leader',
        taskId: `team-${config.name}-leader`,
        status: 'idle',
        budget: { maxTurns: Infinity },
        agent,
        mailbox: new AsyncQueue<AgentMessage>(),
        abortController,
      };

      const team: InternalTeam = {
        name: config.name,
        leader,
        teammates: new Map(),
      };

      teams.set(config.name, team);
      return team;
    },

    async spawnTeammate(teamName: string, config: TeammateConfig): Promise<TeamAgent> {
      const team = teams.get(teamName);
      if (!team) {
        throw new SdkError(`Team not found: ${teamName}`, 'TEAM_NOT_FOUND', false);
      }

      const abortController = new AbortController();
      const systemPrompt = config.systemPrompt ?? 'You are a team member working on assigned tasks.';
      const agent = createInternalAgent(systemPrompt, config.model, config.tools);

      // Budget enforcement: setTimeout + clearTimeout beats
      // AbortSignal.timeout here for two reasons:
      //   1. AbortSignal.timeout returns a new signal per call whose
      //      'abort' listener is never removed when the teammate
      //      finishes normally. Over a long session with many short
      //      teammates the listeners accumulate until each timeout
      //      fires naturally, leaking closures over `agent` and
      //      `abortController` the whole time.
      //   2. setTimeout gives us a handle we can cancel from the
      //      resolve branch, so the timer never runs past the work.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (config.budget.timeoutMs) {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          agent.abort();
        }, config.budget.timeoutMs);
      }

      const teammate: InternalTeamAgent = {
        name: config.name,
        taskId: config.taskId,
        status: 'running',
        budget: config.budget,
        agent,
        mailbox: new AsyncQueue<AgentMessage>(),
        abortController,
      };

      team.teammates.set(config.name, teammate);

      // Start agent.prompt non-blocking. Classify via
      // abortController.signal.aborted rather than by string-matching the
      // error message — the previous `err.message.includes('aborted')`
      // test misclassified any error whose message happened to mention
      // the word "aborted" (including unrelated user-facing errors).
      agent.prompt(config.prompt).then(
        () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          teammate.status = 'idle';
          teammate.terminationReason = 'taskComplete';
        },
        (err: unknown) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          teammate.status = 'stopped';
          if (abortController.signal.aborted) {
            teammate.terminationReason = 'budgetExhausted';
          } else {
            teammate.terminationReason = 'error';
            teammate.error = err instanceof Error ? err.message : String(err);
          }
        },
      );

      return teammate;
    },

    sendMessage(from: string, to: string, message: AgentMessage): void {
      // Search across all teams for the recipient
      for (const team of teams.values()) {
        if (team.leader.name === to) {
          team.leader.agent.followUp(message);
          return;
        }
        const teammate = team.teammates.get(to);
        if (teammate) {
          if (!isLive(teammate)) {
            throw new SdkError(
              `Teammate ${to} is a resumed stub — re-dispatch via spawnTeammate before sending messages.`,
              'TEAMMATE_STUB',
              false,
            );
          }
          teammate.agent.followUp(message);
          return;
        }
      }

      throw new SdkError(
        `Teammate not found: ${to}`,
        'TEAMMATE_NOT_FOUND',
        false,
      );
    },

    async removeTeammate(teamName: string, name: string): Promise<void> {
      const team = teams.get(teamName);
      if (!team) return;

      const teammate = team.teammates.get(name);
      if (!teammate) return;

      if (isLive(teammate)) {
        teammate.abortController.abort();
        teammate.agent.abort();
        teammate.mailbox.clear();
      }
      teammate.status = 'stopped';
      team.teammates.delete(name);
    },

    async destroyTeam(teamName: string): Promise<void> {
      const team = teams.get(teamName);
      if (!team) return;

      // Remove all teammates
      for (const name of Array.from(team.teammates.keys())) {
        await this.removeTeammate(teamName, name);
      }

      // Abort leader
      team.leader.abortController.abort();
      team.leader.agent.abort();
      team.leader.status = 'stopped';
      team.leader.mailbox.clear();

      teams.delete(teamName);
    },

    getTeam(name: string): Team | undefined {
      return teams.get(name);
    },

    serializeState(): SerializedSwarmState {
      return {
        teams: Array.from(teams.values()).map((team) => ({
          name: team.name,
          leaderTaskId: team.leader.taskId,
          teammates: Array.from(team.teammates.values()).map((t) => ({
            name: t.name,
            taskId: t.taskId,
            status: t.status,
            budget: t.budget,
            ...(t.terminationReason ? { terminationReason: t.terminationReason } : {}),
            ...(t.error ? { error: t.error } : {}),
          })),
        })),
      };
    },

    hydrateTeammateStub(teamName: string, record: TeamAgent): void {
      const team = teams.get(teamName);
      if (!team) {
        throw new SdkError(`Team not found: ${teamName}`, 'TEAM_NOT_FOUND', false);
      }
      // Stubs always come up as idle regardless of their saved status —
      // see spec §6.5: "running teammates are treated as having been
      // interrupted; the leader can re-dispatch if needed".
      team.teammates.set(record.name, { ...record, status: 'idle' });
    },
  };
}
