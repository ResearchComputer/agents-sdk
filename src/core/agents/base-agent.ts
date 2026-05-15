import { Agent as PiAgent } from '@mariozechner/pi-agent-core';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ImageContent } from '@researchcomputer/ai-provider';
import type {
  Agent,
  McpManager,
  SessionManager,
  MemoryManager,
  SwarmManager,
  CostTracker,
  AgentSnapshot,
  SdkWarning,
  RunContext,
  HookHandler,
  MemorySelection,
  ContextState,
  SessionSnapshot,
  SdkTool,
  Memory,
} from '../types.js';
import type { TelemetryCollector } from '../telemetry/collector.js';
import type { TelemetrySink } from '../telemetry/sink.js';
import type { TrajectoryWriter } from '../trajectory/writer.js';
import type { CoreAdapters, AgentCoreConfig } from '../factory.js';
import { createAgentCore } from '../factory.js';
import { extractUserText } from '../auto-fork.js';
import { runLifecycleHooks } from '../middleware/hooks.js';
import { cloneMessages } from '../util/clone.js';
import { TrajectoryFlushError } from '../errors.js';
import { convertToLlm } from '../context/converter.js';
import { scopeAdaptersForChild } from '../adapters/child-scope.js';
import { buildCostState } from '../factory.js';

export interface BaseAgentOptions {
  agent: PiAgent;
  mcp: McpManager;
  sessions: SessionManager;
  memory: MemoryManager;
  swarm?: SwarmManager;
  costTracker: CostTracker;
  warnings: SdkWarning[];
  config: AgentCoreConfig;
  adapters: CoreAdapters;
  runContext: RunContext;
  hooks: HookHandler[];
  telemetryCollector: TelemetryCollector;
  telemetrySink: TelemetrySink;
  memorySelections: MemorySelection[];
  resumedInterruptedToolCallIds: string[];
  systemPromptHash: string;
  sessionCreatedAt: number;
  trajectoryWriter?: TrajectoryWriter;
  addWarning: (code: string, message: string, cause?: unknown) => void;
  allTools: SdkTool<any, any>[];
  systemPrompt: string;
  memories: Memory[];
}

type AutoForkState = 'idle' | 'forking' | 'disposing';

export class BaseAgent implements Agent {
  public readonly agent: PiAgent;
  public readonly mcp: McpManager;
  public readonly sessions: SessionManager;
  public readonly memory: MemoryManager;
  public readonly swarm?: SwarmManager;
  public readonly costTracker: CostTracker;

  private autoForkState: AutoForkState = 'idle';
  private inFlightAutoFork: Promise<void> | null = null;
  private readonly isDisposing = () => this.autoForkState === 'disposing';

  constructor(private readonly options: BaseAgentOptions) {
    this.agent = options.agent;
    this.mcp = options.mcp;
    this.sessions = options.sessions;
    this.memory = options.memory;
    this.swarm = options.swarm;
    this.costTracker = options.costTracker;

    this.setupAutoFork();
  }

  private setupAutoFork(): void {
    if (!this.options.config.autoFork) return;
    
    const autoFork = this.options.config.autoFork;
    let lastUserMessage: string | undefined;

    this.agent.subscribe((event) => {
      if (event.type === 'message_start') {
        const msg = event.message as { role: string; content: unknown };
        if (msg.role === 'user') {
          const text = extractUserText(msg.content);
          if (text !== undefined) lastUserMessage = text;
        }
      }

      if (
        event.type === 'turn_end' &&
        lastUserMessage &&
        this.autoForkState === 'idle'
      ) {
        this.autoForkState = 'forking';
        const message = lastUserMessage;
        lastUserMessage = undefined;
        this.inFlightAutoFork = this.fork(message, autoFork.branches)
          .then((children) => {
            if (this.autoForkState === 'disposing') return;
            return autoFork.onBranches(children);
          })
          .catch((err) => {
            autoFork.onError?.(err instanceof Error ? err : new Error(String(err)));
          })
          .finally(() => {
            if (this.autoForkState === 'forking') this.autoForkState = 'idle';
            this.inFlightAutoFork = null;
          });
      }
    });
  }

