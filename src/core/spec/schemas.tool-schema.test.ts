import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createValidator } from './validator.js';
import { findSpecDir, loadSchema } from '../../node/spec/loader.js';

describe('tool-schema.v1', () => {
  let specDir: string;
  const v = createValidator();

  beforeAll(async () => {
    specDir = await findSpecDir();
    v.register('tool-schema', '1', await loadSchema('tool-schema', '1', specDir));
  });

  const ex = async (f: string) =>
    JSON.parse(await fs.readFile(path.join(specDir, 'examples/tool-schema', f), 'utf-8'));

  it('accepts a simple tool schema with x-capabilities', async () => {
    expect(v.validate('tool-schema', '1', await ex('valid-simple-tool.json')).ok).toBe(true);
  });

  it('rejects when x-capabilities is missing', async () => {
    expect(v.validate('tool-schema', '1', await ex('invalid-no-x-capabilities.json')).ok).toBe(false);
  });
});
