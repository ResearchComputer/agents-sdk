import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readNodeTrajectoryFile } from './reader.js';

describe('readNodeTrajectoryFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] when the trajectory file does not exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'traj-reader-'));
    const events = await readNodeTrajectoryFile(tmp, '01J9ZSZABCDEFGHJKMNPQRSTVW');
    expect(events).toEqual([]);
  });

  it('parses newline-delimited JSON events', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'traj-reader-'));
    const id = '01J9ZSZABCDEFGHJKMNPQRSTVW';
    const filePath = path.join(tmp, `${id}.trajectory.jsonl`);
    const e1 = { schema_version: '1', trajectory_id: id, event_id: 'a', event_type: 'x', payload: {} };
    const e2 = { schema_version: '1', trajectory_id: id, event_id: 'b', event_type: 'y', payload: {} };
    await fs.writeFile(filePath, JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n', 'utf-8');

    const events = await readNodeTrajectoryFile(tmp, id);
    expect(events).toHaveLength(2);
    expect(events[0].event_id).toBe('a');
    expect(events[1].event_id).toBe('b');
  });

  it('skips malformed lines with a console.warn and keeps parseable ones', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'traj-reader-'));
    const id = '01J9ZSZABCDEFGHJKMNPQRSTVW';
    const filePath = path.join(tmp, `${id}.trajectory.jsonl`);
    const good = { schema_version: '1', trajectory_id: id, event_id: 'a', event_type: 'x', payload: {} };
    await fs.writeFile(filePath, `${JSON.stringify(good)}\n{{{ not json\n\n`, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events = await readNodeTrajectoryFile(tmp, id);
    expect(events).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('rethrows non-ENOENT filesystem errors', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'traj-reader-'));
    const id = '01J9ZSZABCDEFGHJKMNPQRSTVW';
    // A directory in place of a file triggers EISDIR (not ENOENT).
    await fs.mkdir(path.join(tmp, `${id}.trajectory.jsonl`));
    await expect(readNodeTrajectoryFile(tmp, id)).rejects.toThrow();
  });
});
