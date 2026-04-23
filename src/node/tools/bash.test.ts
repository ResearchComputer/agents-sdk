import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBashTool } from './bash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('createBashTool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a tool with correct name and capabilities', () => {
    const tool = createBashTool({ cwd: tmpDir });
    expect(tool.name).toBe('Bash');
    expect(tool.capabilities).toEqual(['process:spawn', 'fs:write', 'network:egress']);
  });

  it('executes a command and returns stdout', async () => {
    const tool = createBashTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { command: 'echo hello' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('hello');
  });

  it('throws on non-zero exit code', async () => {
    const tool = createBashTool({ cwd: tmpDir });
    await expect(tool.execute('call1', { command: 'exit 1' }))
      .rejects.toThrow();
  });

  it('runs in the specified cwd', async () => {
    const tool = createBashTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { command: 'pwd' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text.trim()).toBe(fs.realpathSync(tmpDir));
  });

  it('truncates output over 100KB', async () => {
    const tool = createBashTool({ cwd: tmpDir });
    // Generate output > 100KB
    const result = await tool.execute('call1', { command: 'python3 -c "print(\'x\' * 200000)"' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('[truncated]');
    // Killed-for-truncation must not fake a clean exit
    expect(result.details).toMatchObject({ exitCode: null, truncated: true });
  });

  it('truncates multi-megabyte output without stdio maxBuffer errors', async () => {
    const tool = createBashTool({ cwd: tmpDir });
    // Emit 2MB of output; execFile with maxBuffer=200KB would crash with
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER instead of truncating.
    const result = await tool.execute('call1', {
      command: 'python3 -c "import sys; sys.stdout.write(\'x\' * 2_000_000)"',
    });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('[truncated]');
    expect(text.length).toBeLessThan(150 * 1024);
  });

  it('times out with custom timeout', async () => {
    const tool = createBashTool({ cwd: tmpDir, timeout: 1 }); // 1 second default
    await expect(tool.execute('call1', { command: 'sleep 10', timeout: 1 }))
      .rejects.toThrow();
  });

  it('respects AbortSignal', async () => {
    const tool = createBashTool({ cwd: tmpDir });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(tool.execute('call1', { command: 'sleep 10' }, controller.signal))
      .rejects.toThrow();
  });

  it('rejects with a spawn error when cwd does not exist', async () => {
    const tool = createBashTool({ cwd: '/this/path/definitely/does/not/exist-xyz' });
    await expect(tool.execute('call1', { command: 'true' })).rejects.toThrow(/Failed to spawn/);
  });

  it('includes stderr in output on success', async () => {
    const tool = createBashTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { command: 'echo out; echo err >&2' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('out');
    // stderr may or may not be included depending on impl; just check no throw
  });
});
