import type { Agent as PiAgent, AgentTool, AgentToolResult, AgentMessage, ThinkingLevel, StreamFn } from '@mariozechner/pi-agent-core';
import type { ImageContent, Model, TextContent, Usage } from '@researchcomputer/ai-provider';
import type { Static, TSchema } from '@sinclair/typebox';

// Capabilities
export type Capability =
  | 'fs:read'
  | 'fs:write'
  | 'process:spawn'
  | 'network:egress'
  | 'git:mutate'
  | 'mcp:call'
  /** Mutation on the swarm (spawn/dismiss teammates, send messages). */
  | 'swarm:mutate'
  /**
   * Arbitrary shell execution with an LLM-supplied command string. Broader
   * than `process:spawn` (which can be granted to tools that exec a
   * validated argv). Claimed only by the Bash tool; rules targeting
   * 'shell:exec' let users gate the shell separately from other spawners.
   */
  | 'shell:exec';

// SdkTool
export interface SdkTool<TParameters extends TSchema = TSchema, TDetails = any> extends AgentTool<TParameters, TDetails> {
  capabilities: Capability[];
  permissionCheck?: (params: Static<TParameters>, rules: PermissionRule[]) => PermissionResult;
}

// Permissions
export type PermissionMode = 'default' | 'allowAll' | 'rulesOnly';
export type PermissionResult = { behavior: 'allow' } | { behavior: 'deny'; reason: string } | { behavior: 'ask'; prompt: string };
export interface PermissionRule { target: PermissionTarget; behavior: 'allow' | 'deny'; source: 'user' | 'project' | 'session'; }
export type PermissionTarget = { type: 'tool'; name: string; pattern?: string } | { type: 'capability'; capability: Capability } | { type: 'mcp'; server: string; tool?: string } | { type: 'all' };
export interface PermissionDecision { toolName: string; args: unknown; behavior: 'allow' | 'deny'; matchedRule?: PermissionRule; normalizedTarget: string; timestamp: number; }

// Hooks
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd' | 'Stop' | 'PreCompact' | 'PostCompact' | 'SubagentStart' | 'SubagentStop';
export interface HookContext {
  event: HookEvent;
  runContext: RunContext;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: AgentToolResult<any>;
  agentName?: string;
  messages?: AgentMessage[];
  /** True when this HookContext was built during a session-resume flow;
   *  false (or absent) for fresh sessions. Set on SessionStart hooks. */
  resumed?: boolean;
  /** tool_call_ids that were interrupted (no tool_result) before resume.
   *  Phase 3 injects synthetic close-out messages for each before the
   *  agent handles the next user prompt; this list lets SessionStart hooks
   *  observe what was recovered. */
  interruptedToolCallIds?: string[];
}
export interface HookResult { updatedArgs?: unknown; updatedResult?: AgentToolResult<any>; }
export interface HookHandler { event: HookEvent; matcher?: string; handler: (context: HookContext) => Promise<HookResult | void>; }

// Skills
export interface ResolvedSkill {
  id: string;
  description?: string;
  promptSections?: string[];
  tools?: SdkTool<any, any>[];
  mcpServers?: McpServerConfig[];
  hooks?: HookHandler[];
  permissionRules?: PermissionRule[];
  metadata?: Record<string, string>;
}

// Snapshot
export interface AgentSnapshot {
  /** UUID for logging and tracing. */
  id: string;
  messages: AgentMessage[];
  createdAt: number;
}

// RunContext
export interface RunContext { sessionId: string; traceId: string; cwd: string; signal: AbortSignal; costTracker: CostTracker; permissionDecisions: PermissionDecision[]; }

// Cost Tracking
export interface CostTracker { record(usage: Usage, modelId?: string): void; total(): { tokens: number; cost: number }; perModel(): Map<string, { tokens: number; cost: number }>; }

// Memory
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export interface Memory { name: string; description: string; type: MemoryType; content: string; }
export interface MemorySelection { memory: Memory; relevanceScore: number; source: string; updatedAt: number; }
export interface MemoryManager { load(): Promise<Memory[]>; save(memory: Memory): Promise<void>; remove(name: string): Promise<void>; retrieve(memories: Memory[], context: { query: string; maxItems?: number; maxTokens?: number }): MemorySelection[]; }

