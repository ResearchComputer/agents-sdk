import { Agent as PiAgent } from '@mariozechner/pi-agent-core';
import type { AgentMessage, StreamFn, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Model } from '@researchcomputer/ai-provider';
import type {
  SdkTool,
  SerializedSwarmState,
  SwarmManager,
  SwarmReportMessage,
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
  ownsLeaderAgent: boolean;
  reportDelivery: Promise<void>;
}

function isLive(t: TeammateEntry): t is InternalTeamAgent {
  return 'agent' in t && 'mailbox' in t;
}

export interface SwarmManagerDefaults {
  model: Model<any>;
  tools?: SdkTool<any, any>[];
  leaderAgent?: PiAgent;
  convertToLlm: (messages: AgentMessage[]) => import('@researchcomputer/ai-provider').Message[] | Promise<import('@researchcomputer/ai-provider').Message[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  beforeToolCall?: ConstructorParameters<typeof PiAgent>[0] extends infer O ? O extends { beforeToolCall?: infer B } ? B : never : never;
  afterToolCall?: ConstructorParameters<typeof PiAgent>[0] extends infer O ? O extends { afterToolCall?: infer A } ? A : never : never;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn?: StreamFn;
}

type AbortReason = NonNullable<TeamAgent['terminationReason']>;

function getLastAssistantMessage(agent: PiAgent): { content?: unknown; stopReason?: string; errorMessage?: string } | undefined {
  for (let i = agent.state.messages.length - 1; i >= 0; i--) {
    const msg = agent.state.messages[i] as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
    if (msg.role === 'assistant') return msg;
  }
  return undefined;
}

function extractAssistantText(agent: PiAgent): string {
  const msg = getLastAssistantMessage(agent);
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

function reportTextFor(teammate: TeamAgent, agent: PiAgent): string {
  const text = extractAssistantText(agent).trim();
  if (teammate.terminationReason === 'taskComplete') {
    return text || '(no output)';
  }
  if (teammate.terminationReason === 'budgetExhausted') {
    return [
      `Teammate "${teammate.name}" stopped because its budget was exhausted.`,
      text ? `Partial output:\n${text}` : undefined,
    ].filter(Boolean).join('\n\n');
  }
  if (teammate.terminationReason === 'error') {
    return [
      `Teammate "${teammate.name}" failed: ${teammate.error ?? 'unknown error'}.`,
      text ? `Partial output:\n${text}` : undefined,
    ].filter(Boolean).join('\n\n');
  }
  return text || `Teammate "${teammate.name}" stopped.`;
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
      const agent = defaults.leaderAgent ?? createInternalAgent(leaderSystemPrompt, config.model);

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
        ownsLeaderAgent: defaults.leaderAgent === undefined,
        reportDelivery: Promise.resolve(),
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
      let abortReason: AbortReason | undefined;

      const abortForBudget = (reason: AbortReason): void => {
        abortReason = reason;
        abortController.abort();
        agent.abort();
      };

      let observedTurns = 0;
      let observedTokens = 0;
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === 'turn_end') {
          observedTurns += 1;
          const turn = event as { toolResults?: unknown[] };
          const wouldContinue = Array.isArray(turn.toolResults) && turn.toolResults.length > 0;
          if (observedTurns >= config.budget.maxTurns && wouldContinue) {
            abortForBudget('budgetExhausted');
          }
        }
        if (event.type === 'message_end') {
          const msg = event.message as { role?: string; usage?: { input?: number; output?: number; totalTokens?: number } };
          if (msg.role === 'assistant' && msg.usage && config.budget.maxTokens !== undefined) {
            observedTokens += msg.usage.totalTokens ?? ((msg.usage.input ?? 0) + (msg.usage.output ?? 0));
            if (observedTokens > config.budget.maxTokens) {
              abortForBudget('budgetExhausted');
            }
          }
        }
      });

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
          abortForBudget('budgetExhausted');
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

      const deliverReport = (report: SwarmReportMessage): void => {
        team.reportDelivery = team.reportDelivery
          .then(async () => {
            const message = report as unknown as AgentMessage;
            if (team.leader.agent.state.isStreaming) {
              team.leader.agent.followUp(message);
              return;
            }
            await team.leader.agent.prompt(message);
          })
          .catch((err: unknown) => {
            teammate.error = err instanceof Error ? err.message : String(err);
          });
      };

      const finish = (reason: TeamAgent['terminationReason'], err?: unknown): void => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        unsubscribe();

        teammate.status = reason === 'taskComplete' ? 'idle' : 'stopped';
        teammate.terminationReason = reason;
        if (err !== undefined) {
          teammate.error = err instanceof Error ? err.message : String(err);
        }

        if (reason === 'parentAbort') return;

        deliverReport({
          role: 'swarmReport',
          content: reportTextFor(teammate, agent),
          fromAgent: teammate.name,
          taskId: teammate.taskId,
          timestamp: Date.now(),
        });
      };

      // Start agent.prompt non-blocking. Classify via
      // abortController.signal.aborted rather than by string-matching the
      // error message — the previous `err.message.includes('aborted')`
      // test misclassified any error whose message happened to mention
      // the word "aborted" (including unrelated user-facing errors).
      agent.prompt(config.prompt).then(
        () => {
          if (teammate.terminationReason === 'parentAbort') {
            finish('parentAbort');
            return;
          }
          if (abortReason) {
            finish(abortReason);
            return;
          }
          const lastAssistant = getLastAssistantMessage(agent);
          if (lastAssistant?.stopReason === 'error') {
            finish('error', lastAssistant.errorMessage ?? 'teammate stopped with an error');
            return;
          }
          if (lastAssistant?.stopReason === 'aborted') {
            finish(abortController.signal.aborted ? 'parentAbort' : 'error', lastAssistant.errorMessage);
            return;
          }
          finish('taskComplete');
        },
        (err: unknown) => {
          finish(abortReason ?? (abortController.signal.aborted ? 'parentAbort' : 'error'), err);
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
        teammate.terminationReason = 'parentAbort';
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
      if (team.ownsLeaderAgent) {
        team.leader.agent.abort();
      }
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
