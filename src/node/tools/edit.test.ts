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
      .rejects.toThrow(/\[invalid_input\] multiple matches/i);
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
      .rejects.toThrow(/path_not_allowed/i);
  });

  it('throws not_found when target file does not exist', async () => {
    const tool = createEditTool({ cwd: tmpDir });
    await expect(
      tool.execute('call1', {
        file_path: path.join(tmpDir, 'missing.txt'),
        old_string: 'a',
        new_string: 'b',
      }),
    ).rejects.toThrow(/\[not_found\]/);
  });

  it('resolves relative paths against cwd', async () => {
    const filePath = path.join(tmpDir, 'rel.txt');
    fs.writeFileSync(filePath, 'old content');
    const tool = createEditTool({ cwd: tmpDir });
    await tool.execute('call1', { file_path: 'rel.txt', old_string: 'old', new_string: 'new' });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('refuses to edit binary files (contains null byte in first 8KB)', async () => {
    const filePath = path.join(tmpDir, 'blob.bin');
    fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const tool = createEditTool({ cwd: tmpDir });
    await expect(
      tool.execute('call1', { file_path: filePath, old_string: 'x', new_string: 'y' }),
    ).rejects.toThrow(/\[binary_file\]/);
  });

  it('rejects lone surrogate in old_string or new_string', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'hello world');
    const tool = createEditTool({ cwd: tmpDir });
    await expect(
      tool.execute('call1', {
        file_path: filePath,
        old_string: 'hello',
        // Lone high surrogate (U+D83D without trailing low surrogate)
        new_string: '\uD83D',
      }),
    ).rejects.toThrow(/\[invalid_input\] string contains lone surrogates/);
  });

  it('counts overlapping matches correctly (aa in aaa is 2, not 1)', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'aaa');
    const tool = createEditTool({ cwd: tmpDir });
    // With overlap detection, `aa` appears at positions 0 AND 1, so
    // replace_all=false must refuse with multiple-matches.
    await expect(
      tool.execute('call1', {
        file_path: filePath,
        old_string: 'aa',
        new_string: 'b',
      }),
    ).rejects.toThrow(/\[invalid_input\] multiple matches/);
  });

  it('parallel Edits on the same file do not race (PathMutex serializes)', async () => {
    const filePath = path.join(tmpDir, 'race.txt');
    fs.writeFileSync(filePath, 'start');
    const tool = createEditTool({ cwd: tmpDir });
    // Two simultaneous Edits: first replaces "start" with "mid", second
    // replaces "mid" with "end". If the mutex works, we get "end". If they
    // race, the second Edit reads "start" (before the first writes) and
    // fails with old_string-not-found, OR both execute against stale state
    // and we end with "mid".
    const run = async () => {
      await tool.execute('c1', {
        file_path: filePath,
        old_string: 'start',
        new_string: 'mid',
      });
    };
    const run2 = async () => {
      await tool.execute('c2', {
        file_path: filePath,
        old_string: 'mid',
        new_string: 'end',
      });
    };
    await Promise.all([run(), run2()]);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('end');
  });

  it('uses atomic tmp-and-rename — no .tmp file remains on success', async () => {
    const filePath = path.join(tmpDir, 'atomic.txt');
    fs.writeFileSync(filePath, 'a');
    const tool = createEditTool({ cwd: tmpDir });
    await tool.execute('c1', { file_path: filePath, old_string: 'a', new_string: 'b' });
    const files = fs.readdirSync(tmpDir);
    expect(files.filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});
