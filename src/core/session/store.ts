import type { SessionSnapshot } from '../types.js';

export interface SessionStore {
  load(id: string): Promise<SessionSnapshot | null>;
  save(snapshot: SessionSnapshot): Promise<void>;
  list(): Promise<{ id: string; updatedAt: number }[]>;
}
