// NOTE: @mariozechner/pi-agent-core is allowed in core under a
// documented exception. It is a transitive node dep today; the
// exception will be revisited when pi-agent-core is replaced.

import { Agent as PiAgent } from '@mariozechner/pi-agent-core';
import type { AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { ImageContent } from '@researchcomputer/ai-provider';
import type {
  AgentConfig,
  Agent,
  HookHandler,
  McpManager,
  AgentSnapshot,
  SwarmManager,
  SdkWarning,
} from './types.js';
import type { MemoryStore } from './memory/store.js';
import type { SessionStore } from './session/store.js';
import type { TelemetryCollector } from './telemetry/collector.js';
import type { TelemetrySink } from './telemetry/sink.js';
import type { LlmClient } from './llm/client.js';
import type { TrajectoryWriter, TrajectoryEvent } from './trajectory/writer.js';
import type { RedactArgsFn } from './trajectory/redactors.js';
import { replayTrajectory } from './trajectory/replay.js';
import { createInMemoryTrajectoryWriter } from './trajectory/writer.js';
import type { ContextState, SessionSnapshot } from './types.js';

// Trajectory role enum — mirrors the `role` enum in the agent_message branch
// of spec/schemas/trajectory-event.v1.schema.json. Runtime role 'toolResult'
// is mapped to trajectory role 'tool' at emit time.
const AGENT_MESSAGE_ROLES = new Set(['user', 'assistant', 'toolResult', 'memory', 'summary', 'swarmReport']);

/**
 * Rehydrate a cost tracker from a persisted cost state. CostTracker.record
 * takes a provider Usage; we replay per-model rows as synthetic usages so
 * both totals and perModel stay consistent.
 */
function applyCostState(
  costTracker: import('./types.js').CostTracker,
  state: { totalTokens: number; totalCost: number; perModel: Array<{ modelId: string; tokens: number; cost: number }> },
): void {
  for (const entry of state.perModel) {
    costTracker.record(
      {
        input: entry.tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: entry.cost, output: 0, cacheRead: 0, cacheWrite: 0, total: entry.cost },
      } as unknown as import('@researchcomputer/ai-provider').Usage,
      entry.modelId,
    );
  }
}

