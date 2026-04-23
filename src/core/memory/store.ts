import type { Memory } from '../types.js';

/**
 * Persistence layer for memories. Implementations own the storage
 * medium (filesystem, HTTP service, in-memory, etc.). The pure
 * relevance-scoring `retrieve()` function in this directory operates
 * on an already-loaded `Memory[]` and does not touch the store.
 */
export interface MemoryStore {
  load(): Promise<Memory[]>;
  save(memory: Memory): Promise<void>;
  remove(name: string): Promise<void>;
}
