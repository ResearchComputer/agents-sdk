import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createValidator } from './validator.js';
import { findSpecDir, loadSchema } from '../../node/spec/loader.js';

const HOOKS: { name: string; validFile: string }[] = [
  { name: 'hook-pre-tool-use', validFile: 'valid-read.json' },
  { name: 'hook-post-tool-use', validFile: 'valid-read.json' },
  { name: 'hook-session-start', validFile: 'valid.json' },
  { name: 'hook-session-end', validFile: 'valid.json' },
  { name: 'hook-stop', validFile: 'valid.json' },
  { name: 'hook-pre-compact', validFile: 'valid.json' },
  { name: 'hook-post-compact', validFile: 'valid.json' },
  { name: 'hook-subagent-start', validFile: 'valid.json' },
  { name: 'hook-subagent-stop', validFile: 'valid.json' },
];

describe('hook payload schemas', () => {
  let specDir: string;
  const v = createValidator();

  beforeAll(async () => {
    specDir = await findSpecDir();
    for (const h of HOOKS) {
      v.register(h.name, '1', await loadSchema(h.name, '1', specDir));
    }
  });

  const ex = async (record: string, f: string) =>
    JSON.parse(await fs.readFile(path.join(specDir, 'examples', record, f), 'utf-8'));

  for (const h of HOOKS) {
    it(`${h.name} accepts its valid example`, async () => {
      expect(v.validate(h.name, '1', await ex(h.name, h.validFile)).ok).toBe(true);
    });

    it(`${h.name} rejects its invalid example (missing session_id)`, async () => {
      expect(v.validate(h.name, '1', await ex(h.name, 'invalid-missing-session-id.json')).ok).toBe(false);
    });
  }
});
