import { describe, it, expect } from 'vitest';
import { replayTrajectory } from './replay.js';
import { createInMemoryTrajectoryWriter } from './writer.js';

function makeStartPayload(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    model_id: 'gpt-4o',
    provider_name: 'openai',
    system_prompt_hash: 'sha256:' + '0'.repeat(64),
    memory_refs: [],
  };
}

describe('replayTrajectory', () => {
  it('returns empty state for an empty trajectory', () => {
    const r = replayTrajectory([]);
    expect(r.messages).toEqual([]);
    expect(r.permissionDecisions).toEqual([]);
    expect(r.interruptedToolCallIds).toEqual([]);
  });

  it('reconstructs messages[] from agent_message events', () => {
    const w = createInMemoryTrajectoryWriter();
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    w.append({ event_type: 'agent_message', payload: { role: 'user', content: 'hi' } });
    w.append({ event_type: 'agent_message', payload: { role: 'assistant', content: 'hello back' } });
    const r = replayTrajectory(w.events());
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(r.messages[1]).toMatchObject({ role: 'assistant', content: 'hello back' });
  });

  it('reconstructs permissionDecisions[] from permission_decision events', () => {
    const w = createInMemoryTrajectoryWriter();
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    w.append({
      event_type: 'permission_decision',
      payload: {
        tool_name: 'Bash',
        args: { command: 'ls' },
        behavior: 'allow',
        normalized_target: 'Bash',
      },
    });
    w.append({
      event_type: 'permission_decision',
      payload: {
        tool_name: 'Write',
        args: { file_path: '/tmp/x' },
        behavior: 'deny',
        normalized_target: 'Write',
      },
    });
    const r = replayTrajectory(w.events());
    expect(r.permissionDecisions).toHaveLength(2);
    expect(r.permissionDecisions[0].toolName).toBe('Bash');
    expect(r.permissionDecisions[0].behavior).toBe('allow');
    expect(r.permissionDecisions[1].behavior).toBe('deny');
  });

  it('marks tool calls with no matching result as interrupted', () => {
    const w = createInMemoryTrajectoryWriter();
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    w.append({
      event_type: 'tool_call',
      payload: { tool_name: 'Bash', tool_call_id: 'call-A', args: {}, capabilities: [] },
    });
    w.append({
      event_type: 'tool_result',
      payload: { tool_call_id: 'call-A', duration_ms: 5, success: true, output: 'ok' },
    });
    w.append({
      event_type: 'tool_call',
      payload: { tool_name: 'Write', tool_call_id: 'call-B', args: { file_path: '/x' }, capabilities: [] },
    });
    // call-B has no result: interrupted.
    const r = replayTrajectory(w.events());
    expect(r.interruptedToolCallIds).toEqual(['call-B']);
    // Phase 3 addition: expose the full context for each interrupted call
    // so the resume path can inject a properly-shaped synthetic tool_result.
    expect(r.interruptedToolCalls).toHaveLength(1);
    expect(r.interruptedToolCalls[0].toolCallId).toBe('call-B');
    expect(r.interruptedToolCalls[0].toolName).toBe('Write');
  });

  it('ignores unknown event types without throwing', () => {
    const events = [
      {
        schema_version: '1' as const,
        trajectory_id: '01J9ZSZABCDEFGHJKMNPQRSTVW',
        event_id: '01J9ZSZABCDEFGHJKMNPQRST02',
        parent_event_id: null,
        event_type: 'error' as const,
        timestamp: '2026-04-21T00:00:00.000Z',
        agent_id: 'leader',
        payload: { error_code: 'X', error_message: 'boom' },
      },
    ];
    const r = replayTrajectory(events);
    expect(r.messages).toEqual([]);
    expect(r.permissionDecisions).toEqual([]);
  });

  it('skips malformed agent_message events (missing role)', () => {
    const w = createInMemoryTrajectoryWriter();
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    w.append({ event_type: 'agent_message', payload: { content: 'no role' } as unknown as Record<string, unknown> });
    w.append({ event_type: 'agent_message', payload: { role: 'user', content: 'good' } });
    const r = replayTrajectory(w.events());
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ role: 'user' });
  });

  it('counts llm_api_call events', () => {
    const w = createInMemoryTrajectoryWriter();
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    w.append({ event_type: 'llm_api_call', payload: { model_id: 'gpt-4o', input_tokens: 10 } });
    w.append({ event_type: 'llm_api_call', payload: { model_id: 'gpt-4o', input_tokens: 5 } });
    const r = replayTrajectory(w.events());
    expect(r.llmApiCallCount).toBe(2);
  });

  it('yields events deterministically', () => {
    const w = createInMemoryTrajectoryWriter();
    w.append({ event_type: 'session_start', payload: makeStartPayload(w.trajectoryId) });
    w.append({ event_type: 'agent_message', payload: { role: 'user', content: 'x' } });
    const r1 = replayTrajectory(w.events());
    const r2 = replayTrajectory(w.events());
    expect(r1.messages).toEqual(r2.messages);
  });
});
