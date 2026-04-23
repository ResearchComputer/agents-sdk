import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNodeSessionStore } from './node-session-store.js';
import { SessionLoadError } from '../../core/errors.js';
import type { SessionSnapshot } from '../../core/types.js';

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    version: 2,
    id: 'session-1',
    trajectoryId: '01J9ZSZABCDEFGHJKMNPQRSTVW',
    lastEventId: null,
    modelId: 'test-model',
    providerName: 'test-provider',
    systemPromptHash: 'abc123',
    memoryRefs: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('Node SessionStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('save and load roundtrip', () => {
    it('saves and loads a session snapshot', async () => {
      const manager = createNodeSessionStore(tmpDir);
      const snapshot = makeSnapshot();
      await manager.save(snapshot);
      const loaded = await manager.load('session-1');
      expect(loaded).toEqual(snapshot);
    });

    it('creates directory if needed', async () => {
      const subdir = path.join(tmpDir, 'nested', 'sessions');
      const manager = createNodeSessionStore(subdir);
      const snapshot = makeSnapshot();
      await manager.save(snapshot);
      const loaded = await manager.load('session-1');
      expect(loaded).toEqual(snapshot);
    });

    it('leaves no .tmp artifacts after save', async () => {
      const manager = createNodeSessionStore(tmpDir);
      await manager.save(makeSnapshot());
      await manager.save(makeSnapshot({ updatedAt: 3000 }));
      const files = await fs.readdir(tmpDir);
      expect(files.filter(f => f.includes('.tmp'))).toEqual([]);
    });

    it('preserves prior snapshot when write fails', async () => {
      const manager = createNodeSessionStore(tmpDir);
      const original = makeSnapshot({ updatedAt: 1000 });
      await manager.save(original);

      // Force writeFile to fail deterministically by pre-creating a directory
      // at the expected tmp path. This exercises the atomic write invariant:
      // if .tmp write fails, the original file must remain untouched.
      const tmpPath = path.join(tmpDir, 'session-1.json.tmp');
      await fs.mkdir(tmpPath);

      await expect(manager.save(makeSnapshot({ updatedAt: 2000 }))).rejects.toThrow();

      const loaded = await manager.load('session-1');
      expect(loaded).toEqual(original);

      await fs.rmdir(tmpPath);
    });
  });

  describe('load', () => {
    it('returns null for missing session', async () => {
      const manager = createNodeSessionStore(tmpDir);
      const result = await manager.load('nonexistent');
      expect(result).toBeNull();
    });

    it('throws SessionLoadError for corrupt JSON', async () => {
      await fs.writeFile(path.join(tmpDir, 'bad.json'), 'not json', 'utf-8');
      const manager = createNodeSessionStore(tmpDir);
      await expect(manager.load('bad')).rejects.toThrow(SessionLoadError);
    });

    it('throws SessionLoadError for wrong version', async () => {
      const bad = { ...makeSnapshot(), version: 99 };
      await fs.writeFile(path.join(tmpDir, 'v99.json'), JSON.stringify(bad), 'utf-8');
      const manager = createNodeSessionStore(tmpDir);
      await expect(manager.load('v99')).rejects.toThrow(SessionLoadError);
    });
  });

  describe('list', () => {
    it('lists sessions sorted by updatedAt desc', async () => {
      const manager = createNodeSessionStore(tmpDir);
      await manager.save(makeSnapshot({ id: 'old', updatedAt: 1000 }));
      await manager.save(makeSnapshot({ id: 'new', updatedAt: 3000 }));
      await manager.save(makeSnapshot({ id: 'mid', updatedAt: 2000 }));

      const list = await manager.list();
      expect(list).toEqual([
        { id: 'new', updatedAt: 3000 },
        { id: 'mid', updatedAt: 2000 },
        { id: 'old', updatedAt: 1000 },
      ]);
    });

    it('returns empty array for non-existent directory', async () => {
      const manager = createNodeSessionStore(path.join(tmpDir, 'nope'));
      const list = await manager.list();
      expect(list).toEqual([]);
    });

    it('ignores corrupt JSON files and files with missing id/updatedAt', async () => {
      const fs = await import('node:fs/promises');
      await fs.mkdir(tmpDir, { recursive: true });
      const manager = createNodeSessionStore(tmpDir);
      await manager.save(makeSnapshot({ id: 'good', updatedAt: 5000 }));
      await fs.writeFile(path.join(tmpDir, 'corrupt.json'), '{{{ not json', 'utf-8');
      await fs.writeFile(
        path.join(tmpDir, 'partial.json'),
        JSON.stringify({ version: 2, id: 123 }),
        'utf-8',
      );
      const list = await manager.list();
      expect(list).toEqual([{ id: 'good', updatedAt: 5000 }]);
    });
  });
});
