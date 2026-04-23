import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { PermissionDecision, PermissionRule } from '../types.js';
import type { TrajectoryEvent } from './writer.js';

/**
 * Output of replaying a trajectory. Deterministic function of the input
 * events — the same input always produces the same output, suitable for
 * rehydrating a freshly-built RunContext on resume.
 */
/** Per-call context for an interrupted tool call, used by the resume path
 *  to inject a properly-shaped synthetic tool_result. */
export interface InterruptedToolCall {
  toolCallId: string;
  toolName: string;
  /** event_id of the originating tool_call event; the synthetic
   *  tool_result emitted during resume sets parent_event_id to this. */
  parentEventId: string;
}

export interface ReplayResult {
  messages: AgentMessage[];
  permissionDecisions: PermissionDecision[];
  /** tool_call_ids that had no matching tool_result event. */
  interruptedToolCallIds: string[];
  /** Full context for interrupted calls (kept alongside the flat ID list
   *  so existing callers that only need the IDs continue to work). */
  interruptedToolCalls: InterruptedToolCall[];
  /** Count of llm_api_call events (useful for diagnostics, not for state
   *  reconstruction — cost amounts aren't in the trajectory payload). */
  llmApiCallCount: number;
}

/**
 * Walk a trajectory's events and reconstruct the portion of runtime state
 * that replay can recover: message history, permission-decision log, and
 * the set of tool calls that were interrupted (dispatched but never
 * observed a tool_result).
 *
 * Non-replayable state (cost totals, selected memories, CWD, swarm state)
 * lives in the v2 snapshot's contextState field, not in the trajectory.
 */
export function replayTrajectory(events: Iterable<TrajectoryEvent>): ReplayResult {
  const messages: AgentMessage[] = [];
  const permissionDecisions: PermissionDecision[] = [];
  const pendingToolCalls = new Map<string, TrajectoryEvent>();
  let llmApiCallCount = 0;

  for (const event of events) {
    switch (event.event_type) {
      case 'agent_message': {
        const msg = readAgentMessage(event);
        if (msg) messages.push(msg);
        break;
      }
      case 'permission_decision': {
        const decision = readPermissionDecision(event);
        if (decision) permissionDecisions.push(decision);
        break;
      }
      case 'tool_call': {
        const id = readString(event.payload, 'tool_call_id');
        const name = readString(event.payload, 'tool_name');
        if (id && name) pendingToolCalls.set(id, event);
        break;
      }
      case 'tool_result': {
        const id = readString(event.payload, 'tool_call_id');
        if (id) pendingToolCalls.delete(id);
        break;
      }
      case 'llm_api_call':
        llmApiCallCount++;
        break;
      // session_start, session_end, hook_fire, llm_turn, compaction, error:
      // no message-history side effects in Phase 2.
      default:
        break;
    }
  }

  const interruptedToolCalls: InterruptedToolCall[] = [];
  for (const [id, event] of pendingToolCalls) {
    const toolName = readString(event.payload, 'tool_name');
    if (!toolName) continue;
    interruptedToolCalls.push({
      toolCallId: id,
      toolName,
      parentEventId: event.event_id,
    });
  }

  return {
    messages,
    permissionDecisions,
    interruptedToolCallIds: interruptedToolCalls.map(c => c.toolCallId),
    interruptedToolCalls,
    llmApiCallCount,
  };
}

function readString(obj: unknown, key: string): string | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

const AGENT_MESSAGE_ROLES = new Set(['user', 'assistant', 'tool', 'memory', 'summary', 'swarmReport']);

function readAgentMessage(event: TrajectoryEvent): AgentMessage | null {
  const role = readString(event.payload, 'role');
  if (!role || !AGENT_MESSAGE_ROLES.has(role)) return null;
  const payload = event.payload as Record<string, unknown>;
  if (!('content' in payload)) return null;
  // The trajectory role 'tool' maps back to runtime role 'toolResult' —
  // convertToLlm bridges the naming gap.
  const runtimeRole = role === 'tool' ? 'toolResult' : role;
  const msg: Record<string, unknown> = {
    role: runtimeRole,
    content: payload.content,
    timestamp: payload.timestamp ?? Date.parse(event.timestamp),
  };
  // Rehydrate tool-message-specific fields from the event's `ext` slot.
  // Writers that emit toolResult messages (notably the synthetic
  // interrupted-tool injection at resume time) stash toolCallId/toolName/
  // isError here because the agent_message schema payload has no slots
  // for them.
  if (runtimeRole === 'toolResult' && event.ext) {
    const ext = event.ext;
    const tcid = ext['rc.tool_call_id'];
    const tname = ext['rc.tool_name'];
    const isErr = ext['rc.is_error'];
    if (typeof tcid === 'string') msg.toolCallId = tcid;
    if (typeof tname === 'string') msg.toolName = tname;
    if (typeof isErr === 'boolean') msg.isError = isErr;
  }
  return msg as unknown as AgentMessage;
}

function readPermissionDecision(event: TrajectoryEvent): PermissionDecision | null {
  const payload = event.payload as Record<string, unknown>;
  const toolName = readString(payload, 'tool_name');
  const behavior = readString(payload, 'behavior');
  const normalizedTarget = readString(payload, 'normalized_target');
  if (!toolName || !normalizedTarget) return null;
  if (behavior !== 'allow' && behavior !== 'deny') return null;
  const matched = payload.matched_rule;
  return {
    toolName,
    args: payload.args,
    behavior,
    matchedRule: (matched && typeof matched === 'object' ? matched : undefined) as PermissionRule | undefined,
    normalizedTarget,
    timestamp: Date.parse(event.timestamp),
  };
}
