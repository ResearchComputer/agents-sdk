import { Type } from '@sinclair/typebox';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { resolvePath, isRealPathAllowed } from './util.js';
import { pathMutex, safeToolError, safePathError } from '../security/index.js';

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
        throw safePathError('write');
      }

      // Also validate the directory we're about to create. Without this,
      // an LLM-supplied path through a symlinked subdirectory can cause
      // fs.mkdir to walk out of the sandbox (the symlink itself is inside;
      // the resolved dirname isn't).
      const dir = path.dirname(absPath);
      if (!(await isRealPathAllowed(dir, cwd, allowedRoots))) {
        throw safePathError('write');
      }

      const release = await pathMutex.acquire(absPath);
      try {
        try {
          await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        } catch (err) {
          throw safeToolError(err, 'io_error');
        }

        // Atomic write: tmp + rename. Prevents partial-content reads during
        // a concurrent read, and guarantees a parallel Write on the same
        // file (serialized by pathMutex above) observes complete states.
        const tmp = absPath + '.tmp.' + process.pid + '.' + Date.now();
        try {
          await fs.writeFile(tmp, params.content, { encoding: 'utf-8', mode: 0o600 });
          await fs.rename(tmp, absPath);
        } catch (err) {
          await fs.unlink(tmp).catch(() => {});
          throw safeToolError(err, 'io_error');
        }

        return {
          content: [
            {
              type: 'text',
              text: `Wrote ${Buffer.byteLength(params.content)} bytes to ${absPath}`,
            },
          ],
          details: { path: absPath, bytes: Buffer.byteLength(params.content) },
        };
      } finally {
        release();
      }
    },
  };
}