  async prompt(message: string, images?: ImageContent[], extraSystem?: string): Promise<void> {
    if (extraSystem) {
      const original = this.agent.state.systemPrompt;
      this.agent.setSystemPrompt(`${original}\n\n${extraSystem}`);
      try {
        await this.agent.prompt(message, images);
      } finally {
        this.agent.setSystemPrompt(original);
      }
      return;
    }
    await this.agent.prompt(message, images);
  }

  async dispose(): Promise<void> {
    if (this.autoForkState === 'disposing') return;
    const wasForking = this.autoForkState === 'forking';
    this.autoForkState = 'disposing';
    if (wasForking && this.inFlightAutoFork) {
      try {
        await this.inFlightAutoFork;
      } catch {
        // auto-fork errors route to autoFork.onError
      }
    }

    const {
      hooks, runContext, telemetryCollector, trajectoryWriter,
      memorySelections, costTracker, resumedInterruptedToolCallIds,
      swarm, config, systemPromptHash, memories, sessionCreatedAt,
      adapters, telemetrySink, mcp, addWarning
    } = this.options;

    await runLifecycleHooks(hooks, 'SessionEnd', runContext);
    const telemetry = telemetryCollector.finalize();

    const trajId = trajectoryWriter ? trajectoryWriter.trajectoryId : undefined;
    const lastEventId = trajectoryWriter ? (trajectoryWriter.currentEventId() ?? null) : null;

    const contextState: ContextState = {
      selectedMemories: memorySelections.map((s) => ({
        name: s.memory.name,
        score: s.relevanceScore,
        updatedAt: s.updatedAt,
      })),
      costState: buildCostState(costTracker),
      interruptedToolCallIds: [...resumedInterruptedToolCallIds],
      ...(swarm ? { swarmState: swarm.serializeState() } : {}),
    };

    const snapshot: SessionSnapshot = {
      version: 2,
      id: runContext.sessionId,
      trajectoryId: trajId as string,
      lastEventId,
      modelId: config.model.id,
      providerName: config.model.provider,
      systemPromptHash,
      memoryRefs: memories.map(m => m.name),
      telemetry,
      contextState,
      createdAt: sessionCreatedAt,
      updatedAt: Date.now(),
    };

    try {
      await adapters.sessionStore.save(snapshot);
    } catch (err) {
      addWarning('session_save_failed', `Failed to save session: ${(err as Error).message}`, err);
    }

    try {
      await telemetrySink.flush(snapshot);
    } catch (err) {
      addWarning('telemetry_flush_failed', `Failed to flush telemetry: ${(err as Error).message}`, err);
    }

    for (const conn of mcp.getConnections()) {
      try {
        await mcp.disconnect(conn.name);
      } catch (err) {
        addWarning(
          'mcp_disconnect_failed',
          `Failed to disconnect MCP server ${conn.name}: ${(err as Error).message}`,
          err,
        );
      }
    }

    if (swarm) {
      try {
        await swarm.destroyTeam('default');
      } catch (err) {
        addWarning('swarm_cleanup_failed', `Failed to destroy swarm: ${(err as Error).message}`, err);
      }
    }

    if (trajectoryWriter) {
      try {
        trajectoryWriter.append({
          event_type: 'session_end',
          payload: {
            session_id: trajectoryWriter.trajectoryId,
            reason: 'complete',
          },
        });
        await trajectoryWriter.close();
      } catch (err) {
        addWarning(
          'trajectory_flush_failed',
          `Failed to finalize trajectory: ${(err as Error).message}`,
          new TrajectoryFlushError(`Failed to finalize trajectory: ${(err as Error).message}`, { cause: err }),
        );
      }
    }
  }

