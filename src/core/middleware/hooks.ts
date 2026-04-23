import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { HookHandler, HookEvent, HookContext, RunContext } from '../types.js';

/**
 * Check if a hook matches the given event and tool name.
 */
function hookMatches(hook: HookHandler, event: HookEvent, toolName?: string): boolean {
  if (hook.event !== event) return false;
  if (hook.matcher && toolName && hook.matcher !== toolName) return false;
  return true;
}

function describeHook(hook: HookHandler): string {
  return hook.matcher ? `${hook.event}(${hook.matcher})` : hook.event;
}

// Lifecycle hooks are best-effort: an error in a SessionStart/End handler
// must not prevent the agent from starting up or tearing down. We log and
// continue. PreToolUse/PostToolUse hooks DO need to throw (they can veto or
// rewrite tool calls) so they remain strict.
async function runLifecycleHandlerDefensively(
  hook: HookHandler,
  context: HookContext,
): Promise<void> {
  try {
    await hook.handler(context);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[agents-sdk] lifecycle hook ${describeHook(hook)} threw; continuing:`,
      (err as Error)?.message ?? err,
    );
  }
}

/**
 * Run all matching PreToolUse hooks, chaining updated args through each hook.
 * Returns the final (possibly modified) args.
 */
export async function runPreToolUseHooks(
  hooks: HookHandler[],
  toolName: string,
  args: unknown,
  runContext: RunContext,
  toolCallId?: string,
): Promise<unknown> {
  let currentArgs = args;

  for (const hook of hooks) {
    if (!hookMatches(hook, 'PreToolUse', toolName)) continue;

    const context: HookContext = {
      event: 'PreToolUse',
      runContext,
      toolCallId,
      toolName,
      toolArgs: currentArgs,
    };

    const result = await hook.handler(context);
    if (result?.updatedArgs !== undefined) {
      currentArgs = result.updatedArgs;
    }
  }

  return currentArgs;
}

/**
 * Run all matching PostToolUse hooks, chaining updated results through each hook.
 * Returns the final (possibly modified) tool result.
 */
export async function runPostToolUseHooks(
  hooks: HookHandler[],
  toolName: string,
  toolResult: AgentToolResult<any>,
  runContext: RunContext,
  toolCallId?: string,
): Promise<AgentToolResult<any>> {
  let currentResult = toolResult;

  for (const hook of hooks) {
    if (!hookMatches(hook, 'PostToolUse', toolName)) continue;

    const context: HookContext = {
      event: 'PostToolUse',
      runContext,
      toolCallId,
      toolName,
      toolResult: currentResult,
    };

    const result = await hook.handler(context);
    if (result?.updatedResult !== undefined) {
      currentResult = result.updatedResult;
    }
  }

  return currentResult;
}

/**
 * Run all matching lifecycle hooks (SessionStart, SessionEnd, Stop, etc.).
 * Lifecycle hooks ignore the matcher field.
 */
export async function runLifecycleHooks(
  hooks: HookHandler[],
  event: HookEvent,
  runContext: RunContext,
  extra?: Partial<Pick<HookContext, 'agentName' | 'messages' | 'resumed' | 'interruptedToolCallIds'>>,
): Promise<void> {
  for (const hook of hooks) {
    if (hook.event !== event) continue;

    const context: HookContext = {
      event,
      runContext,
      ...extra,
    };

    await runLifecycleHandlerDefensively(hook, context);
  }
}
