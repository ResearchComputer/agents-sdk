import { Type } from '@sinclair/typebox';
import { spawn } from 'node:child_process';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';
import { safeToolError } from '../security/index.js';

const MAX_OUTPUT = 100 * 1024; // 100KB per channel (stdout + stderr each)
const DEFAULT_TIMEOUT = 120 * 1000; // 120 seconds

const BashParams = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number()),
});

/**
 * Default env allowlist: what the spawned shell is allowed to see from the
 * parent process. Anything else (notably tokens, API keys, auth secrets)
 * is stripped before spawn. Callers with legitimate env needs (e.g. tests
 * setting CI vars) can extend via `BashToolOptions.envAllowlist`.
 */
const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HOSTNAME',
  'PWD',
  'OLDPWD',
];

/**
 * Deny-list pattern: even if a variable is on the allowlist, drop it if
 * the name matches. Last-line defense against a caller who allowlists
 * broadly and leaks credentials.
 */
const DENY_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|AUTH|STYTCH|RC_[A-Z]/i;

export interface BashToolOptions extends ToolOptions {
  timeout?: number;
  /**
   * Override the default env allowlist. Only these environment variables
   * (minus anything matching DENY_PATTERN) are passed to the child
   * process. Pass an empty array to disable env inheritance entirely.
   */
  envAllowlist?: string[];
  /**
   * Additional environment variables to inject into the child. Applied
   * after the allowlist filter, so callers can pass values that would
   * otherwise be denied. Use with care.
   */
  extraEnv?: Record<string, string>;
}

/** Build the scrubbed env snapshot for each spawn. Captures process.env at
 *  execute() time, not tool-factory time, so late env mutations are honored. */
function scrubEnv(
  allowlist: readonly string[],
  extra?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allowlist) {
    const value = process.env[name];
    if (value === undefined) continue;
    if (DENY_PATTERN.test(name)) continue;
    out[name] = value;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Kill the child's entire process group on Linux/macOS so that
 * backgrounded subprocesses (`cmd &`) are reaped alongside the bash
 * parent. On Windows we fall back to killing the direct child only
 * (process groups don't apply the same way).
 */
function groupKill(pid: number | undefined, signal: NodeJS.Signals, fallback: () => void): void {
  if (pid == null) {
    fallback();
    return;
  }
  if (process.platform === 'win32') {
    fallback();
    return;
  }
  try {
    // Negative PID targets the entire process group. Only works if the
    // child was spawned with { detached: true } so it became its own
    // group leader.
    process.kill(-pid, signal);
  } catch {
    // If the group-kill fails (process already dead, permission denied),
    // fall back to the direct-child kill so we don't leak.
    fallback();
  }
}

export function createBashTool(options?: BashToolOptions): SdkTool<typeof BashParams> {
  const cwd = options?.cwd ?? process.cwd();
  const defaultTimeout = options?.timeout ? options.timeout * 1000 : DEFAULT_TIMEOUT;
  const envAllowlist = options?.envAllowlist ?? DEFAULT_ENV_ALLOWLIST;

  return {
    name: 'Bash',
    label: 'Execute bash command',
    description: 'Executes a bash command and returns its output.',
    parameters: BashParams,
    // `shell:exec` is distinct from `process:spawn` because it grants the
    // LLM an arbitrary shell string, whereas process:spawn can be granted
    // to tools that exec a validated argv. Bash is always the broadest
    // permission and should be rule-matched independently.
    capabilities: ['shell:exec'],
    async execute(_toolCallId, params, signal?) {
      const timeoutMs = params.timeout ? params.timeout * 1000 : defaultTimeout;

      return new Promise((resolve, reject) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutSize = 0;
        let stderrSize = 0;
        let truncated = false;
        let truncKilled = false;
        let timedOut = false;
        let aborted = false;
        let settled = false;

        const env = scrubEnv(envAllowlist, options?.extraEnv);
        const child = spawn('bash', ['-c', params.command], {
          cwd,
          signal,
          env,
          // Become a new process group leader so we can group-kill
          // backgrounded subprocesses on timeout / truncation.
          detached: process.platform !== 'win32',
        });

        // Detached children must be explicitly unref'd if the parent
        // shouldn't wait on them; we keep the reference because we DO
        // want to wait (and group-kill on finish).

        const timer = setTimeout(() => {
          timedOut = true;
          groupKill(child.pid, 'SIGTERM', () => child.kill('SIGTERM'));
          setTimeout(
            () => groupKill(child.pid, 'SIGKILL', () => child.kill('SIGKILL')),
            2000,
          ).unref();
        }, timeoutMs);
        timer.unref();

        function killOnTruncate() {
          if (truncKilled) return;
          truncKilled = true;
          groupKill(child.pid, 'SIGTERM', () => child.kill('SIGTERM'));
        }

        function accept(chunks: Buffer[], size: number, chunk: Buffer): number {
          if (size >= MAX_OUTPUT) {
            truncated = true;
            killOnTruncate();
            return size;
          }
          const room = MAX_OUTPUT - size;
          const keep = chunk.length <= room ? chunk : chunk.subarray(0, room);
          chunks.push(keep);
          if (chunk.length > room) {
            truncated = true;
            killOnTruncate();
          }
          return size + keep.length;
        }

        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutSize = accept(stdoutChunks, stdoutSize, chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrSize = accept(stderrChunks, stderrSize, chunk);
        });

        child.on('error', (err: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
            aborted = true;
            reject(safeToolError(err, 'timeout'));
            return;
          }
          reject(safeToolError(err, 'spawn_failed'));
        });

        child.on('close', (code, killSignal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          if (aborted || (signal && signal.aborted)) {
            reject(safeToolError(new Error('aborted'), 'timeout'));
            return;
          }
          if (timedOut) {
            reject(safeToolError(new Error('timed out'), 'timeout'));
            return;
          }

          const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
          const stderr = Buffer.concat(stderrChunks).toString('utf-8');
          const combined = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '');
          const output = truncated ? combined + '\n[truncated]' : combined;

          if (truncated) {
            // Resolve (not reject) with partial output. The LLM sees the
            // `truncated` flag; previously this rejected as an error with
            // the partial output embedded in the message, which leaked
            // bounded data through the error channel.
            resolve({
              content: [{ type: 'text', text: output }],
              details: { exitCode: code, truncated: true, killSignal },
            });
            return;
          }

          if (code !== 0) {
            // Include the output but NOT as an unbounded error message —
            // wrap in ToolExecutionError; output is already size-capped
            // via MAX_OUTPUT.
            reject(
              new ToolExecutionError(
                `[spawn_failed] command exited with code ${code}\n${output}`,
              ),
            );
            return;
          }

          resolve({
            content: [{ type: 'text', text: output }],
            details: { exitCode: code ?? 0 },
          });
        });
      });
    },
  };
}
