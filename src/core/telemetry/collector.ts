import type { LlmCallRecord, ToolEventRecord, SessionTelemetry } from '../types.js';

export interface TelemetryCollector {
  onLlmCall(record: LlmCallRecord): void;
  onToolEvent(record: ToolEventRecord): void;
  finalize(): SessionTelemetry;
}

export function createTelemetryCollector(options: { optOut: boolean }): TelemetryCollector {
  const llmCalls: LlmCallRecord[] = [];
  const toolEvents: ToolEventRecord[] = [];
  return {
    onLlmCall(record) {
      llmCalls.push(record);
    },
    onToolEvent(record) {
      toolEvents.push(record);
    },
    finalize(): SessionTelemetry {
      const totalTokens = llmCalls.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
      const totalCost = llmCalls.reduce((sum, r) => sum + r.cost, 0);
      return {
        schemaVersion: 1,
        optOut: options.optOut,
        llmCalls: [...llmCalls],
        toolEvents: [...toolEvents],
        totalCost,
        totalTokens,
      };
    },
  };
}
