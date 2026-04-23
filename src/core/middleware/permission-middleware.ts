import type { BeforeToolCallContext, BeforeToolCallResult } from '@mariozechner/pi-agent-core';
import type { SdkTool, PermissionMode, PermissionRule, RunContext, PermissionDecision, Capability } from '../types.js';
import type { TrajectoryWriter } from '../trajectory/writer.js';
import type { RedactArgsFn } from '../trajectory/redactors.js';
import { evaluatePermission, findMatchingRule } from './permissions.js';

export interface PermissionMiddlewareConfig {
  mode: PermissionMode;
  rules: PermissionRule[];
  tools: SdkTool<any, any>[];
  runContext: RunContext;
  onAsk?: (toolName: string, args: unknown) => Promise<boolean>;
  /** Optional: emit permission_decision events to the trajectory. */
  trajectoryWriter?: TrajectoryWriter;
  /** Optional: redact args before writing the permission_decision payload. */
  redactArgs?: RedactArgsFn;
}

export function createPermissionMiddleware(
  config: PermissionMiddlewareConfig,
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  const { mode, rules, tools, runContext, onAsk, trajectoryWriter, redactArgs } = config;

  const record = (
    toolName: string,
    args: unknown,
    behavior: 'allow' | 'deny',
    matchedRule: PermissionRule | undefined,
  ): void => {
    // In-memory permission log keeps raw args — callers of
    // runContext.permissionDecisions may need them for tool-specific
    // bookkeeping. Redaction is applied only at the trajectory-write
    // boundary (§6.6).
    logDecision(runContext, toolName, args, behavior, matchedRule, toolName);
    if (trajectoryWriter) {
      const payload: Record<string, unknown> = {
        tool_name: toolName,
        args: redactArgs ? redactArgs(toolName, args ?? {}) : (args ?? {}),
        behavior,
        normalized_target: toolName,
      };
      if (matchedRule) payload.matched_rule = matchedRule as unknown as Record<string, unknown>;
      trajectoryWriter.append({ event_type: 'permission_decision', payload });
    }
  };

  return async (context: BeforeToolCallContext, _signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
    const toolName = context.toolCall.name;
    const args = context.args;

    // Look up tool to get capabilities
    const tool = tools.find(t => t.name === toolName);
    const capabilities: Capability[] = tool?.capabilities ?? [];
    const matchedRule = findMatchingRule(rules, toolName, args, capabilities) ?? undefined;

    // Check tool-specific permissionCheck first
    if (tool?.permissionCheck) {
      const checkResult = tool.permissionCheck(args, rules);
      if (checkResult.behavior === 'deny') {
        record(toolName, args, 'deny', undefined);
        return { block: true, reason: checkResult.reason };
      }
      if (checkResult.behavior === 'allow') {
        record(toolName, args, 'allow', undefined);
        return undefined;
      }
      // 'ask' falls through to evaluatePermission
    }

    // Fall back to evaluatePermission
    const result = evaluatePermission(mode, rules, toolName, args, capabilities);

    if (result.behavior === 'allow') {
      record(toolName, args, 'allow', matchedRule);
      return undefined;
    }

    if (result.behavior === 'deny') {
      record(toolName, args, 'deny', matchedRule);
      return { block: true, reason: result.reason };
    }

    // 'ask' behavior
    if (onAsk) {
      const allowed = await onAsk(toolName, args);
      if (allowed) {
        record(toolName, args, 'allow', undefined);
        return undefined;
      }
    }

    record(toolName, args, 'deny', undefined);
    return { block: true, reason: 'Permission denied by user' };
  };
}

function logDecision(
  runContext: RunContext,
  toolName: string,
  args: unknown,
  behavior: 'allow' | 'deny',
  matchedRule: PermissionRule | undefined,
  normalizedTarget: string,
): void {
  const decision: PermissionDecision = {
    toolName,
    args,
    behavior,
    matchedRule,
    normalizedTarget,
    timestamp: Date.now(),
  };
  runContext.permissionDecisions.push(decision);
}
