import type { AgentToolResult, AgentMessage } from '@mariozechner/pi-agent-core';
import type { RunContext } from './state.js';

/**
 * Lifecycle events that trigger hooks during the agent's operation.
 */
export type HookEvent =
  /** Triggered before a tool is executed. Allows modifying arguments or skipping execution. */
  | 'PreToolUse'
  /** Triggered after a tool is executed. Allows modifying the result before the agent sees it. */
  | 'PostToolUse'
  /** Triggered when an agent session begins, including resuming an existing session. */
  | 'SessionStart'
  /** Triggered when an agent session normally concludes. */
  | 'SessionEnd'
  /** Triggered when the agent's execution is forcefully stopped or aborted. */
  | 'Stop'
  /** Triggered before the agent's conversation history is compacted (summarized or truncated). */
  | 'PreCompact'
  /** Triggered after the agent's conversation history has been compacted. */
  | 'PostCompact'
  /** Triggered when a subagent is spawned by the primary agent in a swarm setup. */
  | 'SubagentStart'
  /** Triggered when a subagent finishes its task or is stopped. */
  | 'SubagentStop';

/**
 * Context provided to hook handlers at various stages of the agent lifecycle.
 * Modifying the context does not affect the agent state unless explicitly allowed via HookResult.
 */
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
