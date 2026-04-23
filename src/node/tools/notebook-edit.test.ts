import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createNotebookEditTool } from './notebook-edit.js';

describe('createNotebookEditTool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbedit-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('declares correct metadata', () => {
    const tool = createNotebookEditTool({ cwd: tmpDir });
    expect(tool.name).toBe('NotebookEdit');
    expect(tool.capabilities).toEqual(['fs:write']);
  });

  it('edits a cell source and persists as line-array', async () => {
    const file = path.join(tmpDir, 'nb.ipynb');
    const notebook = {
      cells: [
        { cell_type: 'code', source: ['print(1)\n'] },
        { cell_type: 'code', source: ['print(2)\n'] },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    fs.writeFileSync(file, JSON.stringify(notebook));

    const tool = createNotebookEditTool({ cwd: tmpDir });
    const result = await tool.execute('c1', {
      file_path: file,
      cell_index: 1,
      new_source: 'print(3)\nprint(4)',
    });

    const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(written.cells[1].source).toEqual(['print(3)\n', 'print(4)']);
    expect(result.details).toMatchObject({ cellIndex: 1 });
  });

  it('rejects paths outside cwd', async () => {
    const tool = createNotebookEditTool({ cwd: tmpDir });
    await expect(
      tool.execute('c1', {
        file_path: '/etc/passwd.ipynb',
        cell_index: 0,
        new_source: 'x',
      }),
    ).rejects.toThrow(/not allowed/i);
  });

  it('throws when the file does not exist', async () => {
    const tool = createNotebookEditTool({ cwd: tmpDir });
    await expect(
      tool.execute('c1', {
        file_path: path.join(tmpDir, 'missing.ipynb'),
        cell_index: 0,
        new_source: 'x',
      }),
    ).rejects.toThrow(/Failed to read notebook/);
  });

  it('throws when the notebook JSON is invalid', async () => {
    const file = path.join(tmpDir, 'bad.ipynb');
    fs.writeFileSync(file, '{ not valid json');
    const tool = createNotebookEditTool({ cwd: tmpDir });
    await expect(
      tool.execute('c1', { file_path: file, cell_index: 0, new_source: 'x' }),
    ).rejects.toThrow(/Invalid notebook JSON/);
  });

  it('throws when the notebook has no cells array', async () => {
    const file = path.join(tmpDir, 'nocells.ipynb');
    fs.writeFileSync(file, JSON.stringify({ metadata: {} }));
    const tool = createNotebookEditTool({ cwd: tmpDir });
    await expect(
      tool.execute('c1', { file_path: file, cell_index: 0, new_source: 'x' }),
    ).rejects.toThrow(/no cells array/);
  });

  it('throws when cell_index is out of range', async () => {
    const file = path.join(tmpDir, 'small.ipynb');
    fs.writeFileSync(
      file,
      JSON.stringify({ cells: [{ cell_type: 'code', source: ['a'] }] }),
    );
    const tool = createNotebookEditTool({ cwd: tmpDir });
    await expect(
      tool.execute('c1', { file_path: file, cell_index: 5, new_source: 'x' }),
    ).rejects.toThrow(/out of range/);
  });
});
