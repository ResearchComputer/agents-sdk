import { Type } from '@sinclair/typebox';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';
import { resolvePath, isRealPathAllowed } from './util.js';

const WriteParams = Type.Object({
  file_path: Type.String(),
  content: Type.String(),
});

export function createWriteTool(options?: ToolOptions): SdkTool<typeof WriteParams> {
  const cwd = options?.cwd ?? process.cwd();
  const allowedRoots = options?.allowedRoots ?? [];

  return {
    name: 'Write',
    label: 'Write file contents',
    description: 'Writes content to a file, creating intermediate directories as needed.',
    parameters: WriteParams,
    capabilities: ['fs:write'],
    async execute(_toolCallId, params) {
      const absPath = resolvePath(params.file_path, cwd);

      if (!(await isRealPathAllowed(absPath, cwd, allowedRoots))) {
        throw new ToolExecutionError(`Path not allowed: ${params.file_path}`);
      }

      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, params.content, 'utf-8');

      return {
        content: [{ type: 'text', text: `Wrote ${Buffer.byteLength(params.content)} bytes to ${absPath}` }],
        details: { path: absPath, bytes: Buffer.byteLength(params.content) },
      };
    },
  };
}
