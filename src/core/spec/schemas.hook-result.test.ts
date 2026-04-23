import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createValidator } from './validator.js';
import { findSpecDir, loadSchema } from '../../node/spec/loader.js';

describe('hook-result.v1', () => {
  let specDir: string;
  const v = createValidator();

  beforeAll(async () => {
    specDir = await findSpecDir();
    v.register('hook-result', '1', await loadSchema('hook-result', '1', specDir));
  });

  const ex = async (f: string) =>
    JSON.parse(await fs.readFile(path.join(specDir, 'examples/hook-result', f), 'utf-8'));

  it('accepts an empty result (no updates)', async () => {
    expect(v.validate('hook-result', '1', await ex('valid-empty.json')).ok).toBe(true);
  });

  it('accepts a result with updated_args', async () => {
    expect(v.validate('hook-result', '1', await ex('valid-updated-args.json')).ok).toBe(true);
  });

  it('rejects extra top-level fields', async () => {
    expect(v.validate('hook-result', '1', await ex('invalid-extra-field.json')).ok).toBe(false);
  });
});
