import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Usage, Model } from '@researchcomputer/ai-provider';
import type { PermissionDecision } from './permissions.js';
import type { SerializedSwarmState } from './swarm.js';
import { Type, type Static } from '@sinclair/typebox';

// RunContext
export interface RunContext { sessionId: string; traceId: string; cwd: string; signal: AbortSignal; costTracker: CostTracker; permissionDecisions: PermissionDecision[]; }

// Cost Tracking
export interface CostTracker { record(usage: Usage, modelId?: string): void; total(): { tokens: number; cost: number }; perModel(): Map<string, { tokens: number; cost: number }>; }

// Snapshot
export interface AgentSnapshot {
  /** UUID for logging and tracing. */
  id: string;
  messages: AgentMessage[];
  createdAt: number;
}

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

export const SessionSnapshotSchema = Type.Object({
  version: Type.Literal(2),
  id: Type.String(),
  trajectoryId: Type.String(),
  lastEventId: Type.Union([Type.String(), Type.Null()]),
  modelId: Type.String(),
  providerName: Type.String(),
  systemPromptHash: Type.String(),
  memoryRefs: Type.Array(Type.String()),
  compactionState: Type.Optional(Type.Object({
    lastCompactedIndex: Type.Number(),
    summary: Type.Optional(Type.String())
  })),
  telemetry: Type.Optional(Type.Object({
    schemaVersion: Type.Literal(1),
    optOut: Type.Boolean(),
    syncedAt: Type.Optional(Type.Number()),
    llmCalls: Type.Array(Type.Object({
      timestamp: Type.Number(),
      modelId: Type.String(),
      inputTokens: Type.Number(),
      outputTokens: Type.Number(),
      cost: Type.Number(),
      latencyMs: Type.Number()
    })),
    toolEvents: Type.Array(Type.Object({
      timestamp: Type.Number(),
      toolName: Type.String(),
      durationMs: Type.Number(),
      success: Type.Boolean()
    })),
    totalCost: Type.Number(),
    totalTokens: Type.Number()
  })),
  contextState: Type.Optional(Type.Object({
    cwd: Type.Optional(Type.String()),
    selectedMemories: Type.Array(Type.Object({
      name: Type.String(),
      score: Type.Number(),
      updatedAt: Type.Number()
    })),
    costState: Type.Object({
      totalTokens: Type.Number(),
      totalCost: Type.Number(),
      perModel: Type.Array(Type.Object({
        modelId: Type.String(),
        tokens: Type.Number(),
        cost: Type.Number()
      }))
    }),
    interruptedToolCallIds: Type.Array(Type.String()),
    swarmState: Type.Optional(Type.Any()),
    ext: Type.Optional(Type.Record(Type.String(), Type.Any()))
  })),
  createdAt: Type.Number(),
  updatedAt: Type.Number()
});

export interface SessionManager { save(snapshot: SessionSnapshot): Promise<void>; load(id: string): Promise<SessionSnapshot | null>; list(): Promise<{ id: string; updatedAt: number }[]>; }

// Context Compression
export type SegmentType = 'system' | 'memory' | 'user' | 'assistant' | 'toolIO' | 'summary';
export interface TranscriptSegment { type: SegmentType; protected: boolean; messages: AgentMessage[]; }
export interface CompressionConfig {
  maxTokens: number;
  strategy: 'truncate' | 'summarize';
  model?: Model<any>;
  protectedRecentTurns?: number;
  /** Resolves an API key for the model's provider. Required for the
   *  'summarize' strategy; without it summarize falls back to truncate. */
  getApiKey?: (provider: string) => Promise<string | undefined>;
  /** Soft cap for the model's summarization output, in tokens. Default 2048. */
  summaryMaxTokens?: number;
}
