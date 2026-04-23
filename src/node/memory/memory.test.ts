import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNodeMemoryStore } from './node-memory-store.js';
import { retrieve } from '../../core/memory/retrieve.js';
import type { Memory } from '../../core/types.js';

describe('Node MemoryStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const sampleMemory: Memory = {
    name: 'test-memory',
    description: 'A test memory for unit testing',
    type: 'user',
    content: 'This is the memory content about TypeScript testing.',
  };

  describe('save and load roundtrip', () => {
    it('saves and loads a memory correctly', async () => {
      const store = createNodeMemoryStore(tmpDir);
      await store.save(sampleMemory);
      const loaded = await store.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(sampleMemory);
    });

    it('saves multiple memories', async () => {
      const store = createNodeMemoryStore(tmpDir);
      await store.save(sampleMemory);
      await store.save({ ...sampleMemory, name: 'second', description: 'Second memory', content: 'Other content' });
      const loaded = await store.load();
      expect(loaded).toHaveLength(2);
    });

    it('sanitizes filenames with special characters', async () => {
      const store = createNodeMemoryStore(tmpDir);
      const mem: Memory = { ...sampleMemory, name: 'My Memory! @#$%' };
      await store.save(mem);
      const files = await fs.readdir(tmpDir);
      expect(files[0]).toBe('my-memory.md');
      const loaded = await store.load();
      expect(loaded[0].name).toBe('My Memory! @#$%');
    });

    it('creates directory if it does not exist', async () => {
      const subdir = path.join(tmpDir, 'nested', 'dir');
      const store = createNodeMemoryStore(subdir);
      await store.save(sampleMemory);
      const loaded = await store.load();
      expect(loaded).toHaveLength(1);
    });

    it('returns empty array for non-existent directory', async () => {
      const store = createNodeMemoryStore(path.join(tmpDir, 'nonexistent'));
      const loaded = await store.load();
      expect(loaded).toEqual([]);
    });
  });

  describe('remove', () => {
    it('removes a saved memory', async () => {
      const store = createNodeMemoryStore(tmpDir);
      await store.save(sampleMemory);
      await store.remove(sampleMemory.name);
      const loaded = await store.load();
      expect(loaded).toHaveLength(0);
    });

    it('does not throw when removing non-existent memory', async () => {
      const store = createNodeMemoryStore(tmpDir);
      await expect(store.remove('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('save durability and validation', () => {
    it('leaves no .tmp artifact after save', async () => {
      const store = createNodeMemoryStore(tmpDir);
      await store.save(sampleMemory);
      const files = await fs.readdir(tmpDir);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });

    it('rejects a memory name containing a newline', async () => {
      const store = createNodeMemoryStore(tmpDir);
      await expect(
        store.save({ ...sampleMemory, name: 'line-one\nline-two' }),
      ).rejects.toThrow(/newlines/);
    });

    it('rejects a description containing a newline', async () => {
      const store = createNodeMemoryStore(tmpDir);
      await expect(
        store.save({ ...sampleMemory, description: 'first\nsecond' }),
      ).rejects.toThrow(/newlines/);
    });

    it('skips .md files without frontmatter delimiters when loading', async () => {
      await fs.writeFile(path.join(tmpDir, 'no-frontmatter.md'), '# just markdown\n', 'utf-8');
      const store = createNodeMemoryStore(tmpDir);
      const loaded = await store.load();
      expect(loaded).toHaveLength(0);
    });

    it('skips .md files with frontmatter missing required fields', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'partial.md'),
        '---\nname: onlyname\n---\n\nbody\n',
        'utf-8',
      );
      const store = createNodeMemoryStore(tmpDir);
      const loaded = await store.load();
      expect(loaded).toHaveLength(0);
    });
  });

  describe('retrieve', () => {
    const memories: Memory[] = [
      { name: 'typescript', description: 'TypeScript patterns', type: 'reference', content: 'TypeScript uses strict typing and interfaces for code quality.' },
      { name: 'python', description: 'Python patterns', type: 'reference', content: 'Python uses dynamic typing and duck typing for flexibility.' },
      { name: 'testing', description: 'Testing best practices', type: 'project', content: 'Testing with vitest requires describe and it blocks.' },
    ];

    it('returns memories matching query keywords', () => {
      const results = retrieve(memories, { query: 'TypeScript typing' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.name).toBe('typescript');
    });

    it('returns empty array for no matching query', () => {
      const results = retrieve(memories, { query: 'zzzznoMatch' });
      expect(results).toHaveLength(0);
    });

    it('respects maxItems', () => {
      const results = retrieve(memories, { query: 'typing', maxItems: 1 });
      expect(results).toHaveLength(1);
    });

    it('respects maxTokens budget', () => {
      const results = retrieve(memories, { query: 'typing', maxTokens: 5 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('returns all memories for empty query', () => {
      const results = retrieve(memories, { query: '' });
      expect(results).toHaveLength(3);
      expect(results[0].relevanceScore).toBe(1);
    });

    it('respects maxItems on the empty-query path', () => {
      const results = retrieve(memories, { query: '', maxItems: 2 });
      expect(results).toHaveLength(2);
    });

    it('respects maxTokens on the empty-query path', () => {
      const results = retrieve(memories, { query: '', maxTokens: 5 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('handles a memory with empty indexable text without dividing by zero', () => {
      const blank: Memory = { name: 'blank', description: '', type: 'reference', content: '' };
      const results = retrieve([blank, ...memories], { query: 'typing' });
      expect(results.every((r) => Number.isFinite(r.relevanceScore))).toBe(true);
    });
  });
});
