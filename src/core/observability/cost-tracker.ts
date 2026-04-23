import type { Usage } from '@researchcomputer/ai-provider';
import type { CostTracker } from '../types.js';

export function createCostTracker(): CostTracker {
  let totalTokens = 0;
  let totalCost = 0;
  const models = new Map<string, { tokens: number; cost: number }>();
  return {
    record(usage: Usage, modelId?: string) {
      totalTokens += usage.totalTokens;
      totalCost += usage.cost.total;
      if (modelId) {
        const existing = models.get(modelId) ?? { tokens: 0, cost: 0 };
        existing.tokens += usage.totalTokens;
        existing.cost += usage.cost.total;
        models.set(modelId, existing);
      }
    },
    total() { return { tokens: totalTokens, cost: totalCost }; },
    perModel() {
      const copy = new Map<string, { tokens: number; cost: number }>();
      for (const [key, value] of models) {
        copy.set(key, { ...value });
      }
      return copy;
    },
  };
}
