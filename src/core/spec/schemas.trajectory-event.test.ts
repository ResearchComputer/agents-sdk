import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createValidator } from './validator.js';
import { findSpecDir, loadSchema } from '../../node/spec/loader.js';
import { readJsonlStream } from '../../node/spec/jsonl.js';
import { createReadStream } from 'node:fs';

describe('trajectory-event.v1 schema', () => {
  let specDir: string;
  const v = createValidator();

  beforeAll(async () => {
    specDir = await findSpecDir();
    v.register('trajectory-event', '1', await loadSchema('trajectory-event', '1', specDir));
  });

  const ex = async (f: string) =>
    JSON.parse(await fs.readFile(path.join(specDir, 'examples/trajectory-event', f), 'utf-8'));

  it.each([
    'valid-session-start.json',
    'valid-llm-api-call.json',
    'valid-llm-turn.json',
    'valid-agent-message.json',
    'valid-tool-call.json',
    'valid-tool-result.json',
    'valid-permission-decision.json',
    'valid-hook-fire.json',
    'valid-compaction.json',
    'valid-session-end.json',
    'valid-error.json',
  ])('accepts %s', async (file) => {
    const r = v.validate('trajectory-event', '1', await ex(file));
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown event_type', async () => {
    expect(v.validate('trajectory-event', '1', await ex('invalid-unknown-event-type.json')).ok).toBe(false);
  });

  it('rejects tool_result missing its output field', async () => {
    expect(v.validate('trajectory-event', '1', await ex('invalid-tool-result-missing-output.json')).ok).toBe(false);
  });

  it('rejects parent_event_id that is not a ULID or null', async () => {
    expect(v.validate('trajectory-event', '1', await ex('invalid-parent-ulid.json')).ok).toBe(false);
  });

  it('validates every line of the golden trajectory.jsonl fixture', async () => {
    const p = path.join(specDir, 'examples/trajectory-event/valid-trajectory.jsonl');
    const stream = createReadStream(p, { encoding: 'utf-8' });
    let count = 0;
    for await (const record of readJsonlStream(stream)) {
      const r = v.validate('trajectory-event', '1', record);
      expect(r.ok).toBe(true);
      count++;
    }
    expect(count).toBeGreaterThan(0);
  });
});
