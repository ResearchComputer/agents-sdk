import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionSnapshot } from '../../core/types.js';
import type { SessionStore } from '../../core/session/store.js';
import { SessionLoadError } from '../../core/errors.js';
import { safeSessionFileId } from './safe-id.js';

export function createNodeSessionStore(dir: string): SessionStore {
  return {
    async save(snapshot: SessionSnapshot): Promise<void> {
      await fs.mkdir(dir, { recursive: true });
      const safeId = safeSessionFileId(snapshot.id);
      const filePath = path.join(dir, `${safeId}.json`);
      const tmpPath = `${filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);
    },

    async load(id: string): Promise<SessionSnapshot | null> {
      const safeId = safeSessionFileId(id);
      const filePath = path.join(dir, `${safeId}.json`);
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch (err: any) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new SessionLoadError(`Corrupt session file: ${id}.json`);
      }

      if (parsed.version !== 2) {
        throw new SessionLoadError(`Unsupported session version: ${parsed.version}`);
      }

      return parsed as SessionSnapshot;
    },

    async list(): Promise<{ id: string; updatedAt: number }[]> {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return [];
      }

      const jsonFiles = entries.filter(e => e.endsWith('.json'));
      // Parallel reads + parse-safe per-file catch. Individual corrupt
      // files no longer fail the whole listing; unrelated files in the
      // directory are ignored as before.
      const parsed = await Promise.all(
        jsonFiles.map(async (entry) => {
          try {
            const content = await fs.readFile(path.join(dir, entry), 'utf-8');
            const snap = JSON.parse(content) as { id?: string; updatedAt?: number };
            if (typeof snap.id !== 'string' || typeof snap.updatedAt !== 'number') return null;
            return { id: snap.id, updatedAt: snap.updatedAt };
          } catch {
            return null;
          }
        }),
      );

      const sessions = parsed.filter((s): s is { id: string; updatedAt: number } => s !== null);
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return sessions;
    },
  };
}
