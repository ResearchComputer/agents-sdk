import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
} from '@mariozechner/pi-agent-core';
import type { HookHandler, RunContext } from '../types.js';
import { runPreToolUseHooks, runPostToolUseHooks } from './hooks.js';

export interface PipelineConfig {
  hooks: HookHandler[];
  permissionGate: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  runContext: RunContext;
}

export interface Pipeline {
  beforeToolCall: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

export function composePipeline(config: PipelineConfig): Pipeline {
  const { hooks, permissionGate, runContext } = config;

  return {
    async beforeToolCall(context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
      const toolName = context.toolCall.name;
      const toolCallId = context.toolCall.id;

      // 1. PreToolUse hooks run first (can modify args, CANNOT veto)
      const updatedArgs = await runPreToolUseHooks(hooks, toolName, context.args, runContext, toolCallId);

      // Create updated context with modified args
      const updatedContext: BeforeToolCallContext = updatedArgs !== context.args
        ? { ...context, args: updatedArgs }
        : context;

      // 2. Permission gate runs second (CAN veto)
      return permissionGate(updatedContext, signal);
    },

    async afterToolCall(context: AfterToolCallContext, _signal?: AbortSignal): Promise<AfterToolCallResult | undefined> {
      const toolName = context.toolCall.name;
      const toolCallId = context.toolCall.id;

      // Run PostToolUse hooks (can modify result)
      const updatedResult = await runPostToolUseHooks(hooks, toolName, context.result, runContext, toolCallId);

      // If result was modified, return the override
      if (updatedResult !== context.result) {
        return { content: updatedResult.content, details: updatedResult.details };
      }

      return undefined;
    },
  };
}
