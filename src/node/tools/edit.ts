import { Type } from '@sinclair/typebox';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';
import { resolvePath, isRealPathAllowed, isBinaryContent } from './util.js';
import { pathMutex, safeToolError, safePathError, safeInvalidInputError } from '../security/index.js';

const EditParams = Type.Object({
  file_path: Type.String(),
  old_string: Type.String(),
  new_string: Type.String(),
  replace_all: Type.Optional(Type.Boolean()),
});

/**
 * Reject strings containing unpaired UTF-16 surrogates. Node's utf-8
 * encoder will silently replace lone surrogates with U+FFFD, corrupting
 * the file round-trip. Refuse the edit instead.
 */
function hasLoneSurrogate(s: string): boolean {
  // High surrogate not followed by low surrogate, OR low surrogate not
  // preceded by a high surrogate.
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

export function createEditTool(options?: ToolOptions): SdkTool<typeof EditParams> {
  const cwd = options?.cwd ?? process.cwd();
  const allowedRoots = options?.allowedRoots ?? [];

  return {
    name: 'Edit',
    label: 'Edit file with string replacement',
    description: 'Performs exact string replacements in files.',
    parameters: EditParams,
    capabilities: ['fs:write'],
    async execute(_toolCallId, params) {
      const absPath = resolvePath(params.file_path, cwd);

      if (!(await isRealPathAllowed(absPath, cwd, allowedRoots))) {
        throw safePathError('edit');
      }

      // NFC-normalize the inputs and reject lone surrogates. Without this,
      // a pair-splitting old_string or a lone-surrogate new_string round-
      // trips through fs writeFile as U+FFFD and silently corrupts the file.
      const oldStr = params.old_string.normalize('NFC');
      const newStr = params.new_string.normalize('NFC');
      if (hasLoneSurrogate(oldStr) || hasLoneSurrogate(newStr)) {
        throw safeInvalidInputError('string contains lone surrogates');
      }

      // Acquire the per-path mutex spanning read + write so a concurrent
      // Edit/Write on the same file cannot interleave. Without this, two
      // parallel Edits read the same content, apply against stale state,
      // and the second writeFile wins — the first edit is silently lost.
      const release = await pathMutex.acquire(absPath);
      try {
        let contentBuf: Buffer;
        try {
          contentBuf = await fs.readFile(absPath);
        } catch (err) {
          throw safeToolError(err, 'io_error');
        }

        // Binary files silently mojibake through fs.readFile/writeFile with
        // utf-8 encoding — refuse. This repo's own core.wasm is a real
        // example of a file an LLM could be prompt-injected into "editing."
        if (isBinaryContent(contentBuf)) {
          throw new ToolExecutionError('[binary_file] refusing to edit binary file');
        }

        const content = contentBuf.toString('utf-8').normalize('NFC');
        const replaceAll = params.replace_all ?? false;

        // Overlap-aware scan: advance by 1 (not old_string.length) so
        // overlapping matches like 'aa' in 'aaa' are counted correctly.
        // This matters for replace_all=false — the previous jump-ahead
        // implementation could miss an overlapping second occurrence and
        // silently apply to the wrong spot.
        const matches: number[] = [];
        let pos = 0;
        while (pos <= content.length) {
          const idx = content.indexOf(oldStr, pos);
          if (idx === -1) break;
          matches.push(idx);
          if (!replaceAll && matches.length > 1) break;
          pos = idx + 1;
        }

        if (matches.length === 0) {
          throw new ToolExecutionError('[not_found] old_string not found');
        }
        if (!replaceAll && matches.length > 1) {
          throw safeInvalidInputError('multiple matches; use replace_all');
        }

        let newContent: string;
        let count: number;
        if (replaceAll) {
          // Use split/join (non-overlapping replace — standard JS
          // semantics). count is the number of splits.
          newContent = content.split(oldStr).join(newStr);
          count = matches.length;
        } else {
          const idx = matches[0];
          newContent = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
          count = 1;
        }

        // Atomic write: write to .tmp in the same directory (so rename is
        // a same-filesystem op) and then rename over the original. A crash
        // or a concurrent reader between read and rename never observes a
        // partial file.
        const tmp = absPath + '.tmp.' + process.pid + '.' + Date.now();
        try {
          await fs.writeFile(tmp, newContent, { encoding: 'utf-8', mode: 0o600 });
          await fs.rename(tmp, absPath);
        } catch (err) {
          // Clean up the tmp file on rename failure so we don't leak.
          await fs.unlink(tmp).catch(() => {});
          throw safeToolError(err, 'io_error');
        }

        return {
          content: [
            {
              type: 'text',
              text: `Edited ${absPath} (${count} replacement${count > 1 ? 's' : ''})`,
            },
          ],
          details: { path: absPath, replacements: count },
        };
      } finally {
        release();
      }
    },
  };
}

// Re-export for tests that want to use the mutex directly.
export { pathMutex } from '../security/index.js';

// Unused import suppressor — `path` is imported for future dirname checks.
void path;
