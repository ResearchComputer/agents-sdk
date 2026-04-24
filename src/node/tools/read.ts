import { Type } from '@sinclair/typebox';
import fs from 'node:fs/promises';
import fsConstants from 'node:fs';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { resolvePath, isRealPathAllowed } from './util.js';
import { safePathError, safeToolError } from '../security/index.js';

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
        throw safePathError('read');
      }

      // Open with O_NOFOLLOW on Linux/macOS so a symlink swap between
      // the isRealPathAllowed check and the open (a real TOCTOU window
      // because the check resolves via fs.realpath and the read
      // reopens by string) cannot escape the sandbox. If the final path
      // component became a symlink after the check, open() fails with
      // ELOOP which safeToolError maps to permission_denied.
      // Windows has no O_NOFOLLOW; fall back to plain readFile there.
      let content: string;
      try {
        if (process.platform === 'win32') {
          content = await fs.readFile(absPath, 'utf-8');
        } else {
          const flags = fsConstants.constants.O_RDONLY | fsConstants.constants.O_NOFOLLOW;
          const handle = await fs.open(absPath, flags);
          try {
            const buf = await handle.readFile();
            content = buf.toString('utf-8');
          } finally {
            await handle.close();
          }
        }
      } catch (err) {
        throw safeToolError(err, 'io_error');
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
