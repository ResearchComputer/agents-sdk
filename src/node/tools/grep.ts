import { Type } from '@sinclair/typebox';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { isRealPathAllowed, truncateOutput } from './util.js';
import { safeInvalidInputError } from '../security/index.js';

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
      // Pattern injection protection: `params.pattern` is safe because we
      // always pass it after `--` (see rg/grep argv below). `params.glob`
      // historically used `--glob VALUE` (two args) which could have let
      // a glob value like `--pre=/bin/sh` be parsed as a new rg flag —
      // a known RCE vector (rg --pre runs an arbitrary preprocessor).
      // Fused-form `--glob=VALUE` / `--include=VALUE` below ties the
      // value to the flag syntactically, so no separate injection check
      // is needed. A dash-prefixed glob is still disallowed as a
      // belt-and-suspenders measure against future rg flag additions.
      if (params.glob && params.glob.startsWith('-')) {
        throw safeInvalidInputError('glob must not start with dash');
      }

      const searchPath = params.path ? path.resolve(cwd, params.path) : cwd;

      if (!(await isRealPathAllowed(searchPath, cwd, allowedRoots))) {
        return {
          content: [{ type: 'text', text: `Error: path "${params.path}" is outside the allowed directory` }],
          details: { error: 'path_not_allowed' },
        };
      }
      let output: string;

      try {
        // Try ripgrep first. rg does NOT follow symlinks by default
        // (--follow/-L is required to opt in), so a sandbox-internal
        // symlink to /etc/passwd won't leak. Fused --glob=VALUE prevents
        // rg from interpreting the glob value as another flag.
        const rgArgs = ['-n'];
        if (params.glob) {
          rgArgs.push('--glob=' + params.glob);
        }
        rgArgs.push('--', params.pattern, searchPath);
        output = await runCommand('rg', rgArgs, cwd);
      } catch {
        // Fall back to grep. GNU grep -r does NOT follow symlinks
        // (only -R / --dereference-recursive does). `-s` suppresses
        // "permission denied" errors on unreadable files.
        // Fused --include=VALUE prevents the glob value from being
        // parsed as a separate flag.
        try {
          const grepArgs = ['-rns'];
          if (params.glob) {
            grepArgs.push('--include=' + params.glob);
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
