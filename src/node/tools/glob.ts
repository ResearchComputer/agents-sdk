import { Type } from '@sinclair/typebox';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { isRealPathAllowed } from './util.js';

// node:fs/promises only exports `glob` in Node 22+; provide a fallback for Node 20.
async function* nodeGlob(pattern: string, options: { cwd: string }): AsyncIterable<string> {
  const fsAny = fs as unknown as Record<string, unknown>;
  if (typeof fsAny['glob'] === 'function') {
    yield* (fsAny['glob'] as (p: string, o: { cwd: string }) => AsyncIterable<string>)(
      pattern,
      options,
    );
    return;
  }

  // Fallback for Node 20: recursive readdir + simple glob-to-regex conversion.
  //
  // Crucial detail: skip symlinks on traversal. A symlink inside the
  // sandbox pointing to /etc or another user's $HOME must NOT expand
  // results outside the allowed root. Dirent.isDirectory() follows the
  // link for entries from readdir withFileTypes, so we explicitly check
  // isSymbolicLink() first and drop the entry.
  async function* walk(dir: string, base: string): AsyncIterable<string> {
    let items: import('node:fs').Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const rel = base ? `${base}/${item.name}` : item.name;
      if (item.isDirectory()) {
        yield* walk(path.join(dir, item.name), rel);
      } else if (item.isFile()) {
        yield rel;
      }
    }
  }

  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0GLOBSTAR\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0GLOBSTAR\0/g, '.*');
  const regex = new RegExp(`^${regexStr}$`);

  for await (const entry of walk(options.cwd, '')) {
    if (regex.test(entry)) yield entry;
  }
}

const GlobParams = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
});

export function createGlobTool(options?: ToolOptions): SdkTool<typeof GlobParams> {
  const cwd = options?.cwd ?? process.cwd();
  const allowedRoots = options?.allowedRoots ?? [];

  return {
    name: 'Glob',
    label: 'Find files by pattern',
    description: 'Fast file pattern matching using glob patterns.',
    parameters: GlobParams,
    capabilities: ['fs:read'],
    async execute(_toolCallId, params) {
      const searchDir = params.path ? path.resolve(cwd, params.path) : cwd;

      if (!(await isRealPathAllowed(searchDir, cwd, allowedRoots))) {
        return {
          content: [{ type: 'text', text: `Error: path "${params.path}" is outside the allowed directory` }],
          details: { error: 'path_not_allowed' },
        };
      }
      const results: string[] = [];

      try {
        for await (const entry of nodeGlob(params.pattern, { cwd: searchDir })) {
          results.push(entry);
        }
      } catch {
        // Fallback: no results
      }

      results.sort();

      return {
        content: [{ type: 'text', text: results.join('\n') }],
        details: { count: results.length },
      };
    },
  };
}
