import type { Memory, MemorySelection } from '../types.js';

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter(t => t.length > 0);
}

// Per-memory precomputed term frequency + word count. Built once per
// retrieve() call and reused across query terms. At large memory counts
// this avoids re-tokenizing every document for every query invocation.
interface MemoryIndex {
  termFreq: Map<string, number>;
  wordCount: number;
}

function buildIndex(memory: Memory): MemoryIndex {
  const tokens = tokenize(memory.description + ' ' + memory.content);
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return { termFreq, wordCount: tokens.length || 1 };
}

export function retrieve(
  memories: Memory[],
  context: { query: string; maxItems?: number; maxTokens?: number },
): MemorySelection[] {
  const maxItems = context.maxItems ?? 10;
  const maxTokens = context.maxTokens ?? Infinity;
  const queryTerms = tokenize(context.query);

  // Empty query: return all memories up to limits (most recent first)
  if (queryTerms.length === 0) {
    const results: MemorySelection[] = [];
    let tokenBudget = 0;
    for (let i = 0; i < memories.length; i++) {
      if (results.length >= maxItems) break;
      const itemTokens = Math.ceil(memories[i].content.length / 4);
      if (tokenBudget + itemTokens > maxTokens) break;
      tokenBudget += itemTokens;
      results.push({ memory: memories[i], relevanceScore: 1, source: 'memory', updatedAt: Date.now() - i });
    }
    return results;
  }

  // Dedup query terms — repeating a term in the query shouldn't multiply
  // its weight (`foo foo` == `foo`), which also halves work here.
  const uniqueQueryTerms = Array.from(new Set(queryTerms));

  const scored: MemorySelection[] = memories.map((memory, index) => {
    const idx = buildIndex(memory);

    let score = 0;
    for (const term of uniqueQueryTerms) {
      const count = idx.termFreq.get(term);
      if (count) score += count / idx.wordCount;
    }

    return {
      memory,
      relevanceScore: score,
      source: 'memory',
      updatedAt: Date.now() - index, // recency tiebreaker
    };
  });

  scored.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    return b.updatedAt - a.updatedAt;
  });

  const results: MemorySelection[] = [];
  let tokenBudget = 0;
  for (const item of scored) {
    if (item.relevanceScore === 0) break;
    if (results.length >= maxItems) break;
    const itemTokens = Math.ceil(item.memory.content.length / 4); // rough estimate
    if (tokenBudget + itemTokens > maxTokens) break;
    tokenBudget += itemTokens;
    results.push(item);
  }

  return results;
}
