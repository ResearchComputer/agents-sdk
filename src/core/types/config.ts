import type { Agent as PiAgent, AgentMessage, StreamFn, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Model, ImageContent } from '@researchcomputer/ai-provider';
import type { SdkTool } from './tools.js';
import type { PermissionMode, PermissionRule } from './permissions.js';
import type { McpServerConfig, McpManager } from './mcp.js';
import type { HookHandler } from './events.js';
import type { ResolvedSkill } from './skills.js';
import type { SwarmManager } from './swarm.js';
import type { MemoryManager } from './memory.js';
import type { SessionManager, CostTracker, AgentSnapshot } from './state.js';

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

/**
 * Configuration options for initializing an Agent.
 * This is the primary interface for customizing the agent's behavior, tools, permissions, and extensions.
 */
export interface AgentConfig {
  /** The language model instance to use for the agent's core reasoning and generation. */
  model: Model<any>;
  /** The core system instructions defining the agent's persona and primary constraints. */
  systemPrompt?: string;
  /** Array of tools available to the agent during execution. */
  tools?: SdkTool<any, any>[];
  /** Defines the baseline permission behavior: 'default', 'allowAll', or 'rulesOnly'. */
  permissionMode?: PermissionMode;
  /** Explicit rules defining allow/deny policies for specific tools or capabilities. */
  permissionRules?: PermissionRule[];
  /** Callback fired when a tool execution requires explicit user consent. Return true to allow. */
  onPermissionAsk?: (toolName: string, args: unknown) => Promise<boolean>;
  /** Configuration for Model Context Protocol (MCP) servers to connect to at startup. */
  mcpServers?: McpServerConfig[];
  /** Maximum number of tokens to retain in context before triggering compaction/summarization. */
  maxContextTokens?: number;
  /** Strategy to use when context exceeds maxContextTokens: 'truncate' (drop oldest) or 'summarize'. */
  compressionStrategy?: 'truncate' | 'summarize';
  /** Directory path where the agent's memories are stored and retrieved. */
  memoryDir?: string;
  /** Whether to enable memory retrieval and storage functionality. */
  enableMemory?: boolean;
  /** Directory path where agent session snapshots and trajectories are stored. */
  sessionDir?: string;
  /** Identifier for the session, useful for resuming previous executions. */
  sessionId?: string;
  /** Array of hook handlers to tap into lifecycle events (e.g., PreToolUse, SessionEnd). */
  hooks?: HookHandler[];
  /** Array of bundled skills containing tools, MCP servers, hooks, and prompts. */
  skills?: ResolvedSkill[];
  /** Whether to enable multi-agent swarm capabilities. */
  enableSwarm?: boolean;
  /** Specifies the level of thinking/reasoning effort for supporting models (e.g., Claude 3.7 Sonnet). */
  thinkingLevel?: ThinkingLevel;
  /** Controls if tools are executed sequentially or in parallel. Defaults to model/provider specifics. */
  toolExecution?: 'sequential' | 'parallel';
  /** Async callback to dynamically provide API keys for different providers during execution. */
  getApiKey?: (provider: string) => Promise<string | undefined>;
  /** Working directory the agent considers its root context. Defaults to process.cwd(). */
  cwd?: string;
  /** Callback allowing the agent to prompt the human operator for information. */
  onQuestion?: (question: string) => Promise<string>;
  /** Configuration for automatic forking (Best-of-N/MCTS style explorations). */
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
