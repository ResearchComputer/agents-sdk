import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createValidator } from './validator.js';
import { findSpecDir, loadSchema } from '../../node/spec/loader.js';

describe('session.v1 schema', () => {
  let specDir: string;
  const v = createValidator();

  beforeAll(async () => {
    specDir = await findSpecDir();
    v.register('session', '1', await loadSchema('session', '1', specDir));
  });

  const ex = async (f: string) =>
    JSON.parse(await fs.readFile(path.join(specDir, 'examples/session', f), 'utf-8'));

  it('accepts a fresh session (no compaction, no memory_refs)', async () => {
    expect(v.validate('session', '1', await ex('valid-fresh.json')).ok).toBe(true);
  });

  it('accepts a resumable session with compaction_state and memory_refs', async () => {
    expect(v.validate('session', '1', await ex('valid-resumable.json')).ok).toBe(true);
  });

  it('rejects when trajectory_id is missing', async () => {
    expect(v.validate('session', '1', await ex('invalid-missing-trajectory-id.json')).ok).toBe(false);
  });

  it('rejects when system_prompt_hash is not in sha256:hex format', async () => {
    expect(v.validate('session', '1', await ex('invalid-bad-hash-format.json')).ok).toBe(false);
  });
});
