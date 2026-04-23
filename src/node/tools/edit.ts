import { Type } from '@sinclair/typebox';
import fs from 'node:fs/promises';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';
import { resolvePath, isRealPathAllowed } from './util.js';

const EditParams = Type.Object({
  file_path: Type.String(),
  old_string: Type.String(),
  new_string: Type.String(),
  replace_all: Type.Optional(Type.Boolean()),
});

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
        throw new ToolExecutionError(`Path not allowed: ${params.file_path}`);
      }

      let content: string;
      try {
        content = await fs.readFile(absPath, 'utf-8');
      } catch (err: any) {
        throw new ToolExecutionError(`Failed to read file: ${err.message}`);
      }

      const replaceAll = params.replace_all ?? false;

      // Fast path for replace_all=false: we only need to know "no match",
      // "exactly one match", or "more than one match". Stop scanning after
      // finding a second occurrence instead of counting every one.
      const firstIdx = content.indexOf(params.old_string);
      if (firstIdx === -1) {
        throw new ToolExecutionError(`old_string not found in ${params.file_path}`);
      }

      let count: number;
      if (replaceAll) {
        count = 1;
        let searchPos = firstIdx + params.old_string.length;
        while (true) {
          const idx = content.indexOf(params.old_string, searchPos);
          if (idx === -1) break;
          count++;
          searchPos = idx + params.old_string.length;
        }
      } else {
        const secondIdx = content.indexOf(params.old_string, firstIdx + params.old_string.length);
        if (secondIdx !== -1) {
          throw new ToolExecutionError(
            `Multiple matches found for old_string in ${params.file_path}. Use replace_all to replace all occurrences.`,
          );
        }
        count = 1;
      }

      let newContent: string;
      if (replaceAll) {
        newContent = content.split(params.old_string).join(params.new_string);
      } else {
        newContent = content.slice(0, firstIdx) + params.new_string + content.slice(firstIdx + params.old_string.length);
      }

      await fs.writeFile(absPath, newContent, 'utf-8');

      return {
        content: [{ type: 'text', text: `Edited ${absPath} (${count} replacement${count > 1 ? 's' : ''})` }],
        details: { path: absPath, replacements: count },
      };
    },
  };
}
