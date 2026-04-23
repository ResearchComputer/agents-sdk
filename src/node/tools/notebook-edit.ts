import { Type } from '@sinclair/typebox';
import fs from 'node:fs/promises';
import type { SdkTool, ToolOptions } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';
import { resolvePath, isRealPathAllowed } from './util.js';

const NotebookEditParams = Type.Object({
  file_path: Type.String(),
  cell_index: Type.Number({ minimum: 0 }),
  new_source: Type.String(),
});

export function createNotebookEditTool(options?: ToolOptions): SdkTool<typeof NotebookEditParams> {
  const cwd = options?.cwd ?? process.cwd();
  const allowedRoots = options?.allowedRoots ?? [];

  return {
    name: 'NotebookEdit',
    label: 'Edit Jupyter notebook cell',
    description: 'Edits a cell in a Jupyter notebook (.ipynb) file.',
    parameters: NotebookEditParams,
    capabilities: ['fs:write'],
    async execute(_toolCallId, params) {
      const absPath = resolvePath(params.file_path, cwd);

      if (!(await isRealPathAllowed(absPath, cwd, allowedRoots))) {
        throw new ToolExecutionError(`Path not allowed: ${params.file_path}`);
      }

      let raw: string;
      try {
        raw = await fs.readFile(absPath, 'utf-8');
      } catch (err: any) {
        throw new ToolExecutionError(`Failed to read notebook: ${err.message}`);
      }

      let notebook: any;
      try {
        notebook = JSON.parse(raw);
      } catch {
        throw new ToolExecutionError(`Invalid notebook JSON: ${absPath}`);
      }

      const cells = notebook.cells;
      if (!Array.isArray(cells)) {
        throw new ToolExecutionError('Notebook has no cells array');
      }

      if (params.cell_index >= cells.length) {
        throw new ToolExecutionError(
          `Cell index ${params.cell_index} out of range (notebook has ${cells.length} cells)`,
        );
      }

      // Jupyter stores source as array of lines
      cells[params.cell_index].source = params.new_source.split('\n').map(
        (line: string, i: number, arr: string[]) => (i < arr.length - 1 ? line + '\n' : line),
      );

      await fs.writeFile(absPath, JSON.stringify(notebook, null, 1) + '\n', 'utf-8');

      return {
        content: [{ type: 'text', text: `Edited cell ${params.cell_index} in ${absPath}` }],
        details: { path: absPath, cellIndex: params.cell_index },
      };
    },
  };
}
