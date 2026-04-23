import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getModel } from '@researchcomputer/ai-provider';
import { createAgent } from './factory.js';
import type { SessionSnapshot } from '../core/types.js';
import type { HookHandler } from '../core/types.js';

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('createAgent — Phase 3 interrupted-tool recovery', () => {
  let sessionDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    sessionDir = await tmp('p3-sess-');
    memoryDir = await tmp('p3-mem-');
  });
  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true });
    await fs.rm(memoryDir, { recursive: true, force: true });
  });

  async function setupTrajectoryWithOrphanedCall(): Promise<SessionSnapshot> {
    const model = getModel('openai', 'gpt-4o-mini');
    const a = await createAgent({ model, permissionMode: 'allowAll', authToken: 't', sessionDir, memoryDir });
    await a.dispose();
    const files = await fs.readdir(sessionDir);
    const snapFile = files.find((f) => f.endsWith('.json') && !f.endsWith('.telemetry.json'))!;
    const snap = JSON.parse(await fs.readFile(path.join(sessionDir, snapFile), 'utf-8')) as SessionSnapshot;

    // Append an orphaned tool_call (no matching result) to simulate a crash.
    const orphan = {
      schema_version: '1',
      trajectory_id: snap.trajectoryId,
      event_id: '01J9ZSZABCDEFGHJKMNPQRST97',
      parent_event_id: snap.lastEventId,
      event_type: 'tool_call',
      timestamp: '2026-04-21T12:00:00.000Z',
      agent_id: 'leader',
      payload: {
        tool_name: 'Bash',
        tool_call_id: 'orphan-call-1',
        args: { command: 'sleep 30' },
        capabilities: ['process:spawn'],
      },
    };
    await fs.appendFile(
      path.join(sessionDir, `${snap.trajectoryId}.trajectory.jsonl`),
      JSON.stringify(orphan) + '\n',
      'utf-8',
    );
    return snap;
  }

  it('injects a synthetic [interrupted] toolResult message on resume', async () => {
    const snap = await setupTrajectoryWithOrphanedCall();

    const model = getModel('openai', 'gpt-4o-mini');
    const resumed = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      sessionId: snap.id,
    });

    const msgs = resumed.agent.state.messages as Array<{ role: string; toolCallId?: string; content?: unknown; isError?: boolean; toolName?: string }>;
    const synthetic = msgs.find((m) => m.role === 'toolResult' && m.toolCallId === 'orphan-call-1');
    expect(synthetic).toBeDefined();
    expect(synthetic!.isError).toBe(true);
    expect(synthetic!.toolName).toBe('Bash');
    // Content includes the [interrupted] marker so the LLM can see it.
    expect(JSON.stringify(synthetic!.content)).toMatch(/\[interrupted\]/);
    await resumed.dispose();
  });

  it('emits a synthetic tool_result event to the trajectory on resume', async () => {
    const snap = await setupTrajectoryWithOrphanedCall();
    const model = getModel('openai', 'gpt-4o-mini');
    const resumed = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      sessionId: snap.id,
    });
    await resumed.dispose();

    const content = await fs.readFile(
      path.join(sessionDir, `${snap.trajectoryId}.trajectory.jsonl`),
      'utf-8',
    );
    const events = content.trim().split('\n').map((l) => JSON.parse(l));
    const synthetic = events.find(
      (e) => e.event_type === 'tool_result' && e.payload.tool_call_id === 'orphan-call-1',
    );
    expect(synthetic).toBeDefined();
    expect(synthetic.payload.success).toBe(false);
    expect(synthetic.parent_event_id).toBe('01J9ZSZABCDEFGHJKMNPQRST97');
  });

  it('does NOT re-interrupt the same tool call on a second resume', async () => {
    const snap = await setupTrajectoryWithOrphanedCall();
    const model = getModel('openai', 'gpt-4o-mini');
    // First resume: injects synthetic close.
    const r1 = await createAgent({ model, permissionMode: 'allowAll', authToken: 't', sessionDir, memoryDir, sessionId: snap.id });
    await r1.dispose();

    // Second resume: the trajectory now has a matching tool_result, so
    // the orphaned call should be considered closed, no new synthetic
    // message, no warnings about interruption.
    const r2 = await createAgent({ model, permissionMode: 'allowAll', authToken: 't', sessionDir, memoryDir, sessionId: snap.id });
    const files = await fs.readdir(sessionDir);
    const snapFile = files.find((f) => f.endsWith('.json') && !f.endsWith('.telemetry.json'))!;
    const snap2 = JSON.parse(await fs.readFile(path.join(sessionDir, snapFile), 'utf-8')) as SessionSnapshot;
    // contextState records no outstanding interruptions.
    expect(snap2.contextState?.interruptedToolCallIds ?? []).toEqual([]);
    // Only ONE synthetic [interrupted] toolResult appears in messages.
    const msgs = r2.agent.state.messages as Array<{ role: string; toolCallId?: string }>;
    const count = msgs.filter((m) => m.role === 'toolResult' && m.toolCallId === 'orphan-call-1').length;
    expect(count).toBe(1);
    await r2.dispose();
  });

  it('SessionStart hook receives resumed=true and interruptedToolCallIds on resume', async () => {
    const snap = await setupTrajectoryWithOrphanedCall();
    const observed: { resumed?: boolean; ids?: string[] } = {};
    const hook: HookHandler = {
      event: 'SessionStart',
      handler: async (ctx) => {
        observed.resumed = (ctx as unknown as { resumed?: boolean }).resumed;
        observed.ids = (ctx as unknown as { interruptedToolCallIds?: string[] }).interruptedToolCallIds;
      },
    };

    const model = getModel('openai', 'gpt-4o-mini');
    const resumed = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      sessionId: snap.id,
      hooks: [hook],
    });
    expect(observed.resumed).toBe(true);
    expect(observed.ids).toContain('orphan-call-1');
    await resumed.dispose();
  });

  it('SessionStart hook sees resumed=false on a fresh session', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    let resumed: boolean | undefined;
    const hook: HookHandler = {
      event: 'SessionStart',
      handler: async (ctx) => {
        resumed = (ctx as unknown as { resumed?: boolean }).resumed;
      },
    };
    const a = await createAgent({ model, permissionMode: 'allowAll', authToken: 't', sessionDir, memoryDir, hooks: [hook] });
    expect(resumed).toBe(false);
    await a.dispose();
  });
});
