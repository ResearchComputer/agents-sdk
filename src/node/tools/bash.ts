import { Type } from '@sinclair/typebox';
import { spawn } from 'node:child_process';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';

const MAX_OUTPUT = 100 * 1024; // 100KB per channel (stdout + stderr each)
const DEFAULT_TIMEOUT = 120 * 1000; // 120 seconds

const BashParams = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number()),
});

export interface BashToolOptions extends ToolOptions {
  timeout?: number;
}

export function createBashTool(options?: BashToolOptions): SdkTool<typeof BashParams> {
  const cwd = options?.cwd ?? process.cwd();
  const defaultTimeout = options?.timeout ? options.timeout * 1000 : DEFAULT_TIMEOUT;

  return {
    name: 'Bash',
    label: 'Execute bash command',
    description: 'Executes a bash command and returns its output.',
    parameters: BashParams,
    capabilities: ['process:spawn', 'fs:write', 'network:egress'],
    async execute(_toolCallId, params, signal?) {
      const timeoutMs = params.timeout ? params.timeout * 1000 : defaultTimeout;

      return new Promise((resolve, reject) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutSize = 0;
        let stderrSize = 0;
        let truncated = false;
        let timedOut = false;
        let aborted = false;
        let settled = false;

        const child = spawn('bash', ['-c', params.command], { cwd, signal });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2000).unref();
        }, timeoutMs);
        timer.unref();

        function accept(chunks: Buffer[], size: number, chunk: Buffer): number {
          if (size >= MAX_OUTPUT) {
            truncated = true;
            child.kill('SIGTERM');
            return size;
          }
          const room = MAX_OUTPUT - size;
          const keep = chunk.length <= room ? chunk : chunk.subarray(0, room);
          chunks.push(keep);
          if (chunk.length > room) {
            truncated = true;
            child.kill('SIGTERM');
          }
          return size + keep.length;
        }

        child.stdout.on('data', (chunk: Buffer) => {
          stdoutSize = accept(stdoutChunks, stdoutSize, chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderrSize = accept(stderrChunks, stderrSize, chunk);
        });

        child.on('error', (err: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
            aborted = true;
            reject(new ToolExecutionError('Command aborted'));
            return;
          }
          reject(new ToolExecutionError(`Failed to spawn command: ${err.message}`));
        });

        child.on('close', (code, killSignal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          if (aborted || (signal && signal.aborted)) {
            reject(new ToolExecutionError('Command aborted'));
            return;
          }
          if (timedOut) {
            reject(new ToolExecutionError(`Command timed out after ${timeoutMs / 1000}s`));
            return;
          }

          const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
          const stderr = Buffer.concat(stderrChunks).toString('utf-8');
          const combined = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '');
          const output = truncated ? combined + '\n[truncated]' : combined;

          if (truncated && killSignal === 'SIGTERM') {
            resolve({
              content: [{ type: 'text', text: output }],
              details: { exitCode: null, truncated: true, killSignal },
            });
            return;
          }

          if (code !== 0) {
            reject(new ToolExecutionError(`Command exited with code ${code}\n${output}`));
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
