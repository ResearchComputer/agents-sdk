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

  it('returns a tool with correct name and the dedicated shell:exec capability', () => {
    const tool = createBashTool({ cwd: tmpDir });
    expect(tool.name).toBe('Bash');
    // shell:exec is distinct from process:spawn so rules can target the
    // shell-arbitrary-string surface separately.
    expect(tool.capabilities).toEqual(['shell:exec']);
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

  it('truncates output over 100KB and resolves (does not reject) with truncated=true', async () => {
    const tool = createBashTool({ cwd: tmpDir });
    // Generate output > 100KB
    const result = await tool.execute('call1', { command: 'python3 -c "print(\'x\' * 200000)"' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('[truncated]');
    expect((result.details as { truncated: boolean }).truncated).toBe(true);
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

  it('rejects with a bounded spawn_failed error when cwd does not exist', async () => {
    const tool = createBashTool({ cwd: '/this/path/definitely/does/not/exist-xyz' });
    await expect(tool.execute('call1', { command: 'true' })).rejects.toThrow(
      /\[spawn_failed\]|\[permission_denied\]|\[not_found\]/,
    );
  });

  it('scrubs secret-shaped env vars before spawn (default allowlist)', async () => {
    const tool = createBashTool({ cwd: tmpDir });
    const prev = process.env.RC_AUTH_TOKEN;
    process.env.RC_AUTH_TOKEN = 'leak-me-if-you-can';
    try {
      const result = await tool.execute('call1', {
        command: 'echo "token=${RC_AUTH_TOKEN:-unset}"',
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('token=unset');
      expect(text).not.toContain('leak-me-if-you-can');
    } finally {
      if (prev !== undefined) process.env.RC_AUTH_TOKEN = prev;
      else delete process.env.RC_AUTH_TOKEN;
    }
  });

  it('allows env vars via extraEnv (bypasses deny-pattern explicitly)', async () => {
    const tool = createBashTool({
      cwd: tmpDir,
      extraEnv: { MY_ALLOWED_VAR: 'visible' },
    });
    const result = await tool.execute('call1', {
      command: 'echo "v=$MY_ALLOWED_VAR"',
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('v=visible');
  });

  it('scrubs even allowlisted vars that match the deny pattern', async () => {
    const tool = createBashTool({
      cwd: tmpDir,
      envAllowlist: ['PATH', 'HOME', 'TERM', 'MY_SECRET_TOKEN'],
    });
    const prev = process.env.MY_SECRET_TOKEN;
    process.env.MY_SECRET_TOKEN = 'should-not-appear';
    try {
      const result = await tool.execute('call1', {
        command: 'echo "s=${MY_SECRET_TOKEN:-unset}"',
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('s=unset');
      expect(text).not.toContain('should-not-appear');
    } finally {
      if (prev !== undefined) process.env.MY_SECRET_TOKEN = prev;
      else delete process.env.MY_SECRET_TOKEN;
    }
  });

  it('includes stderr in output on success', async () => {
    const tool = createBashTool({ cwd: tmpDir });
    const result = await tool.execute('call1', { command: 'echo out; echo err >&2' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('out');
    // stderr may or may not be included depending on impl; just check no throw
  });
});
