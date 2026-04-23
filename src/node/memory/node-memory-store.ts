import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Memory } from '../../core/types.js';
import type { MemoryStore } from '../../core/memory/store.js';

function parseMemoryFile(content: string): Memory | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  const typeMatch = frontmatter.match(/^type:\s*(.+)$/m);

  if (!nameMatch || !descMatch || !typeMatch) return null;

  return {
    name: nameMatch[1].trim(),
    description: descMatch[1].trim(),
    type: typeMatch[1].trim() as Memory['type'],
    content: body,
  };
}

function serializeMemory(memory: Memory): string {
  return `---\nname: ${memory.name}\ndescription: ${memory.description}\ntype: ${memory.type}\n---\n\n${memory.content}\n`;
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function assertSingleLine(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Memory ${field} must not contain newlines: ${JSON.stringify(value)}`);
  }
}

export function createNodeMemoryStore(dir: string): MemoryStore {
  return {
    async load(): Promise<Memory[]> {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return [];
      }
      const mdFiles = entries.filter(e => e.endsWith('.md'));
      // Parallel reads. Kernel/libuv already pipelines async fs calls, so
      // Promise.all is ~N× faster than the serial await loop for N files.
      const contents = await Promise.all(
        mdFiles.map(entry => fs.readFile(path.join(dir, entry), 'utf-8')),
      );
      const memories: Memory[] = [];
      for (const content of contents) {
        const memory = parseMemoryFile(content);
        if (memory) memories.push(memory);
      }
      return memories;
    },
    async save(memory: Memory): Promise<void> {
      assertSingleLine('name', memory.name);
      assertSingleLine('description', memory.description);
      assertSingleLine('type', memory.type);
      await fs.mkdir(dir, { recursive: true });
      const filename = sanitizeFilename(memory.name) + '.md';
      const filePath = path.join(dir, filename);
      const tmpPath = `${filePath}.tmp`;
      await fs.writeFile(tmpPath, serializeMemory(memory), 'utf-8');
      await fs.rename(tmpPath, filePath);
    },
    async remove(name: string): Promise<void> {
      const filename = sanitizeFilename(name) + '.md';
      try {
        await fs.unlink(path.join(dir, filename));
      } catch {
        // ignore if file doesn't exist
      }
    },
  };
}
