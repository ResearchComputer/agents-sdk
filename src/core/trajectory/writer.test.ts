import { describe, it, expect } from 'vitest';
import { createInMemoryTrajectoryWriter, type TrajectoryEvent } from './writer.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('createInMemoryTrajectoryWriter', () => {
  it('generates a ULID trajectoryId', () => {
    const w = createInMemoryTrajectoryWriter();
    expect(w.trajectoryId).toMatch(ULID);
  });

  it('accepts an explicit trajectoryId if provided', () => {
    const id = '01J9ZSZABCDEFGHJKMNPQRSTVW';
    const w = createInMemoryTrajectoryWriter({ trajectoryId: id });
    expect(w.trajectoryId).toBe(id);
  });

  it('rejects a malformed explicit trajectoryId', () => {
    expect(() => createInMemoryTrajectoryWriter({ trajectoryId: 'not-a-ulid' })).toThrow(/trajectoryId/);
  });

  it('append returns a new event_id and records the event', () => {
    const w = createInMemoryTrajectoryWriter();
    const id = w.append({
      event_type: 'session_start',
      payload: {
        session_id: w.trajectoryId,
        model_id: 'gpt-4o',
        provider_name: 'openai',
        system_prompt_hash: 'sha256:' + '0'.repeat(64),
        memory_refs: [],
      },
    });
    expect(id).toMatch(ULID);
    expect(w.currentEventId()).toBe(id);
    const events: TrajectoryEvent[] = w.events();
    expect(events).toHaveLength(1);
    expect(events[0].schema_version).toBe('1');
    expect(events[0].trajectory_id).toBe(w.trajectoryId);
    expect(events[0].event_id).toBe(id);
    expect(events[0].parent_event_id).toBeNull();
    expect(events[0].agent_id).toBe('leader');
    expect(events[0].timestamp).toMatch(ISO);
  });

  it('chains parent_event_id to the previous event by default', () => {
    const w = createInMemoryTrajectoryWriter();
    const id1 = w.append({
      event_type: 'session_start',
      payload: {
        session_id: w.trajectoryId,
        model_id: 'm',
        provider_name: 'p',
        system_prompt_hash: 'sha256:' + '0'.repeat(64),
        memory_refs: [],
      },
    });
    const id2 = w.append({
      event_type: 'agent_message',
      payload: { role: 'user', content: 'hi' },
    });
    const events = w.events();
    expect(events[0].parent_event_id).toBeNull();
    expect(events[1].parent_event_id).toBe(id1);
    expect(id2).toMatch(ULID);
  });

  it('honors an explicit parent_event_id override', () => {
    const w = createInMemoryTrajectoryWriter();
    const root = w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    w.append({ event_type: 'llm_api_call', payload: makeLlmPayload() });
    const id = w.append({
      event_type: 'agent_message',
      payload: { role: 'assistant', content: 'hi' },
      parent_event_id: root,
    });
    const events = w.events();
    expect(events[2].parent_event_id).toBe(root);
    expect(events[2].event_id).toBe(id);
  });

  it('supports teammate agent_id', () => {
    const w = createInMemoryTrajectoryWriter();
    w.append({
      event_type: 'session_start',
      payload: makeStartPayload(w.trajectoryId),
      agent_id: 'teammate:worker_a',
    });
    expect(w.events()[0].agent_id).toBe('teammate:worker_a');
  });

  it('flush is a no-op for in-memory writer', async () => {
    const w = createInMemoryTrajectoryWriter();
    await expect(w.flush()).resolves.toBeUndefined();
  });

  it('close prevents further appends', async () => {
    const w = createInMemoryTrajectoryWriter();
    await w.close();
    expect(() => w.append({ event_type: 'session_end', payload: { session_id: w.trajectoryId, reason: 'complete' } })).toThrow(/closed/);
  });

  it('read() yields all appended events in order', async () => {
    const w = createInMemoryTrajectoryWriter();
    const id1 = w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    const id2 = w.append({ event_type: 'agent_message', payload: { role: 'user', content: 'hi' } });
    const collected: string[] = [];
    for await (const e of w.read()) collected.push(e.event_id);
    expect(collected).toEqual([id1, id2]);
  });

  it('read({sinceEventId}) yields only events strictly after the given id', async () => {
    const w = createInMemoryTrajectoryWriter();
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    const id2 = w.append({ event_type: 'agent_message', payload: { role: 'user', content: 'a' } });
    const id3 = w.append({ event_type: 'agent_message', payload: { role: 'assistant', content: 'b' } });
    const collected: string[] = [];
    for await (const e of w.read({ sinceEventId: id2 })) collected.push(e.event_id);
    expect(collected).toEqual([id3]);
  });

  it('preserves the ext field when provided on append', () => {
    const w = createInMemoryTrajectoryWriter();
    w.append({
      event_type: 'session_start',
      payload: makeStartPayload(w.trajectoryId),
      ext: { rl: { reward: 0.5 } },
    });
    const events = w.events();
    expect(events[0].ext).toEqual({ rl: { reward: 0.5 } });
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

function makeLlmPayload(): Record<string, unknown> {
  return {
    turn_id: '01J9ZSZABCDEFGHJKMNPQRSTVW',
    model_id: 'gpt-4o',
    provider: 'openai',
    request_messages: [],
    response_message: {},
    usage: { input_tokens: 0, output_tokens: 0 },
    latency_ms: 0,
  };
}
