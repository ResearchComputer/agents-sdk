import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createNodeTrajectoryWriter } from './node-trajectory-writer.js';
import { createValidator } from '../../core/spec/validator.js';
import { findSpecDir, loadSchema } from '../spec/loader.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('createNodeTrajectoryWriter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'traj-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exposes a ULID trajectoryId', () => {
    const w = createNodeTrajectoryWriter({ dir });
    expect(w.trajectoryId).toMatch(ULID);
  });

  it('writes a JSONL file at <dir>/<trajectoryId>.trajectory.jsonl on flush', async () => {
    const w = createNodeTrajectoryWriter({ dir });
    w.append({
      event_type: 'session_start',
      payload: makeStartPayload(w.trajectoryId),
    });
    await w.flush();

    const filePath = path.join(dir, `${w.trajectoryId}.trajectory.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.trajectory_id).toBe(w.trajectoryId);
    expect(event.event_type).toBe('session_start');
    expect(event.schema_version).toBe('1');
  });

  it('appends subsequent events across multiple flushes', async () => {
    const w = createNodeTrajectoryWriter({ dir });
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    await w.flush();
    w.append({ event_type: 'agent_message', payload: { role: 'user', content: 'hi' } });
    w.append({ event_type: 'session_end', payload: { session_id: w.trajectoryId, reason: 'complete' } });
    await w.flush();

    const filePath = path.join(dir, `${w.trajectoryId}.trajectory.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event_type).toBe('session_start');
    expect(JSON.parse(lines[1]).event_type).toBe('agent_message');
    expect(JSON.parse(lines[2]).event_type).toBe('session_end');
  });

  it('creates the directory if it does not exist', async () => {
    const nested = path.join(dir, 'nested', 'sessions');
    const w = createNodeTrajectoryWriter({ dir: nested });
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    await w.flush();
    const files = await fs.readdir(nested);
    expect(files).toHaveLength(1);
  });

  it('every emitted event validates against trajectory-event.v1 schema', async () => {
    const v = createValidator();
    const specDir = await findSpecDir();
    v.register('trajectory-event', '1', await loadSchema('trajectory-event', '1', specDir));

    const w = createNodeTrajectoryWriter({ dir });
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    w.append({
      event_type: 'tool_call',
      payload: {
        tool_name: 'Bash',
        tool_call_id: 'call-1',
        args: { command: 'ls' },
        capabilities: ['process:spawn'],
      },
    });
    w.append({
      event_type: 'tool_result',
      payload: {
        tool_call_id: 'call-1',
        duration_ms: 42,
        success: true,
        output: 'files...',
      },
    });
    w.append({
      event_type: 'permission_decision',
      payload: {
        tool_name: 'Bash',
        args: { command: 'ls' },
        behavior: 'allow',
        normalized_target: 'Bash',
      },
    });
    w.append({ event_type: 'session_end', payload: { session_id: w.trajectoryId, reason: 'complete' } });
    await w.flush();

    const filePath = path.join(dir, `${w.trajectoryId}.trajectory.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    for (const line of lines) {
      const parsed = JSON.parse(line);
      const result = v.validate('trajectory-event', '1', parsed);
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error('Validation failed for', parsed.event_type, (result.error.details as any)?.errors);
      }
      expect(result.ok).toBe(true);
    }
  });

  it('close() flushes and prevents further appends', async () => {
    const w = createNodeTrajectoryWriter({ dir });
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    await w.close();
    expect(() =>
      w.append({ event_type: 'session_end', payload: { session_id: w.trajectoryId, reason: 'complete' } }),
    ).toThrow(/closed/);
    const filePath = path.join(dir, `${w.trajectoryId}.trajectory.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(1);
  });

  it('read() yields all flushed + pending events in order', async () => {
    const w = createNodeTrajectoryWriter({ dir });
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    await w.flush();
    w.append({ event_type: 'agent_message', payload: { role: 'user', content: 'hi' } });
    // read before flush: should still see both (pending included)
    const ids: string[] = [];
    for await (const e of w.read()) ids.push(e.event_type);
    expect(ids).toEqual(['session_start', 'agent_message']);
  });

  it('read({sinceEventId}) skips up to and including the given id', async () => {
    const w = createNodeTrajectoryWriter({ dir });
    const a = w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    w.append({ event_type: 'agent_message', payload: { role: 'user', content: 'hi' } });
    await w.flush();
    const types: string[] = [];
    for await (const e of w.read({ sinceEventId: a })) types.push(e.event_type);
    expect(types).toEqual(['agent_message']);
  });

  it('rejects a malformed explicit trajectoryId', () => {
    expect(() => createNodeTrajectoryWriter({ dir, trajectoryId: 'not-a-ulid' })).toThrow(/ULID/);
  });

  it('close() is idempotent', async () => {
    const w = createNodeTrajectoryWriter({ dir });
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    await w.close();
    await expect(w.close()).resolves.toBeUndefined();
  });

  it('events() returns flushed and pending events combined', async () => {
    const w = createNodeTrajectoryWriter({ dir });
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    await w.flush();
    w.append({ event_type: 'agent_message', payload: { role: 'user', content: 'pending' } });
    const types = w.events().map((e) => e.event_type);
    expect(types).toEqual(['session_start', 'agent_message']);
  });

  it('serializes concurrent flush() calls (no lost writes)', async () => {
    const w = createNodeTrajectoryWriter({ dir });
    for (let i = 0; i < 10; i++) {
      w.append({ event_type: 'agent_message', payload: { role: 'user', content: `msg-${i}` } });
    }
    await Promise.all([w.flush(), w.flush(), w.flush()]);

    const filePath = path.join(dir, `${w.trajectoryId}.trajectory.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(10);
  });
});

function makeStartPayload(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    model_id: 'gpt-4o',
    provider_name: 'openai',
    system_prompt_hash: 'sha256:' + '0'.repeat(64),
    memory_refs: [],
  };
}
