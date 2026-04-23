import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAllTools } from './index.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';
import { createNotebookEditTool } from './notebook-edit.js';
import { createAskUserTool } from './ask-user.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('getAllTools', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all 10 built-in tools', () => {
    const tools = getAllTools({ cwd: tmpDir });
    expect(tools).toHaveLength(10);
    const names = tools.map(t => t.name);
    expect(names).toContain('Read');
    expect(names).toContain('Write');
    expect(names).toContain('Edit');
    expect(names).toContain('Bash');
    expect(names).toContain('Glob');
    expect(names).toContain('Grep');
    expect(names).toContain('WebFetch');
    expect(names).toContain('WebSearch');
    expect(names).toContain('NotebookEdit');
    expect(names).toContain('AskUser');
  });

  it('each tool has capabilities array', () => {
    const tools = getAllTools({ cwd: tmpDir });
    for (const tool of tools) {
      expect(Array.isArray(tool.capabilities)).toBe(true);
    }
  });
});

describe('createWebSearchTool', () => {
  it('throws ToolExecutionError when not configured', async () => {
    const tool = createWebSearchTool();
    await expect(tool.execute('call1', { query: 'test' })).rejects.toThrow(/not configured/);
  });
});

describe('createNotebookEditTool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('edits a notebook cell', async () => {
    const notebook = {
      cells: [
        { cell_type: 'code', source: ['print("hello")\n'], metadata: {}, outputs: [] },
        { cell_type: 'code', source: ['x = 1\n'], metadata: {}, outputs: [] },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    const filePath = path.join(tmpDir, 'test.ipynb');
    fs.writeFileSync(filePath, JSON.stringify(notebook));
    const tool = createNotebookEditTool({ cwd: tmpDir });
    await tool.execute('call1', { file_path: filePath, cell_index: 0, new_source: 'print("world")' });
    const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(updated.cells[0].source).toEqual(['print("world")']);
  });

  it('throws for out-of-range cell index', async () => {
    const notebook = { cells: [{ cell_type: 'code', source: [], metadata: {}, outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    const filePath = path.join(tmpDir, 'test.ipynb');
    fs.writeFileSync(filePath, JSON.stringify(notebook));
    const tool = createNotebookEditTool({ cwd: tmpDir });
    await expect(tool.execute('call1', { file_path: filePath, cell_index: 5, new_source: 'x' }))
      .rejects.toThrow(/out of range/i);
  });

  it('throws for path outside cwd', async () => {
    const tool = createNotebookEditTool({ cwd: tmpDir });
    await expect(tool.execute('call1', { file_path: '/etc/test.ipynb', cell_index: 0, new_source: 'x' }))
      .rejects.toThrow(/not allowed/i);
  });
});

describe('createAskUserTool', () => {
  it('calls onQuestion callback', async () => {
    const tool = createAskUserTool({
      onQuestion: async (q) => `Answer to: ${q}`,
    });
    const result = await tool.execute('call1', { question: 'What is 2+2?' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe('Answer to: What is 2+2?');
  });

  it('returns fallback when no callback', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute('call1', { question: 'test' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('not available');
  });
});