  getWarnings(): readonly SdkWarning[] {
    return this.options.warnings;
  }

  snapshot(): AgentSnapshot {
    if (this.agent.state.isStreaming) {
      throw new Error('snapshot: cannot snapshot while agent is streaming');
    }
    return {
      id: globalThis.crypto.randomUUID(),
      messages: cloneMessages(this.agent.state.messages),
      createdAt: Date.now(),
    };
  }

  restore(snapshot: AgentSnapshot): void {
    if (this.agent.state.isStreaming) {
      throw new Error('restore: cannot restore while agent is streaming');
    }
    this.agent.replaceMessages(cloneMessages(snapshot.messages));
  }

  private async _spawnChildren(
    baseMessages: AgentMessage[],
    message: string,
    n: number
  ): Promise<Agent[]> {
    if (n < 0) throw new RangeError(`fork: n must be >= 0, got ${n}`);
    if (n === 0) return [];
    if (this.isDisposing()) {
      throw new Error('fork: agent is disposing, cannot spawn children');
    }

    const { config, allTools, systemPrompt, adapters, runContext } = this.options;

    const childConfig: AgentCoreConfig = {
      ...config,
      sessionId: undefined,
      autoFork: undefined,
    };

    const canUseCompleteN =
      !config.streamFn &&
      n > 1 &&
      (config.model.api === 'openai-completions' || config.model.api === 'openai-responses');

    if (canUseCompleteN) {
      const userMsg: AgentMessage = {
        role: 'user',
        content: message,
        timestamp: Date.now(),
      } as AgentMessage;
      const contextMessages = [...baseMessages, userMsg];
      const llmMessages = await convertToLlm(contextMessages);
      const toolDefs = allTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      const ctx = {
        systemPrompt,
        messages: llmMessages,
        tools: toolDefs,
      };

      const apiKey = config.getApiKey
        ? await config.getApiKey(config.model.provider)
        : undefined;
      const firstResponses = await adapters.llmClient.completeN(
        config.model,
        ctx,
        n,
        apiKey ? { apiKey } : undefined,
      );

      const anyHasToolCalls = firstResponses.some((r) =>
        r.content.some((b: any) => b.type === 'toolCall'),
      );
      if (anyHasToolCalls) {
        const children = await Promise.all(
          Array.from({ length: n }, (_, i) =>
            createAgentCore(childConfig, scopeAdaptersForChild(adapters, runContext.sessionId, i)),
          ),
        );
        await Promise.all(
          children.map((child) => {
            child.agent.replaceMessages(cloneMessages(baseMessages));
            return child.prompt(message);
          }),
        );
        return children;
      }

      const children = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          createAgentCore(childConfig, scopeAdaptersForChild(adapters, runContext.sessionId, i)),
        ),
      );

      await Promise.all(
        children.map((child, i) => {
          const msgs = cloneMessages(baseMessages);
          msgs.push(structuredClone(userMsg));
          msgs.push(firstResponses[i] as AgentMessage);
          child.agent.replaceMessages(msgs);
          return Promise.resolve();
        }),
      );

      return children;
    }

    const children = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        createAgentCore(childConfig, scopeAdaptersForChild(adapters, runContext.sessionId, i)),
      ),
    );

    await Promise.all(
      children.map((child) => {
        child.agent.replaceMessages(cloneMessages(baseMessages));
        return child.prompt(message);
      })
    );

    return children;
  }

  async fork(message: string, n: number): Promise<Agent[]> {
    return this._spawnChildren(cloneMessages(this.agent.state.messages), message, n);
  }

  promptFork(message: string, n: number): Promise<Agent[]> {
    return this.fork(message, n);
  }

  async forkFrom(snapshot: AgentSnapshot, message: string, n: number): Promise<Agent[]> {
    return this._spawnChildren(cloneMessages(snapshot.messages), message, n);
  }
}
