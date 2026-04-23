import { Type } from '@sinclair/typebox';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { isRealPathAllowed, truncateOutput } from './util.js';

const MAX_OUTPUT = 100 * 1024; // 100KB

const GrepParams = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
});

function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: MAX_OUTPUT * 2 }, (error, stdout) => {
      if (error) {
        // grep/rg exit 1 means no matches, which is not an error
        if ((error as any).code === 1) {
          resolve('');
          return;
        }
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export function createGrepTool(options?: ToolOptions): SdkTool<typeof GrepParams> {
  const cwd = options?.cwd ?? process.cwd();
  const allowedRoots = options?.allowedRoots ?? [];

  return {
    name: 'Grep',
    label: 'Search file contents',
    description: 'Search for patterns in files using ripgrep or grep.',
    parameters: GrepParams,
    capabilities: ['fs:read'],
    async execute(_toolCallId, params) {
      const searchPath = params.path ? path.resolve(cwd, params.path) : cwd;

      if (!(await isRealPathAllowed(searchPath, cwd, allowedRoots))) {
        return {
          content: [{ type: 'text', text: `Error: path "${params.path}" is outside the allowed directory` }],
          details: { error: 'path_not_allowed' },
        };
      }
      let output: string;

      try {
        // Try ripgrep first
        const rgArgs = ['-n'];
        if (params.glob) {
          rgArgs.push('--glob', params.glob);
        }
        rgArgs.push('--', params.pattern, searchPath);
        output = await runCommand('rg', rgArgs, cwd);
      } catch {
        // Fall back to grep
        try {
          const grepArgs = ['-rn'];
          if (params.glob) {
            grepArgs.push('--include', params.glob);
          }
          grepArgs.push('--', params.pattern, searchPath);
          output = await runCommand('grep', grepArgs, cwd);
        } catch {
          output = '';
        }
      }

      output = truncateOutput(output, MAX_OUTPUT);

      return {
        content: [{ type: 'text', text: output }],
        details: { pattern: params.pattern },
      };
    },
  };
}
