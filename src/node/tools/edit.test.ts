import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEditTool } from './edit.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('createEditTool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a tool with correct name and capabilities', () => {
    const tool = createEditTool({ cwd: tmpDir });
    expect(tool.name).toBe('Edit');
    expect(tool.capabilities).toEqual(['fs:write']);
  });

  it('replaces a unique match', async () => {
    const filePath = path.join(tmpDir, 'file.ts');
    fs.writeFileSync(filePath, 'const a = 1;\nconst b = 2;\n');
    const tool = createEditTool({ cwd: tmpDir });
    await tool.execute('call1', { file_path: filePath, old_string: 'const a = 1;', new_string: 'const a = 42;' });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('const a = 42;\nconst b = 2;\n');
  });

  it('throws when old_string not found', async () => {
    const filePath = path.join(tmpDir, 'file.ts');
    fs.writeFileSync(filePath, 'hello world');
    const tool = createEditTool({ cwd: tmpDir });
    await expect(tool.execute('call1', { file_path: filePath, old_string: 'not here', new_string: 'x' }))
      .rejects.toThrow(/not found/i);
  });

  it('throws when multiple matches and replace_all is false', async () => {
    const filePath = path.join(tmpDir, 'file.ts');
    fs.writeFileSync(filePath, 'foo bar foo baz foo');
    const tool = createEditTool({ cwd: tmpDir });
    await expect(tool.execute('call1', { file_path: filePath, old_string: 'foo', new_string: 'qux' }))
      .rejects.toThrow(/ambiguous|multiple/i);
  });

  it('replaces all occurrences when replace_all is true', async () => {
    const filePath = path.join(tmpDir, 'file.ts');
    fs.writeFileSync(filePath, 'foo bar foo baz foo');
    const tool = createEditTool({ cwd: tmpDir });
    await tool.execute('call1', { file_path: filePath, old_string: 'foo', new_string: 'qux', replace_all: true });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('qux bar qux baz qux');
  });

  it('throws for path outside cwd', async () => {
    const tool = createEditTool({ cwd: tmpDir });
    await expect(tool.execute('call1', { file_path: '/etc/passwd', old_string: 'a', new_string: 'b' }))
      .rejects.toThrow(/not allowed/i);
  });

  it('throws when target file does not exist', async () => {
    const tool = createEditTool({ cwd: tmpDir });
    await expect(
      tool.execute('call1', {
        file_path: path.join(tmpDir, 'missing.txt'),
        old_string: 'a',
        new_string: 'b',
      }),
    ).rejects.toThrow(/Failed to read file/);
  });

  it('resolves relative paths against cwd', async () => {
    const filePath = path.join(tmpDir, 'rel.txt');
    fs.writeFileSync(filePath, 'old content');
    const tool = createEditTool({ cwd: tmpDir });
    await tool.execute('call1', { file_path: 'rel.txt', old_string: 'old', new_string: 'new' });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
  });
});
