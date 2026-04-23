import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createGrepTool } from './grep.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('createGrepTool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), 'const hello = "world";\nconst foo = "bar";\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.ts'), 'import { hello } from "./a";\n');
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), 'This is a readme.\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a tool with correct name and capabilities', () => {
    const tool = createGrepTool({ cwd: tmpDir });
    expect(tool.name).toBe('Grep');
    expect(tool.capabilities).toEqual(['fs:read']);
  });

  it('finds matches in files', async () => {
    const tool = createGrepTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: 'hello' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('hello');
  });

  it('supports custom path', async () => {
    const tool = createGrepTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: 'hello', path: path.join(tmpDir, 'src') });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('hello');
  });

  it('supports glob filter', async () => {
    const tool = createGrepTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: 'hello', glob: '*.ts' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('hello');
  });

  it('returns empty for no matches', async () => {
    const tool = createGrepTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: 'zzzznothere' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text.trim()).toBe('');
  });

  it('returns path-not-allowed error when path escapes cwd', async () => {
    const tool = createGrepTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: 'anything', path: '/etc' });
    expect(result.details).toEqual({ error: 'path_not_allowed' });
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/outside the allowed/);
  });

  it('treats a pattern starting with - as literal, not a flag', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'c.ts'), 'token --version string\n');
    const tool = createGrepTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { pattern: '--version' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('token --version string');
    expect(text).not.toMatch(/^ripgrep \d+\.\d+/m);
    expect(text).not.toMatch(/^grep \(GNU/m);
  });
});
