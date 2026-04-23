import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createValidator } from './validator.js';
import { findSpecDir, loadSchema } from '../../node/spec/loader.js';

async function readJson(specDir: string, rel: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(specDir, rel), 'utf-8'));
}

describe('memory.v1 schema', () => {
  let specDir: string;
  let validator = createValidator();

  beforeAll(async () => {
    specDir = await findSpecDir();
    const schema = await loadSchema('memory', '1', specDir);
    validator.register('memory', '1', schema);
  });

  it('accepts a valid user memory', async () => {
    const data = await readJson(specDir, 'examples/memory/valid-user.json');
    const r = validator.validate('memory', '1', data);
    expect(r.ok).toBe(true);
  });

  it('accepts a feedback memory with ext fields', async () => {
    const data = await readJson(specDir, 'examples/memory/valid-feedback-with-ext.json');
    const r = validator.validate('memory', '1', data);
    expect(r.ok).toBe(true);
  });

  it('rejects a memory missing `type`', async () => {
    const data = await readJson(specDir, 'examples/memory/invalid-missing-type.json');
    const r = validator.validate('memory', '1', data);
    expect(r.ok).toBe(false);
  });

  it('rejects a memory with an invalid type value', async () => {
    const data = await readJson(specDir, 'examples/memory/invalid-bad-type.json');
    const r = validator.validate('memory', '1', data);
    expect(r.ok).toBe(false);
  });
});
