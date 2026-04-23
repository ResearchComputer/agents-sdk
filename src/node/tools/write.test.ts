import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWriteTool } from './write.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('createWriteTool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a tool with correct name and capabilities', () => {
    const tool = createWriteTool({ cwd: tmpDir });
    expect(tool.name).toBe('Write');
    expect(tool.capabilities).toEqual(['fs:write']);
  });

  it('falls back to process.cwd() when no options are provided', () => {
    const tool = createWriteTool();
    expect(tool.name).toBe('Write');
  });

  it('writes content to a file', async () => {
    const tool = createWriteTool({ cwd: tmpDir });
    const filePath = path.join(tmpDir, 'out.txt');
    await tool.execute('call1', { file_path: filePath, content: 'hello world' });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('creates intermediate directories', async () => {
    const tool = createWriteTool({ cwd: tmpDir });
    const filePath = path.join(tmpDir, 'a', 'b', 'c', 'file.txt');
    await tool.execute('call1', { file_path: filePath, content: 'deep' });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('deep');
  });

  it('overwrites existing file', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'old');
    const tool = createWriteTool({ cwd: tmpDir });
    await tool.execute('call1', { file_path: filePath, content: 'new' });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new');
  });

  it('throws for path outside cwd', async () => {
    const tool = createWriteTool({ cwd: tmpDir });
    await expect(tool.execute('call1', { file_path: '/etc/evil.txt', content: 'x' }))
      .rejects.toThrow(/not allowed/i);
  });

  it('resolves relative paths against cwd', async () => {
    const tool = createWriteTool({ cwd: tmpDir });
    await tool.execute('call1', { file_path: 'relative.txt', content: 'rel' });
    expect(fs.readFileSync(path.join(tmpDir, 'relative.txt'), 'utf-8')).toBe('rel');
  });
});
