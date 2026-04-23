import { Type } from '@sinclair/typebox';
import fs from 'node:fs/promises';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';
import { resolvePath, isRealPathAllowed } from './util.js';

const ReadParams = Type.Object({
  file_path: Type.String(),
  offset: Type.Optional(Type.Number({ minimum: 1 })),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
});

export function createReadTool(options?: ToolOptions): SdkTool<typeof ReadParams> {
  const cwd = options?.cwd ?? process.cwd();
  const allowedRoots = options?.allowedRoots ?? [];

  return {
    name: 'Read',
    label: 'Read file contents',
    description: 'Reads a file from the filesystem with line numbers.',
    parameters: ReadParams,
    capabilities: ['fs:read'],
    async execute(_toolCallId, params) {
      const absPath = resolvePath(params.file_path, cwd);

      if (!(await isRealPathAllowed(absPath, cwd, allowedRoots))) {
        throw new ToolExecutionError(`Path not allowed: ${params.file_path}`);
      }

      let content: string;
      try {
        content = await fs.readFile(absPath, 'utf-8');
      } catch (err: any) {
        throw new ToolExecutionError(`Failed to read file: ${err.message}`);
      }

      let lines = content.split('\n');
      // Remove trailing empty line from trailing newline
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }

      const offset = params.offset ?? 1;
      const startIndex = offset - 1;
      const endIndex = params.limit != null ? startIndex + params.limit : lines.length;
      lines = lines.slice(startIndex, endIndex);

      const numbered = lines.map((line, i) => `${startIndex + i + 1}\t${line}`).join('\n');

      return {
        content: [{ type: 'text', text: numbered }],
        details: { path: absPath, lineCount: lines.length },
      };
    },
  };
}