// Session
export interface LlmCallRecord {
  timestamp: number;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
}

export interface ToolEventRecord {
  timestamp: number;
  toolName: string;
  durationMs: number;
  success: boolean;
}

export interface SessionTelemetry {
  schemaVersion: 1;
  optOut: boolean;
  syncedAt?: number;
  llmCalls: LlmCallRecord[];
  toolEvents: ToolEventRecord[];
  totalCost: number;
  totalTokens: number; // Σ(inputTokens + outputTokens)
}

/**
 * Runtime state that cannot be reconstructed from the trajectory alone.
 * Cost amounts, selected memories, CWD mutations, swarm state, and
 * interrupted-tool-call IDs are saved in the v2 snapshot so a resumed
 * agent can re-enter the same state it had at dispose() time.
 */
export interface ContextState {
  /** CWD at snapshot time if the agent changed it. */
  cwd?: string;
  /** Which memories were selected for the session (may be empty). */
  selectedMemories: Array<{ name: string; score: number; updatedAt: number }>;
  /** CostTracker state. perModel is a sorted array for JSON-safety. */
  costState: {
    totalTokens: number;
    totalCost: number;
    perModel: Array<{ modelId: string; tokens: number; cost: number }>;
  };
  /** tool_call_ids dispatched but never answered before dispose. */
  interruptedToolCallIds: string[];
  /** Phase 4: opt-in swarm topology snapshot. */
  swarmState?: SerializedSwarmState;
  /** Opaque extension slot for skills / host adapters. */
  ext?: Record<string, unknown>;
}

export interface SessionSnapshot {
  version: 2;
  id: string;
  /** ULID pointer to the trajectory JSONL file. */
  trajectoryId: string;
  /** Last event_id observed at snapshot time. Replay stops here. */
  lastEventId: string | null;
  modelId: string;
  providerName: string;
  systemPromptHash: string;
  memoryRefs: string[];
  compactionState?: { lastCompactedIndex: number; summary?: string };
  telemetry?: SessionTelemetry;
  contextState?: ContextState;
  createdAt: number;
  updatedAt: number;
}

export interface SessionManager { save(snapshot: SessionSnapshot): Promise<void>; load(id: string): Promise<SessionSnapshot | null>; list(): Promise<{ id: string; updatedAt: number }[]>; }

// Context Compression
export type SegmentType = 'system' | 'memory' | 'user' | 'assistant' | 'toolIO' | 'summary';
export interface TranscriptSegment { type: SegmentType; protected: boolean; messages: AgentMessage[]; }
export interface CompressionConfig { maxTokens: number; strategy: 'truncate' | 'summarize'; model?: Model<any>; protectedRecentTurns?: number; }

// MCP
export interface McpServerConfig { name: string; transport: 'stdio' | 'sse' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; trustLevel?: 'trusted' | 'untrusted'; }
export interface McpConnection { name: string; config: McpServerConfig; close(): Promise<void>; }
export interface McpManager { connect(config: McpServerConfig): Promise<McpConnection>; disconnect(name: string): Promise<void>; getTools(): SdkTool<any, any>[]; getConnections(): McpConnection[]; }

// Swarm
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

// Tool Options
export interface ToolOptions { cwd?: string; allowedRoots?: string[]; }

// Schema Conversion
export interface SchemaConversionResult { schema: TSchema; isExact: boolean; warnings: string[]; }

// Custom Agent Messages
export interface MemoryInjectionMessage { role: 'memory'; content: string; sources: string[]; timestamp: number; }
export interface CompactionSummaryMessage { role: 'summary'; content: string; compactedCount: number; timestamp: number; }
export interface SwarmReportMessage { role: 'swarmReport'; content: string; fromAgent: string; taskId: string; timestamp: number; }

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    memory: MemoryInjectionMessage;
    summary: CompactionSummaryMessage;
    swarmReport: SwarmReportMessage;
  }
}

// Telemetry
export interface TelemetryConfig {
  /** Worker ingest URL. Falls back to ~/.rc-agents/telemetry.json, then env var. */
  endpoint?: string;
  /** Tenant API key. Same fallback chain. */
  apiKey?: string;
  /** Include messages[] in upload payload. Default: true. */
  captureTrajectory?: boolean;
}

