import { describe, it, expect } from 'vitest';
import { newUlid, isUlid, nowIso } from './ids.js';

describe('ids', () => {
  it('generates a 26-character ULID', () => {
    const id = newUlid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it('generates lexicographically increasing ULIDs over time', async () => {
    const a = newUlid();
    await new Promise(r => setTimeout(r, 2));
    const b = newUlid();
    expect(b > a).toBe(true);
  });

  it('rejects non-ULID strings', () => {
    expect(isUlid('not-a-ulid')).toBe(false);
    expect(isUlid('')).toBe(false);
    expect(isUlid('01J'.repeat(20))).toBe(false);
  });

  it('produces RFC3339 timestamps with millisecond precision in UTC', () => {
    const ts = nowIso();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
