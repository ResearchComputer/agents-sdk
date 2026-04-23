import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSchema, findSpecDir } from './loader.js';

describe('loader', () => {
  it('finds the repo docs/spec/ directory by walking up from a source file', async () => {
    const dir = await findSpecDir();
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
    const schemasDir = await fs.stat(path.join(dir, 'schemas'));
    expect(schemasDir.isDirectory()).toBe(true);
  });

  it('loads a schema file by record name and version', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-loader-'));
    const schemasDir = path.join(tmp, 'schemas');
    await fs.mkdir(schemasDir, { recursive: true });
    const fixture = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' };
    await fs.writeFile(path.join(schemasDir, 'thing.v1.schema.json'), JSON.stringify(fixture));
    const schema = await loadSchema('thing', '1', tmp);
    expect(schema).toEqual(fixture);
  });

  it('throws a descriptive error when the schema file is missing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-loader-'));
    await expect(loadSchema('missing', '1', tmp)).rejects.toThrow(/missing\.v1\.schema\.json/);
  });

  it('rethrows non-ENOENT filesystem errors when reading a schema', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-loader-'));
    const schemasDir = path.join(tmp, 'schemas');
    await fs.mkdir(schemasDir, { recursive: true });
    // A directory in place of a file triggers EISDIR (not ENOENT) on readFile.
    await fs.mkdir(path.join(schemasDir, 'weird.v1.schema.json'));
    await expect(loadSchema('weird', '1', tmp)).rejects.toThrow(/EISDIR|illegal|directory/i);
  });

  it('throws when no docs/spec/ directory is found by walking up', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-loader-nospec-'));
    const deep = path.join(tmp, 'a', 'b');
    await fs.mkdir(deep, { recursive: true });
    await expect(findSpecDir(deep)).rejects.toThrow(/locate docs\/spec/);
  });
});
