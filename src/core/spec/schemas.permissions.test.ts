import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createValidator } from './validator.js';
import { findSpecDir, loadSchema } from '../../node/spec/loader.js';

describe('permissions.v1 schema', () => {
  let specDir: string;
  const v = createValidator();

  beforeAll(async () => {
    specDir = await findSpecDir();
    v.register('permissions', '1', await loadSchema('permissions', '1', specDir));
  });

  const ex = async (f: string) =>
    JSON.parse(await fs.readFile(path.join(specDir, 'examples/permissions', f), 'utf-8'));

  it('accepts a rule set with mixed target types', async () => {
    expect(v.validate('permissions', '1', await ex('valid-user-rules.json')).ok).toBe(true);
  });

  it('rejects a target whose type is unknown', async () => {
    expect(v.validate('permissions', '1', await ex('invalid-bad-target-type.json')).ok).toBe(false);
  });
});
