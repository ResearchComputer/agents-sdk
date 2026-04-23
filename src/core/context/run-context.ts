import { createCostTracker } from '../observability/cost-tracker.js';
import { generateTraceId } from '../observability/trace.js';
import type { CostTracker, RunContext } from '../types.js';

export interface RunContextOptions {
  cwd: string;
  sessionId?: string;
  traceId?: string;
  signal?: AbortSignal;
  /** Shared cost tracker. When omitted, a fresh one is created. */
  costTracker?: CostTracker;
}

export function createRunContext(options: RunContextOptions): RunContext {
  return {
    cwd: options.cwd,
    sessionId: options.sessionId ?? globalThis.crypto.randomUUID(),
    traceId: options.traceId ?? generateTraceId(),
    signal: options.signal ?? AbortSignal.timeout(2_147_483_647),
    costTracker: options.costTracker ?? createCostTracker(),
    // Fresh log per run context. Forked/resumed agents always get a new
    // RunContext, so permission decisions never bleed across sessions.
    permissionDecisions: [],
  };
}
