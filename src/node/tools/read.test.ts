import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createReadTool } from './read.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('createReadTool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a tool with correct name and capabilities', () => {
    const tool = createReadTool({ cwd: tmpDir });
    expect(tool.name).toBe('Read');
    expect(tool.capabilities).toEqual(['fs:read']);
  });

  it('falls back to process.cwd() when no options are provided', () => {
    const tool = createReadTool();
    expect(tool.name).toBe('Read');
  });

  it('reads a file and adds line numbers', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3\n');
    const tool = createReadTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { file_path: filePath });
    expect(result.content[0]).toHaveProperty('type', 'text');
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('1\tline1');
    expect(text).toContain('2\tline2');
    expect(text).toContain('3\tline3');
  });

  it('supports offset (1-based)', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'a\nb\nc\nd\ne\n');
    const tool = createReadTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { file_path: filePath, offset: 3 });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('3\tc');
    expect(text).not.toContain('1\ta');
  });

  it('supports limit', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'a\nb\nc\nd\ne\n');
    const tool = createReadTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { file_path: filePath, offset: 2, limit: 2 });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('2\tb');
    expect(text).toContain('3\tc');
    expect(text).not.toContain('4\td');
  });

  it('throws for non-existent file', async () => {
    const tool = createReadTool({ cwd: tmpDir });
    await expect(tool.execute('call1', { file_path: path.join(tmpDir, 'nope.txt') }))
      .rejects.toThrow();
  });

  it('throws for path outside cwd', async () => {
    const tool = createReadTool({ cwd: tmpDir });
    await expect(tool.execute('call1', { file_path: '/etc/passwd' }))
      .rejects.toThrow(/not allowed/i);
  });

  it('resolves relative paths against cwd', async () => {
    const filePath = path.join(tmpDir, 'relative.txt');
    fs.writeFileSync(filePath, 'hello\n');
    const tool = createReadTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { file_path: 'relative.txt' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('1\thello');
  });
});
