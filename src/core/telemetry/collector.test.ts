import { describe, it, expect } from 'vitest';
import { createTelemetryCollector } from './collector.js';

describe('TelemetryCollector', () => {
  it('aggregates tokens and cost across llm calls', () => {
    const c = createTelemetryCollector({ optOut: false });
    c.onLlmCall({ timestamp: 1, modelId: 'm', inputTokens: 10, outputTokens: 5, cost: 0.01, latencyMs: 100 });
    c.onLlmCall({ timestamp: 2, modelId: 'm', inputTokens: 20, outputTokens: 8, cost: 0.02, latencyMs: 150 });
    const t = c.finalize();
    expect(t.totalTokens).toBe(43);
    expect(t.totalCost).toBeCloseTo(0.03);
    expect(t.llmCalls).toHaveLength(2);
    expect(t.optOut).toBe(false);
  });

  it('records tool events', () => {
    const c = createTelemetryCollector({ optOut: false });
    c.onToolEvent({ timestamp: 1, toolName: 'Read', durationMs: 10, success: true });
    const t = c.finalize();
    expect(t.toolEvents).toHaveLength(1);
  });

  it('propagates optOut into finalized telemetry', () => {
    const c = createTelemetryCollector({ optOut: true });
    const t = c.finalize();
    expect(t.optOut).toBe(true);
  });
});
