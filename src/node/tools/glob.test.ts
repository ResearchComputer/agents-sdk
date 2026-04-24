import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createGlobTool } from './glob.js';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('createGlobTool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-test-'));
    // Create test structure
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'c.js'), '');
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a tool with correct name and capabilities', () => {
    const tool = createGlobTool({ cwd: tmpDir });
    expect(tool.name).toBe('Glob');
    expect(tool.capabilities).toEqual(['fs:read']);
  });

  it('finds files matching a pattern', async () => {
    const tool = createGlobTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: '**/*.ts' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).not.toContain('c.js');
  });

  it('returns results sorted alphabetically', async () => {
    const tool = createGlobTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: '**/*.ts' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const lines = text.split('\n').filter(Boolean);
    const sorted = [...lines].sort();
    expect(lines).toEqual(sorted);
  });

  it('supports custom path parameter', async () => {
    const tool = createGlobTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: '*.ts', path: path.join(tmpDir, 'src') });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('a.ts');
  });

  it('returns empty for no matches', async () => {
    const tool = createGlobTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: '**/*.xyz' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text.trim()).toBe('');
  });

  it('returns path-not-allowed error when path escapes cwd', async () => {
    const tool = createGlobTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: '*', path: '/etc' });
    expect(result.details).toEqual({ error: 'path_not_allowed' });
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/outside the allowed/);
  });

  it('falls back to readdir walker when fs.glob is unavailable (Node 20 path)', async () => {
    const originalGlob = (fsPromises as any).glob;
    try {
      (fsPromises as any).glob = undefined;
      const tool = createGlobTool({ cwd: tmpDir });
      const result = await tool.execute('call1', { pattern: '**/*.ts' });
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('a.ts');
      expect(text).toContain('b.ts');
      expect(text).not.toContain('c.js');
    } finally {
      (fsPromises as any).glob = originalGlob;
    }
  });

  it('fallback walker survives unreadable subdirectories', async () => {
    const unreadable = path.join(tmpDir, 'locked');
    fs.mkdirSync(unreadable);
    fs.chmodSync(unreadable, 0o000);
    const originalGlob = (fsPromises as any).glob;
    try {
      (fsPromises as any).glob = undefined;
      const tool = createGlobTool({ cwd: tmpDir });
      const result = await tool.execute('call1', { pattern: '**/*.ts' });
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('a.ts');
    } finally {
      (fsPromises as any).glob = originalGlob;
      fs.chmodSync(unreadable, 0o755);
    }
  });

  it('fallback walker skips symlinks that point outside the sandbox', async () => {
    const originalGlob = (fsPromises as any).glob;
    (fsPromises as any).glob = undefined;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'SECRET');
    try {
      const linkPath = path.join(tmpDir, 'src', 'leak');
      try {
        fs.symlinkSync(outside, linkPath);
      } catch {
        // CI permission oddity — skip on systems that can't create links
        return;
      }
      const tool = createGlobTool({ cwd: tmpDir });
      const result = await tool.execute('call1', { pattern: '**/*.ts' });
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain('secret.ts');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      (fsPromises as any).glob = originalGlob;
    }
  });
});