// Non-fatal warnings collected during agent lifecycle (e.g. a memory store
// that failed to load). Callers retrieve them via Agent.getWarnings().
export interface SdkWarning {
  /** Stable machine-readable code, e.g. 'memory_load_failed'. */
  code: string;
  /** Human-readable message. */
  message: string;
  /** Timestamp (ms since epoch). */
  timestamp: number;
  /** Optional originating error. */
  cause?: unknown;
}

// Factory types
export interface AutoForkConfig {
  branches: number;
  /**
   * Called after each LLM turn completes with the N child agents.
   * Exceptions are caught and routed to onError if provided; otherwise ignored.
   */
  onBranches: (agents: Agent[]) => void | Promise<void>;
  /**
   * Called when fork creation or onBranches throws. Use this to observe
   * failures that would otherwise be silently swallowed.
   */
  onError?: (err: Error) => void;
}

export interface AgentConfig {
  model: Model<any>;
  systemPrompt?: string;
  tools?: SdkTool<any, any>[];
  permissionMode?: PermissionMode;
  permissionRules?: PermissionRule[];
  onPermissionAsk?: (toolName: string, args: unknown) => Promise<boolean>;
  mcpServers?: McpServerConfig[];
  maxContextTokens?: number;
  compressionStrategy?: 'truncate' | 'summarize';
  memoryDir?: string;
  enableMemory?: boolean;
  sessionDir?: string;
  sessionId?: string;
  hooks?: HookHandler[];
  skills?: ResolvedSkill[];
  enableSwarm?: boolean;
  thinkingLevel?: ThinkingLevel;
  toolExecution?: 'sequential' | 'parallel';
  getApiKey?: (provider: string) => Promise<string | undefined>;
  cwd?: string;
  onQuestion?: (question: string) => Promise<string>;
  autoFork?: AutoForkConfig;
  /** Custom stream function. Useful for proxy backends and testing. */
  streamFn?: StreamFn;
  /** Telemetry config. Set to false to opt out. */
  telemetry?: TelemetryConfig | false;
  /** Explicit JWT for server-side/programmatic use; overrides all other auth sources. */
  authToken?: string;
  /**
   * On resume, choose whether to reuse the memory selection persisted in
   * the snapshot ('pin' — reproducible) or re-run retrieve() against the
   * current memory store ('refresh' — picks up changes). Default: 'pin'.
   */
  memoryResumeStrategy?: 'pin' | 'refresh';
  /**
   * Optional redactor applied to tool `args` before they're written to
   * durable trajectory events (tool_call and permission_decision). The
   * in-memory PermissionDecision log is NOT redacted — only the disk
   * representation. Use with `createKeyRedactor` or a custom fn.
   */
  redactArgs?: (toolName: string, args: unknown) => unknown;
  /**
   * Optional redactor applied to AgentMessage arrays before they're written
   * to trajectory events (`llm_api_call.request_messages`, `agent_message`)
   * and before upload. Return a new array; a throwing redactor falls back to
   * the original messages with a warning. Default: passthrough. Pair with
   * `createContentRedactor` for opt-in secret-pattern scanning.
   */
  redactMessages?: (messages: AgentMessage[]) => AgentMessage[];
}

export interface Agent {
  agent: PiAgent;
  mcp: McpManager;
  sessions: SessionManager;
  memory: MemoryManager;
  swarm?: SwarmManager;
  costTracker: CostTracker;
  prompt(message: string, images?: ImageContent[], extraSystem?: string): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): AgentSnapshot;
  restore(snapshot: AgentSnapshot): void;
  fork(message: string, n: number): Promise<Agent[]>;
  forkFrom(snapshot: AgentSnapshot, message: string, n: number): Promise<Agent[]>;
  promptFork(message: string, n: number): Promise<Agent[]>;
  /**
   * Non-fatal warnings collected during the agent's lifetime. Includes things
   * like failed memory loads, session-resume failures, telemetry flush errors,
   * and MCP disconnect errors that were intentionally not thrown.
   */
  getWarnings(): readonly SdkWarning[];
}
