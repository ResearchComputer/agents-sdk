import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createValidator } from './validator.js';
import { findSpecDir, loadSchema } from '../../node/spec/loader.js';

describe('mcp-server.v1 schema', () => {
  let specDir: string;
  const v = createValidator();

  beforeAll(async () => {
    specDir = await findSpecDir();
    v.register('mcp-server', '1', await loadSchema('mcp-server', '1', specDir));
  });

  const ex = async (f: string) =>
    JSON.parse(await fs.readFile(path.join(specDir, 'examples/mcp-server', f), 'utf-8'));

  it('accepts a single stdio server config', async () => {
    expect(v.validate('mcp-server', '1', await ex('valid-stdio.json')).ok).toBe(true);
  });

  it('accepts multiple http servers', async () => {
    expect(v.validate('mcp-server', '1', await ex('valid-http-multiple.json')).ok).toBe(true);
  });

  it('rejects an unknown transport', async () => {
    expect(v.validate('mcp-server', '1', await ex('invalid-unknown-transport.json')).ok).toBe(false);
  });
});
