import { describe, it, expect } from 'vitest';
import { createCostTracker } from './cost-tracker.js';
import type { Usage } from '@researchcomputer/ai-provider';

function makeUsage(totalTokens: number, totalCost: number): Usage {
  return {
    input: totalTokens * 0.5,
    output: totalTokens * 0.5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: totalCost * 0.5, output: totalCost * 0.5, cacheRead: 0, cacheWrite: 0, total: totalCost },
  };
}

describe('createCostTracker', () => {
  it('starts with zero totals', () => {
    const tracker = createCostTracker();
    expect(tracker.total()).toEqual({ tokens: 0, cost: 0 });
  });

  it('records usage and accumulates totals', () => {
    const tracker = createCostTracker();
    tracker.record(makeUsage(100, 0.01));
    tracker.record(makeUsage(200, 0.02));
    expect(tracker.total()).toEqual({ tokens: 300, cost: 0.03 });
  });

  it('tracks per-model usage when modelId is provided', () => {
    const tracker = createCostTracker();
    tracker.record(makeUsage(100, 0.01), 'gpt-4');
    tracker.record(makeUsage(50, 0.005), 'gpt-4');
    tracker.record(makeUsage(200, 0.02), 'claude-3');
    const perModel = tracker.perModel();
    expect(perModel.get('gpt-4')).toEqual({ tokens: 150, cost: 0.015 });
    expect(perModel.get('claude-3')).toEqual({ tokens: 200, cost: 0.02 });
  });

  it('does not track model when modelId is omitted', () => {
    const tracker = createCostTracker();
    tracker.record(makeUsage(100, 0.01));
    expect(tracker.perModel().size).toBe(0);
    expect(tracker.total().tokens).toBe(100);
  });

  it('perModel returns a copy', () => {
    const tracker = createCostTracker();
    tracker.record(makeUsage(100, 0.01), 'gpt-4');
    const map1 = tracker.perModel();
    tracker.record(makeUsage(50, 0.005), 'gpt-4');
    const map2 = tracker.perModel();
    expect(map1.get('gpt-4')!.tokens).toBe(100);
    expect(map2.get('gpt-4')!.tokens).toBe(150);
  });
});