function buildCostState(
  costTracker: import('./types.js').CostTracker,
): { totalTokens: number; totalCost: number; perModel: Array<{ modelId: string; tokens: number; cost: number }> } {
  const total = costTracker.total();
  const perModelMap = costTracker.perModel();
  const perModel = Array.from(perModelMap.entries())
    .map(([modelId, v]) => ({ modelId, tokens: v.tokens, cost: v.cost }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
  return { totalTokens: total.tokens, totalCost: total.cost, perModel };
}
import { createRunContext } from './context/run-context.js';
import { convertToLlm } from './context/converter.js';
import { buildSystemPrompt } from './context/system-prompt.js';
import { createCompressionMiddleware } from './context/compression.js';
import { createPermissionMiddleware } from './middleware/permission-middleware.js';
import { composePipeline } from './middleware/pipeline.js';
import { runLifecycleHooks } from './middleware/hooks.js';
import { createCostTracker } from './observability/cost-tracker.js';
import { retrieve } from './memory/retrieve.js';
import { createSwarmManager } from './agents/swarm.js';
import { createSwarmTools } from './agents/tools.js';
import { composeAgentConfig } from './skills.js';
import { AuthRequiredError } from './errors.js';
import { extractUserText } from './auto-fork.js';

export interface AuthTokenResolver {
  resolve(): Promise<string>;
}

export interface CoreAdapters {
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  telemetryCollector: TelemetryCollector;
  telemetrySink: TelemetrySink;
  mcpManager: McpManager;
  authTokenResolver: AuthTokenResolver;
  initialWarnings?: SdkWarning[];
  /**
   * LLM transport. Core never imports ai-provider at runtime; all stream
   * and completeN calls go through this adapter. Hosts that cannot run
   * ai-provider (WASM, Python embedding) provide their own implementation.
   */
  llmClient: LlmClient;
  /** If true, telemetry hooks are skipped entirely (no sidecar written). */
  telemetryOptOut?: boolean;
  /**
   * Optional factory invoked once per session to produce a TrajectoryWriter.
   * When provided, the core factory emits session_start, session_end,
   * llm_api_call, tool_call, tool_result, agent_message, and
   * permission_decision events to the writer. Non-Node hosts may supply an
   * in-memory writer or a custom durable implementation.
   *
   * On resume, the factory passes the existing snapshot's trajectoryId so
   * the writer continues appending to the same trajectory.
   */
  createTrajectoryWriter?: (options?: { trajectoryId?: string }) => TrajectoryWriter;
  /**
   * Optional. Reads an existing trajectory into memory (for replay on
   * resume). Called only if a v2 snapshot is being resumed. When absent,
   * the factory falls back to calling writer.events() after construction.
   */
  readTrajectoryFromStorage?: (trajectoryId: string) => Promise<import('./trajectory/writer.js').TrajectoryEvent[]>;
  /**
   * Phase 5 — optional redactor applied to `args` before they're written
   * to a trajectory event (`tool_call` and `permission_decision`). Return
   * a scrubbed copy; missing/thrown from the callback falls back to the
   * raw args to avoid breaking the session. Default: passthrough.
   *
   * No built-in heuristics — the SDK deliberately does not ship a
   * secret-detection scanner. Callers declare fields to scrub via
   * createKeyRedactor or their own implementation.
   */
  redactArgs?: RedactArgsFn;
}

/**
 * AgentConfig stripped of fields consumed by the node factory wrapper:
 * - memoryDir / sessionDir (paths, set by node wrapper)
 * - telemetry (parsed into TelemetryCollector/TelemetrySink by node wrapper)
 * - authToken / getApiKey are retained so core can wire effectiveGetApiKey
 * - systemPromptHash is pre-computed by node (sync createHash)
 */
export interface AgentCoreConfig extends Omit<AgentConfig, 'memoryDir' | 'sessionDir' | 'telemetry'> {
  systemPromptHash: string;  // pre-computed by node (sync createHash); core does not hash
}

export async function createAgentCore(
  config: AgentCoreConfig,
  adapters: CoreAdapters,
): Promise<Agent> {
  const cwd = config.cwd;
  if (!cwd) {
    throw new Error('createAgentCore: config.cwd is required — the node factory resolves it via process.cwd() before calling this function');
  }
  const permissionMode = config.permissionMode ?? 'default';
  const enableMemory = config.enableMemory ?? true;
  // If resuming a session, preserve the original createdAt
  let sessionCreatedAt = Date.now();

  // Non-fatal warnings (failed memory load, auth resolve, etc.) surface
  // via agent.getWarnings() instead of being silently swallowed.
  const warnings: SdkWarning[] = [...(adapters.initialWarnings ?? [])];
  const addWarning = (code: string, message: string, cause?: unknown): void => {
    warnings.push({ code, message, timestamp: Date.now(), cause });
  };

  // 1. Create the shared cost tracker up front so the RunContext and the
  // agent-level Agent.costTracker are backed by the same instance.
  const costTracker = createCostTracker();

  // 2. Create RunContext
  const runContext = createRunContext({
    cwd,
    sessionId: config.sessionId,
    costTracker,
  });

  // 2b. Load the snapshot NOW (if resuming) so we know the trajectoryId
  // before building the trajectory writer + permission middleware. Without
  // this ordering, a v2 resume would start a fresh trajectory and
  // permission_decision events would not be emitted until after setup.
  let resumedTrajectoryId: string | undefined;
  let resumedContextState: ContextState | undefined;
  let preseededMessages: AgentMessage[] | undefined;
  let preseededPermissionDecisions: import('./types.js').PermissionDecision[] | undefined;
  let resumedInterruptedToolCallIds: string[] = [];
  let resumedInterruptedToolCalls: import('./trajectory/replay.js').InterruptedToolCall[] = [];
  let isResume = false;
  if (config.sessionId) {
    try {
      const raw = await adapters.sessionStore.load(config.sessionId);
      if (raw) {
        isResume = true;
        const snap = raw as SessionSnapshot;
        resumedTrajectoryId = snap.trajectoryId;
        sessionCreatedAt = snap.createdAt ?? sessionCreatedAt;
        let events: TrajectoryEvent[] = [];
        if (adapters.readTrajectoryFromStorage) {
          try {
            events = await adapters.readTrajectoryFromStorage(snap.trajectoryId);
          } catch (err) {
            addWarning(
              'trajectory_read_failed',
              `Failed to read trajectory ${snap.trajectoryId}: ${(err as Error).message}`,
              err,
            );
          }
        }
        const replayed = replayTrajectory(events);
        preseededMessages = replayed.messages;
        preseededPermissionDecisions = replayed.permissionDecisions;
        resumedInterruptedToolCallIds = replayed.interruptedToolCallIds;
        resumedInterruptedToolCalls = replayed.interruptedToolCalls;
        resumedContextState = snap.contextState;
        if (snap.contextState?.costState) {
          applyCostState(costTracker, snap.contextState.costState);
        }
      }
    } catch (err) {
      addWarning(
        'session_resume_failed',
        `Failed to resume session ${config.sessionId}: ${(err as Error).message}`,
        err,
      );
    }
  }

  // 2c. Seed runContext.permissionDecisions from replay so audit log
  // continues across resume.
  if (preseededPermissionDecisions) {
    runContext.permissionDecisions.push(...preseededPermissionDecisions);
  }

  // 2. Load memories via adapter
  let memories: Awaited<ReturnType<MemoryStore['load']>> = [];
  let memorySelections: ReturnType<typeof retrieve> = [];

  if (enableMemory) {
    try {
      memories = await adapters.memoryStore.load();
      const strategy = config.memoryResumeStrategy ?? 'pin';
      const pinned = strategy === 'pin' && resumedContextState?.selectedMemories && resumedContextState.selectedMemories.length > 0;
      if (pinned) {
        const byName = new Map(memories.map(m => [m.name, m]));
        memorySelections = resumedContextState!.selectedMemories
          .map((sel) => {
            const mem = byName.get(sel.name);
            return mem
              ? { memory: mem, relevanceScore: sel.score, source: 'memory' as const, updatedAt: sel.updatedAt }
              : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
      } else {
        memorySelections = retrieve(memories, { query: '' });
      }
    } catch (err) {
      addWarning('memory_load_failed', `Failed to load memories: ${(err as Error).message}`, err);
    }
  }

  // 3. Create tools
  const defaultTools = config.tools ?? [];
  const composedConfig = composeAgentConfig(config, { defaultTools });
  const tools = composedConfig.tools;
  const permissionRules = composedConfig.permissionRules;

  // Resolve auth token via adapter. Missing token is normal (user may supply
  // config.getApiKey instead); only record a warning when resolve() actively
  // errored so callers can distinguish "not configured" from "failed".
  let authToken: string | null = null;
  try {
    authToken = await adapters.authTokenResolver.resolve();
  } catch (err) {
    addWarning('auth_resolve_failed', `Failed to resolve auth token: ${(err as Error).message}`, err);
  }

  // If no custom getApiKey and no auth token, throw AuthRequiredError
  if (!config.getApiKey && authToken === null) {
    throw new AuthRequiredError();
  }

  // Build telemetry hooks for tool event recording (opt-out skips these)
  const { telemetryCollector, telemetrySink } = adapters;
  const optOut = adapters.telemetryOptOut ?? false;

  // Trajectory writer construction runs now — snapshot + trajectoryId are
  // known (step 2b). Resumed sessions reuse the existing trajectoryId so
  // new events append to the same file. Hosts that skip the adapter get
  // an in-memory writer so snapshots always carry a trajectoryId.
  const trajectoryWriter: TrajectoryWriter = adapters.createTrajectoryWriter
    ? adapters.createTrajectoryWriter(
        resumedTrajectoryId ? { trajectoryId: resumedTrajectoryId } : undefined,
      )
    : createInMemoryTrajectoryWriter(
        resumedTrajectoryId ? { trajectoryId: resumedTrajectoryId } : undefined,
      );

  // Phase 5: args-redaction hook. Defensive — a throwing redactor
  // shouldn't be able to kill a session, so we catch and fall back to the
  // raw args with a one-time warning.
  const redactArgs: RedactArgsFn = adapters.redactArgs
    ? (toolName, args) => {
        try {
          return adapters.redactArgs!(toolName, args);
        } catch (err) {
          addWarning(
            'redact_args_failed',
            `redactArgs threw for tool ${toolName}: ${(err as Error).message}`,
            err,
          );
          return args;
        }
      }
    : (_toolName, args) => args;

  const telemetryToolStartTimes = new Map<string, number>();
  const trajectoryToolStartTimes = new Map<string, number>();
  // tool_call_id -> trajectory event_id, so tool_result can chain to it.
  const toolCallEventIds = new Map<string, string>();
  // Note: we used to flush an empty telemetry blob on SessionStart for crash
  // recovery, but that overwrote the final flush in edge cases and dropped
  // events. dispose() now performs the single authoritative flush.
  const telemetryHooks: HookHandler[] = optOut ? [] : [
    {
      event: 'PreToolUse',
      handler: async (ctx) => {
        const toolName = ctx.toolName ?? 'unknown';
        const key = ctx.toolCallId ?? `__noid__:${toolName}`;
        telemetryToolStartTimes.set(key, Date.now());
      },
    },
    {
      event: 'PostToolUse',
      handler: async (ctx) => {
        const now = Date.now();
        const toolName = ctx.toolName ?? 'unknown';
        const key = ctx.toolCallId ?? `__noid__:${toolName}`;
        const startTime = telemetryToolStartTimes.get(key) ?? now;
        telemetryToolStartTimes.delete(key);
        telemetryCollector.onToolEvent({
          timestamp: now,
          toolName,
          durationMs: now - startTime,
          success: (ctx.toolResult as import('@mariozechner/pi-agent-core').AgentToolResult<{ isError?: boolean }>)?.details?.isError !== true,
        });
      },
    },
  ];

  // Trajectory hooks — emit tool_call + tool_result events. Runs regardless
  // of telemetryOptOut (trajectory is a separate opt-in via the adapter).
  const trajectoryHooks: HookHandler[] = trajectoryWriter ? [
    {
      event: 'PreToolUse',
      handler: async (ctx) => {
        const toolName = ctx.toolName ?? 'unknown';
        const toolCallId = ctx.toolCallId ?? `__noid__:${toolName}`;
        trajectoryToolStartTimes.set(toolCallId, Date.now());
        const tool = allTools.find(t => t.name === toolName);
        const capabilities = tool?.capabilities ?? [];
        const eventId = trajectoryWriter.append({
          event_type: 'tool_call',
          payload: {
            tool_name: toolName,
            tool_call_id: toolCallId,
            args: redactArgs(toolName, ctx.toolArgs ?? {}),
            capabilities,
          },
        });
        toolCallEventIds.set(toolCallId, eventId);
      },
    },
    {
      event: 'PostToolUse',
      handler: async (ctx) => {
        const toolName = ctx.toolName ?? 'unknown';
        const toolCallId = ctx.toolCallId ?? `__noid__:${toolName}`;
        const parent = toolCallEventIds.get(toolCallId) ?? null;
        toolCallEventIds.delete(toolCallId);
        const result = ctx.toolResult as
          import('@mariozechner/pi-agent-core').AgentToolResult<{ isError?: boolean }> | undefined;
        const success = result?.details?.isError !== true;
        const startTime = trajectoryToolStartTimes.get(toolCallId);
        trajectoryToolStartTimes.delete(toolCallId);
        const durationMs = startTime ? Date.now() - startTime : 0;
        trajectoryWriter.append({
          event_type: 'tool_result',
          parent_event_id: parent,
          payload: {
            tool_call_id: toolCallId,
            duration_ms: durationMs,
            success,
            output: result?.content ?? null,
          },
        });
      },
    },
  ] : [];

  // Prepend telemetry + trajectory hooks so they run before user hooks
  const hooks = [...telemetryHooks, ...trajectoryHooks, ...composedConfig.hooks];

  // 4. Connect MCP servers via adapter (node wrapper already connected)
  const mcp = adapters.mcpManager;

  // Merge MCP tools with built-in tools
  const allTools = [...tools, ...mcp.getTools()];

  // 5. Build system prompt
  const basePrompt = composedConfig.systemPrompt ?? 'You are a coding agent that helps users with software development tasks.';
  const systemPrompt = buildSystemPrompt({
    basePrompt,
    skills: composedConfig.skills,
    tools: allTools,
    memories: memorySelections,
    permissionMode,
  });

  // 6. Create permission middleware
  const permissionGate = createPermissionMiddleware({
    mode: permissionMode,
    rules: permissionRules,
    tools: allTools,
    runContext,
    onAsk: config.onPermissionAsk,
    trajectoryWriter: trajectoryWriter ?? undefined,
    redactArgs,
  });

  // 7. Compose pipeline
  const pipeline = composePipeline({
    hooks,
    permissionGate,
    runContext,
  });

  // 8. Create compression middleware
  const maxContextTokens = config.maxContextTokens ??
    Math.max(4000, Math.floor((config.model.contextWindow || 128000) * 0.8));

  const transformContext = createCompressionMiddleware({
    maxTokens: maxContextTokens,
    strategy: config.compressionStrategy ?? 'truncate',
    model: config.model,
  });

  // 9. Cost tracker already created at step 1 and shared with RunContext.

  // 10. Create Agent
  // Prefer user-supplied getApiKey; otherwise fall back to the resolved auth token
  const effectiveGetApiKey = config.getApiKey ?? (
    authToken !== null ? async (_provider: string): Promise<string | undefined> => authToken : undefined
  );

  const agent = new PiAgent({
    initialState: {
      systemPrompt,
      model: config.model,
      tools: allTools,
      thinkingLevel: config.thinkingLevel ?? ('off' as ThinkingLevel),
    },
    convertToLlm,
    transformContext,
    beforeToolCall: pipeline.beforeToolCall,
    afterToolCall: pipeline.afterToolCall,
    getApiKey: effectiveGetApiKey,
    toolExecution: config.toolExecution ?? 'parallel',
    streamFn: config.streamFn ?? adapters.llmClient.stream,
  });

  // Wire cost tracker to agent events
  agent.subscribe((event) => {
    if (event.type === 'message_end') {
      const msg = event.message as { role: string; usage?: import('@researchcomputer/ai-provider').Usage };
      if (msg.role === 'assistant' && msg.usage) {
        costTracker.record(msg.usage, config.model.id);
      }
    }
  });

  // Wire telemetry LLM call tracking.
  // FIFO of start timestamps (one per in-flight assistant message_start).
  // A queue, not a scalar, so an unmatched start (error path) can't poison
  // the latency of a later call.
  const llmCallStartTimes: number[] = [];
  agent.subscribe((event) => {
    if (event.type === 'message_start') {
      const msg = event.message as { role: string };
      if (msg.role === 'assistant') {
        llmCallStartTimes.push(Date.now());
      }
    }
    if (event.type === 'message_end') {
      const msg = event.message as {
        role: string;
        content?: unknown;
        usage?: import('@researchcomputer/ai-provider').Usage;
        timestamp?: number;
      };
      if (msg.role === 'assistant' && msg.usage) {
        const now = Date.now();
        const startTime = llmCallStartTimes.shift() ?? now;
        telemetryCollector.onLlmCall({
          timestamp: startTime,
          modelId: config.model.id,
          inputTokens: msg.usage.input,
          outputTokens: msg.usage.output,
          cost: msg.usage.cost.total,
          latencyMs: now - startTime,
        });
        if (trajectoryWriter) {
          trajectoryWriter.append({
            event_type: 'llm_api_call',
            payload: {
              turn_id: trajectoryWriter.trajectoryId,
              model_id: config.model.id,
              provider: config.model.provider,
              request_messages: agent.state.messages as unknown[],
              response_message: msg as unknown as Record<string, unknown>,
              usage: {
                input_tokens: msg.usage.input,
                output_tokens: msg.usage.output,
              },
              latency_ms: now - startTime,
            },
          });
        }
      }
      // Emit agent_message for every message completed during the session.
      // Replay uses this list to reconstruct agent.state.messages on resume.
      // Role 'toolResult' maps to trajectory role 'tool' per the canonical
      // schema (spec/schemas/trajectory-event.v1.schema.json).
      if (trajectoryWriter && AGENT_MESSAGE_ROLES.has(msg.role)) {
        const trajRole = msg.role === 'toolResult' ? 'tool' : msg.role;
        const content = (msg as unknown as { content?: unknown }).content;
        trajectoryWriter.append({
          event_type: 'agent_message',
          payload: {
            role: trajRole,
            content: content ?? null,
            ...(typeof msg.timestamp === 'number' ? { timestamp: msg.timestamp } : {}),
          },
        });
      }
    }
  });

  // 11. Create session manager via adapter
  const sessions = adapters.sessionStore;

  // 12. Optionally create swarm
  let swarm: SwarmManager | undefined;
  if (config.enableSwarm) {
    swarm = createSwarmManager({
      model: config.model,
      tools: allTools,
      convertToLlm,
      getApiKey: effectiveGetApiKey,
      beforeToolCall: pipeline.beforeToolCall,
      afterToolCall: pipeline.afterToolCall,
      transformContext,
      streamFn: config.streamFn ?? adapters.llmClient.stream,
    });

    // Create default team and swarm tools
    swarm.createTeam({ name: 'default', model: config.model });
    const swarmTools = createSwarmTools('default', swarm);
    const currentTools = [...allTools, ...swarmTools];
    agent.state.tools = currentTools;

    // Phase 4 resume — rehydrate any saved swarm topology as idle stubs.
    // Teams beyond 'default' are recreated; teammates are inserted as
    // stubs (no Agent instances) so the public Team.teammates map looks
    // like it did at dispose time. A warning names any teammate that was
    // in 'running' status at save time so callers can decide whether to
    // re-dispatch.
    if (resumedContextState?.swarmState) {
      const saved = resumedContextState.swarmState;
      for (const savedTeam of saved.teams) {
        if (!swarm.getTeam(savedTeam.name)) {
          swarm.createTeam({ name: savedTeam.name, model: config.model });
        }
        const interruptedNames: string[] = [];
        for (const t of savedTeam.teammates) {
          if (t.status === 'running') interruptedNames.push(t.name);
          swarm.hydrateTeammateStub(savedTeam.name, t);
        }
        if (interruptedNames.length > 0) {
          addWarning(
            'swarm_teammates_interrupted',
            `Team ${savedTeam.name}: teammates running at dispose are now idle stubs: ${interruptedNames.join(', ')}. AsyncQueue contents were not preserved.`,
          );
        }
      }
    }
  }

  // 13. Synthetic close-out for interrupted tool calls (Phase 3). For each
  // tool_call event with no matching tool_result (e.g. the process crashed
  // mid-tool-execution), inject:
  //   (a) a synthetic tool_result event into the trajectory so a second
  //       resume sees the call as closed and doesn't re-report it, and
  //   (b) a synthetic toolResult message into the replayed message history
  //       so the LLM can see the interruption in its transcript.
  // Injecting into the trajectory AND into the in-memory messages keeps
  // the two views consistent across the next dispose cycle.
  const INTERRUPTED_CONTENT = (toolName: string): string =>
    `[interrupted] The ${toolName} tool call was in flight when the session was suspended. ` +
    `The resumed agent has no partial output from it.`;

  // Copied before the list is cleared so SessionStart hooks can still see
  // which calls were interrupted this resume.
  const interruptedToolCallIdsForHook: string[] = resumedInterruptedToolCalls.map(c => c.toolCallId);

  if (resumedInterruptedToolCalls.length > 0 && preseededMessages) {
    const syntheticMessages: AgentMessage[] = [];
    for (const call of resumedInterruptedToolCalls) {
      const content = [{ type: 'text' as const, text: INTERRUPTED_CONTENT(call.toolName) }];
      const synthetic = {
        role: 'toolResult',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        content,
        details: { interrupted: true, isError: true },
        isError: true,
        timestamp: Date.now(),
      };
      if (trajectoryWriter) {
        // tool_result event closes the trajectory-level pending call.
        trajectoryWriter.append({
          event_type: 'tool_result',
          parent_event_id: call.parentEventId,
          payload: {
            tool_call_id: call.toolCallId,
            duration_ms: 0,
            success: false,
            output: content,
          },
        });
        // agent_message event keeps replay-reconstructed messages[] in
        // sync with in-memory state: on the next resume the synthetic
        // close-out reappears in the LLM-visible transcript. Tool-specific
        // fields (toolCallId/toolName/isError) ride along via the event's
        // ext slot since the v1 agent_message payload schema doesn't have
        // dedicated properties for them.
        trajectoryWriter.append({
          event_type: 'agent_message',
          payload: {
            role: 'tool',
            content,
            timestamp: synthetic.timestamp,
          },
          ext: {
            'rc.tool_call_id': call.toolCallId,
            'rc.tool_name': call.toolName,
            'rc.is_error': true,
            'rc.synthetic_interrupted': true,
          },
        });
      }
      syntheticMessages.push(synthetic as unknown as AgentMessage);
    }
    preseededMessages = [...preseededMessages, ...syntheticMessages];
    // Interrupted calls are now closed — the next dispose snapshot should
    // report an empty interrupted list.
    resumedInterruptedToolCallIds = [];
    resumedInterruptedToolCalls = [];
  }

  // 14. Apply preseeded messages to agent state if we resumed (v1 or v2).
  if (preseededMessages) {
    agent.state.messages = preseededMessages;
  }

  // 14. Emit trajectory session_start (before user hooks so hook_fire events
  // in a later phase can chain back to this root).
  if (trajectoryWriter) {
    trajectoryWriter.append({
      event_type: 'session_start',
      payload: {
        session_id: trajectoryWriter.trajectoryId,
        model_id: config.model.id,
        provider_name: config.model.provider,
        system_prompt_hash: config.systemPromptHash,
        memory_refs: memories.map(m => m.name),
      },
    });
  }

  // 15. Run SessionStart hooks. Resume-aware hooks can observe whether the
  // factory just rehydrated a prior session and which tool calls were
  // closed-out synthetically.
  await runLifecycleHooks(hooks, 'SessionStart', runContext, {
    resumed: isResume,
    interruptedToolCallIds: isResume ? interruptedToolCallIdsForHook : undefined,
  });

  // Use pre-computed systemPromptHash from node wrapper
  const systemPromptHash = config.systemPromptHash;

  // Shutdown coordination: dispose() sets this and waits for any inflight
  // auto-fork before tearing down adapters. Prevents child agents from being
  // spawned against closed MCP/telemetry resources.
  let isDisposing = false;
  let inFlightAutoFork: Promise<void> | null = null;

  async function _spawnChildren(
    baseMessages: AgentMessage[],
    message: string,
    n: number
  ): Promise<Agent[]> {
    if (n < 0) throw new RangeError(`fork: n must be >= 0, got ${n}`);
    if (n === 0) return [];
    if (isDisposing) {
      throw new Error('fork: agent is disposing, cannot spawn children');
    }

    const childConfig: AgentCoreConfig = {
      ...config,
      sessionId: undefined,
      autoFork: undefined,
    };

    // Optimization: use completeN for the first turn when possible.
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

      // Resolve dynamic API key if configured
      const apiKey = config.getApiKey
        ? await config.getApiKey(config.model.provider)
        : undefined;
      const firstResponses = await adapters.llmClient.completeN(
        config.model,
        ctx,
        n,
        apiKey ? { apiKey } : undefined,
      );

      const children = await Promise.all(
        Array.from({ length: n }, () => createAgentCore(childConfig, adapters))
      );

      await Promise.all(
        children.map((child, i) => {
          const hasToolCalls = firstResponses[i].content.some(
            (b) => b.type === 'toolCall'
          );

          if (hasToolCalls) {
            child.agent.replaceMessages(structuredClone(baseMessages) as AgentMessage[]);
            return child.prompt(message);
          }

          const msgs = structuredClone(baseMessages) as AgentMessage[];
          msgs.push(structuredClone(userMsg));
          msgs.push(firstResponses[i] as AgentMessage);
          child.agent.replaceMessages(msgs);
          return Promise.resolve();
        })
      );

      return children;
    }

    // Fallback: original behavior
    const children = await Promise.all(
      Array.from({ length: n }, () => createAgentCore(childConfig, adapters))
    );

    await Promise.all(
      children.map((child) => {
        child.agent.replaceMessages(structuredClone(baseMessages) as AgentMessage[]);
        return child.prompt(message);
      })
    );

    return children;
  }

  const sdkAgent: Agent = {
    agent,
    mcp,
    sessions: {
      save: (snapshot) => sessions.save(snapshot),
      load: (id) => sessions.load(id),
      list: () => sessions.list(),
    },
    memory: {
      load: () => adapters.memoryStore.load(),
      save: (memory) => adapters.memoryStore.save(memory),
      remove: (name) => adapters.memoryStore.remove(name),
      retrieve: (mems, context) => retrieve(mems, context),
    },
    swarm,
    costTracker,

    async prompt(message: string, images?: ImageContent[], extraSystem?: string): Promise<void> {
      if (extraSystem) {
        const original = agent.state.systemPrompt;
        agent.setSystemPrompt(`${original}\n\n${extraSystem}`);
        try {
          await agent.prompt(message, images);
        } finally {
          agent.setSystemPrompt(original);
        }
        return;
      }
      await agent.prompt(message, images);
    },

    async dispose(): Promise<void> {
      // Guard against double-dispose and coordinate with in-flight auto-fork.
      if (isDisposing) return;
      isDisposing = true;
      if (inFlightAutoFork) {
        try {
          await inFlightAutoFork;
        } catch {
          // auto-fork errors are already routed to autoFork.onError
        }
      }

      // 1. Run SessionEnd hooks first
      await runLifecycleHooks(hooks, 'SessionEnd', runContext);

      // 2. Finalize telemetry
      const telemetry = telemetryCollector.finalize();

      // 3. Save enriched session snapshot. v2 carries contextState so a
      // subsequent resume can rebuild cost/memory/tool-interruption state.
      // Trajectory identity comes from the writer when present; for hosts
      // that skipped the writer adapter we synthesize a ULID alias.
      const trajId = trajectoryWriter.trajectoryId;
      const lastEventId = trajectoryWriter.currentEventId() ?? null;

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
        trajectoryId: trajId,
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
        await sessions.save(snapshot);
      } catch (err) {
        addWarning('session_save_failed', `Failed to save session: ${(err as Error).message}`, err);
      }

      try {
        await telemetrySink.flush(snapshot);
      } catch (err) {
        addWarning('telemetry_flush_failed', `Failed to flush telemetry: ${(err as Error).message}`, err);
      }

      // 5. Disconnect MCP servers
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

      // 6. Destroy swarm if present
      if (swarm) {
        try {
          await swarm.destroyTeam('default');
        } catch (err) {
          addWarning('swarm_cleanup_failed', `Failed to destroy swarm: ${(err as Error).message}`, err);
        }
      }

      // 7. Emit session_end + flush + close trajectory writer. Non-critical:
      // any failure is recorded as a warning instead of propagated, matching
      // the behavior of the other teardown steps.
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
            err,
          );
        }
      }
    },

    getWarnings(): readonly SdkWarning[] {
      return warnings;
    },

    snapshot(): AgentSnapshot {
      if (agent.state.isStreaming) {
        throw new Error('snapshot: cannot snapshot while agent is streaming');
      }
      return {
        id: globalThis.crypto.randomUUID(),
        messages: structuredClone(agent.state.messages),
        createdAt: Date.now(),
      };
    },

    restore(snapshot: AgentSnapshot): void {
      if (agent.state.isStreaming) {
        throw new Error('restore: cannot restore while agent is streaming');
      }
      agent.replaceMessages(structuredClone(snapshot.messages));
    },

    async fork(message: string, n: number): Promise<Agent[]> {
      return _spawnChildren(structuredClone(agent.state.messages), message, n);
    },

    // Documented alias for fork(). Kept so both names work in user code.
    promptFork(message: string, n: number): Promise<Agent[]> {
      return this.fork(message, n);
    },

    async forkFrom(snapshot: AgentSnapshot, message: string, n: number): Promise<Agent[]> {
      return _spawnChildren(structuredClone(snapshot.messages), message, n);
    },
  };

  // Wire auto-fork if configured
  if (config.autoFork) {
    const autoFork = config.autoFork;
    let lastUserMessage: string | undefined;

    agent.subscribe((event) => {
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
        !inFlightAutoFork &&
        !isDisposing
      ) {
        const message = lastUserMessage;
        lastUserMessage = undefined;
        inFlightAutoFork = sdkAgent
          .fork(message, autoFork.branches)
          .then(children => autoFork.onBranches(children))
          .catch((err) => {
            autoFork.onError?.(err instanceof Error ? err : new Error(String(err)));
          })
          .finally(() => { inFlightAutoFork = null; });
      }
    });
  }

  return sdkAgent;
}
