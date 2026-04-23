import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getModel } from '@researchcomputer/ai-provider';
import { createAgent } from './factory.js';
import type { Agent } from '../core/types.js';
import type { AgentMessage, StreamFn } from '@mariozechner/pi-agent-core';
import { createAssistantMessageEventStream } from '@researchcomputer/ai-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as AgentMessage;
}

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o-mini',
    timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as AgentMessage;
}

async function makeAgent() {
  return createAgent({
    model: getModel('openai', 'gpt-4o-mini'),
    permissionMode: 'allowAll',
    enableMemory: false,
    authToken: 'test-jwt',
  });
}

// ---------------------------------------------------------------------------
// No-op stream function for fork tests
// ---------------------------------------------------------------------------

function makeNoOpStreamFn(): StreamFn {
  return (model, _messages, _options) => {
    const stream = createAssistantMessageEventStream();
    const msg = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'ok' }],
      stopReason: 'stop' as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: 'start', partial: msg });
    stream.push({ type: 'done', reason: 'stop', message: msg });
    return stream;
  };
}

async function makeAgentWithStream() {
  return createAgent({
    model: getModel('openai', 'gpt-4o-mini'),
    permissionMode: 'allowAll',
    enableMemory: false,
    streamFn: makeNoOpStreamFn(),
    authToken: 'test-jwt',
  });
}

// ---------------------------------------------------------------------------
// snapshot()
// ---------------------------------------------------------------------------

describe('snapshot()', () => {
  it('returns a snapshot with the current messages and a uuid id', async () => {
    const agent = await makeAgent();
    const msgs = [makeUserMessage('hello'), makeAssistantMessage('world')];
    agent.agent.replaceMessages(msgs);

    const snap = agent.snapshot();

    expect(snap.id).toMatch(/^[0-9a-f-]{36}$/); // uuid format
    expect(snap.messages).toHaveLength(2);
    expect(snap.messages[0]).toEqual(msgs[0]);
    expect(snap.createdAt).toBeGreaterThan(0);

    await agent.dispose();
  });

  it('snapshot messages are a deep clone — mutating original does not affect snapshot', async () => {
    const agent = await makeAgent();
    const msgs = [makeUserMessage('original')];
    agent.agent.replaceMessages(msgs);

    const snap = agent.snapshot();
    // mutate original
    agent.agent.replaceMessages([makeUserMessage('mutated')]);

    expect(snap.messages[0]).toEqual(makeUserMessage('original'));

    await agent.dispose();
  });

  it('throws if agent is currently streaming', async () => {
    const agent = await makeAgent();
    // Force isStreaming to true by directly mutating internal state
    (agent.agent.state as any).isStreaming = true;

    expect(() => agent.snapshot()).toThrow('snapshot: cannot snapshot while agent is streaming');

    (agent.agent.state as any).isStreaming = false;
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// restore()
// ---------------------------------------------------------------------------

describe('restore()', () => {
  it('replaces agent messages with snapshot messages', async () => {
    const agent = await makeAgent();
    const original = [makeUserMessage('before')];
    agent.agent.replaceMessages(original);
    const snap = agent.snapshot();

    agent.agent.replaceMessages([makeUserMessage('after')]);
    agent.restore(snap);

    expect(agent.agent.state.messages).toHaveLength(1);
    expect(agent.agent.state.messages[0]).toEqual(makeUserMessage('before'));

    await agent.dispose();
  });

  it('restore uses a deep clone — mutating snapshot after restore does not affect agent', async () => {
    const agent = await makeAgent();
    agent.agent.replaceMessages([makeUserMessage('snap')]);
    const snap = agent.snapshot();

    agent.restore(snap);
    // mutate the snapshot's messages array
    snap.messages.push(makeUserMessage('extra'));

    expect(agent.agent.state.messages).toHaveLength(1);

    await agent.dispose();
  });

  it('throws if agent is currently streaming', async () => {
    const agent = await makeAgent();
    const snap = agent.snapshot();
    (agent.agent.state as any).isStreaming = true;

    expect(() => agent.restore(snap)).toThrow('restore: cannot restore while agent is streaming');

    (agent.agent.state as any).isStreaming = false;
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// fork() edge cases
// ---------------------------------------------------------------------------

describe('fork() edge cases', () => {
  it('returns empty array when n = 0', async () => {
    const agent = await makeAgentWithStream();
    const children = await agent.fork('hello', 0);
    expect(children).toEqual([]);
    await agent.dispose();
  });

  it('throws RangeError when n < 0', async () => {
    const agent = await makeAgentWithStream();
    await expect(agent.fork('hello', -1)).rejects.toThrow(RangeError);
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// fork() happy path
// ---------------------------------------------------------------------------

describe('fork() happy path', () => {
  it('returns n independent Agent instances', async () => {
    const agent = await makeAgentWithStream();
    agent.agent.replaceMessages([makeUserMessage('parent context')]);

    const children = await agent.fork('branch now', 2);

    expect(children).toHaveLength(2);
    // Each is a proper Agent
    for (const child of children) {
      expect(typeof child.prompt).toBe('function');
      expect(typeof child.snapshot).toBe('function');
      expect(typeof child.fork).toBe('function');
      expect(typeof child.dispose).toBe('function');
    }

    for (const child of children) await child.dispose();
    await agent.dispose();
  });

  it('parent message history is unchanged after fork', async () => {
    const agent = await makeAgentWithStream();
    agent.agent.replaceMessages([makeUserMessage('parent context')]);
    const parentMsgsBefore = structuredClone(agent.agent.state.messages);

    await agent.fork('branch', 2);

    expect(agent.agent.state.messages).toEqual(parentMsgsBefore);
    await agent.dispose();
  });

  it('children start with parent message history', async () => {
    const agent = await makeAgentWithStream();
    agent.agent.replaceMessages([makeUserMessage('parent context')]);

    const children = await agent.fork('branch', 2);

    // Each child history starts with the parent context message
    for (const child of children) {
      expect(child.agent.state.messages[0]).toEqual(makeUserMessage('parent context'));
    }

    for (const child of children) await child.dispose();
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// promptFork() — alias for fork()
// ---------------------------------------------------------------------------

describe('promptFork()', () => {
  it('returns same result as fork() — is an alias', async () => {
    const agent = await makeAgentWithStream();
    const children = await agent.promptFork('test', 2);
    expect(children).toHaveLength(2);
    for (const child of children) await child.dispose();
    await agent.dispose();
  });

  it('returns empty array when n = 0', async () => {
    const agent = await makeAgentWithStream();
    const children = await agent.promptFork('test', 0);
    expect(children).toEqual([]);
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// forkFrom()
// ---------------------------------------------------------------------------

describe('forkFrom()', () => {
  it('parent messages are untouched after forkFrom', async () => {
    const agent = await makeAgentWithStream();
    const initial = [makeUserMessage('initial')];
    agent.agent.replaceMessages(initial);

    // Take snapshot, then advance parent
    const snap = agent.snapshot();
    agent.agent.replaceMessages([makeUserMessage('advanced'), makeUserMessage('more')]);
    const parentMsgsBefore = structuredClone(agent.agent.state.messages);

    await agent.forkFrom(snap, 'branch from snapshot', 2);

    expect(agent.agent.state.messages).toEqual(parentMsgsBefore);
    await agent.dispose();
  });

  it('children start with snapshot message history', async () => {
    const agent = await makeAgentWithStream();
    agent.agent.replaceMessages([makeUserMessage('snap context')]);
    const snap = agent.snapshot();

    // Advance parent past snapshot
    agent.agent.replaceMessages([makeUserMessage('advanced')]);

    const children = await agent.forkFrom(snap, 'branch', 2);

    for (const child of children) {
      expect(child.agent.state.messages[0]).toEqual(makeUserMessage('snap context'));
    }

    for (const child of children) await child.dispose();
    await agent.dispose();
  });

  it('returns empty array when n = 0', async () => {
    const agent = await makeAgentWithStream();
    const snap = agent.snapshot();
    const children = await agent.forkFrom(snap, 'test', 0);
    expect(children).toEqual([]);
    await agent.dispose();
  });

  it('throws RangeError when n < 0', async () => {
    const agent = await makeAgentWithStream();
    const snap = agent.snapshot();
    await expect(agent.forkFrom(snap, 'test', -1)).rejects.toThrow(RangeError);
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// Child isolation
// ---------------------------------------------------------------------------

describe('child isolation', () => {
  it('children have independent message histories after fork', async () => {
    const agent = await makeAgentWithStream();
    agent.agent.replaceMessages([makeUserMessage('shared context')]);

    const children = await agent.fork('diverge', 2);

    // Mutate child 0's messages directly
    children[0].agent.replaceMessages([
      ...children[0].agent.state.messages,
      makeUserMessage('only in child 0'),
    ]);

    // child 1 should NOT see child 0's extra message
    const child1Texts = children[1].agent.state.messages.map(
      (m: any) => m.content?.[0]?.text
    );
    expect(child1Texts).not.toContain('only in child 0');

    // parent should NOT see either child's changes
    const parentTexts = agent.agent.state.messages.map(
      (m: any) => m.content?.[0]?.text
    );
    expect(parentTexts).not.toContain('only in child 0');

    for (const child of children) await child.dispose();
    await agent.dispose();
  });

  it('children have independent cost trackers', async () => {
    const agent = await makeAgentWithStream();
    const children = await agent.fork('go', 2);

    const parentCost = agent.costTracker.total();
    const child0Cost = children[0].costTracker.total();
    const child1Cost = children[1].costTracker.total();

    // Each child's cost tracker is its own instance
    expect(children[0].costTracker).not.toBe(agent.costTracker);
    expect(children[0].costTracker).not.toBe(children[1].costTracker);

    for (const child of children) await child.dispose();
    await agent.dispose();
  });

  it('fork with n=1 returns a single child', async () => {
    const agent = await makeAgentWithStream();
    agent.agent.replaceMessages([makeUserMessage('context')]);

    const children = await agent.fork('solo branch', 1);

    expect(children).toHaveLength(1);
    expect(children[0].agent.state.messages[0]).toEqual(makeUserMessage('context'));

    await children[0].dispose();
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// Nested forking
// ---------------------------------------------------------------------------

describe('nested forking', () => {
  it('child agents can fork further (2 levels deep)', async () => {
    const agent = await makeAgentWithStream();
    agent.agent.replaceMessages([makeUserMessage('root')]);

    const level1 = await agent.fork('level 1', 1);
    expect(level1).toHaveLength(1);

    const level2 = await level1[0].fork('level 2', 2);
    expect(level2).toHaveLength(2);

    // Level 2 children should have root context in their history
    for (const grandchild of level2) {
      expect(grandchild.agent.state.messages[0]).toEqual(makeUserMessage('root'));
    }

    for (const grandchild of level2) await grandchild.dispose();
    await level1[0].dispose();
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// Snapshot/restore round-trips with prompt()
// ---------------------------------------------------------------------------

describe('snapshot + restore + prompt round-trip', () => {
  it('can snapshot, prompt, then restore to pre-prompt state', async () => {
    const agent = await makeAgentWithStream();
    agent.agent.replaceMessages([makeUserMessage('setup')]);

    const snap = agent.snapshot();
    const msgCountBefore = snap.messages.length;

    // prompt adds messages (user + assistant)
    await agent.prompt('do something');
    expect(agent.agent.state.messages.length).toBeGreaterThan(msgCountBefore);

    // restore rolls back
    agent.restore(snap);
    expect(agent.agent.state.messages).toHaveLength(msgCountBefore);
    expect(agent.agent.state.messages[0]).toEqual(makeUserMessage('setup'));

    await agent.dispose();
  });

  it('can restore and then prompt again from restored state', async () => {
    const agent = await makeAgentWithStream();
    agent.agent.replaceMessages([makeUserMessage('checkpoint')]);

    const snap = agent.snapshot();

    await agent.prompt('first attempt');
    agent.restore(snap);
    await agent.prompt('second attempt');

    // After restore + re-prompt, messages should contain the checkpoint
    // plus whatever the second prompt added — NOT the first attempt
    const texts = agent.agent.state.messages.map(
      (m: any) => m.content?.[0]?.text
    );
    expect(texts).toContain('checkpoint');
    expect(texts).toContain('second attempt');
    expect(texts).not.toContain('first attempt');

    await agent.dispose();
  });

  it('multiple snapshots are independent', async () => {
    const agent = await makeAgentWithStream();

    agent.agent.replaceMessages([makeUserMessage('state A')]);
    const snapA = agent.snapshot();

    agent.agent.replaceMessages([makeUserMessage('state B')]);
    const snapB = agent.snapshot();

    // Restore A
    agent.restore(snapA);
    expect(agent.agent.state.messages[0]).toEqual(makeUserMessage('state A'));

    // Restore B
    agent.restore(snapB);
    expect(agent.agent.state.messages[0]).toEqual(makeUserMessage('state B'));

    // snapA still intact
    expect(snapA.messages[0]).toEqual(makeUserMessage('state A'));

    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// forkFrom with prompt round-trip
// ---------------------------------------------------------------------------

describe('forkFrom + snapshot integration', () => {
  it('can fork from an older snapshot after parent has advanced', async () => {
    const agent = await makeAgentWithStream();
    agent.agent.replaceMessages([makeUserMessage('v1')]);
    const snapV1 = agent.snapshot();

    // Advance parent
    await agent.prompt('advance to v2');

    // Fork from old snapshot — children should start from v1, not v2
    const children = await agent.forkFrom(snapV1, 'explore from v1', 2);

    for (const child of children) {
      expect(child.agent.state.messages[0]).toEqual(makeUserMessage('v1'));
    }

    // Parent should still be at v2 (advanced state)
    expect(agent.agent.state.messages.length).toBeGreaterThan(1);

    for (const child of children) await child.dispose();
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// autoFork config
// ---------------------------------------------------------------------------

describe('autoFork config', () => {
  it('calls onBranches after each LLM turn with n child agents', async () => {
    let resolveFork!: (agents: Agent[]) => void;
    const forkPromise = new Promise<Agent[]>(res => { resolveFork = res; });

    const agent = await createAgent({
      model: getModel('openai', 'gpt-4o-mini'),
      permissionMode: 'allowAll',
      enableMemory: false,
      streamFn: makeNoOpStreamFn(),
      authToken: 'test-jwt',
      autoFork: {
        branches: 2,
        onBranches: async (agents) => {
          resolveFork(agents);
        },
      },
    });

    await agent.prompt('hello');

    // Wait for onBranches to be called (no setTimeout — resolves when fork completes)
    const children = await forkPromise;

    expect(children).toHaveLength(2);

    for (const child of children) await child.dispose();
    await agent.dispose();
  });

  it('errors in onBranches do not throw or affect the parent', async () => {
    const agent = await createAgent({
      model: getModel('openai', 'gpt-4o-mini'),
      permissionMode: 'allowAll',
      enableMemory: false,
      streamFn: makeNoOpStreamFn(),
      authToken: 'test-jwt',
      autoFork: {
        branches: 1,
        onBranches: async () => {
          throw new Error('onBranches exploded');
        },
      },
    });

    // Should not throw
    await expect(agent.prompt('hello')).resolves.not.toThrow();

    await agent.dispose();
  });

  it('does not fork recursively in child agents', async () => {
    const forkCount = { count: 0 };
    let resolveNoRecursion!: () => void;
    const noRecursionPromise = new Promise<void>(res => { resolveNoRecursion = res; });

    const agent = await createAgent({
      model: getModel('openai', 'gpt-4o-mini'),
      permissionMode: 'allowAll',
      enableMemory: false,
      streamFn: makeNoOpStreamFn(),
      authToken: 'test-jwt',
      autoFork: {
        branches: 2,
        onBranches: async (agents) => {
          forkCount.count++;
          for (const child of agents) await child.dispose();
          resolveNoRecursion();
        },
      },
    });

    await agent.prompt('hello');
    await noRecursionPromise;

    // Only 1 fork from the parent — children should not auto-fork
    expect(forkCount.count).toBe(1);

    await agent.dispose();
  });

  it('surfaces fork errors via onError callback', async () => {
    let resolveErr!: (err: Error) => void;
    const errPromise = new Promise<Error>(res => { resolveErr = res; });

    const agent = await createAgent({
      model: getModel('openai', 'gpt-4o-mini'),
      permissionMode: 'allowAll',
      enableMemory: false,
      streamFn: makeNoOpStreamFn(),
      authToken: 'test-jwt',
      autoFork: {
        branches: 1,
        onBranches: async () => {
          throw new Error('onBranches exploded');
        },
        onError: (err) => resolveErr(err),
      },
    });

    await agent.prompt('hello');
    const captured = await errPromise;
    expect(captured.message).toBe('onBranches exploded');

    await agent.dispose();
  });

  it('skips a new fork while a prior fork is still in flight', async () => {
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>(res => { releaseFirst = res; });
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>(res => { resolveFirstStarted = res; });
    let forkCount = 0;

    const agent = await createAgent({
      model: getModel('openai', 'gpt-4o-mini'),
      permissionMode: 'allowAll',
      enableMemory: false,
      streamFn: makeNoOpStreamFn(),
      authToken: 'test-jwt',
      autoFork: {
        branches: 1,
        onBranches: async (agents) => {
          forkCount++;
          for (const a of agents) await a.dispose();
          if (forkCount === 1) {
            resolveFirstStarted();
            await firstRelease;
          }
        },
      },
    });

    await agent.prompt('first');
    await firstStarted;           // fork1 is now inside onBranches, blocked on firstRelease
    await agent.prompt('second'); // turn_end fires; with fix, fork2 is skipped

    // Give any incorrectly-spawned fork2 a chance to reach onBranches
    await new Promise(r => setTimeout(r, 200));
    expect(forkCount).toBe(1);

    releaseFirst();
    await agent.dispose();
    expect(forkCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fork() completeN optimization
// ---------------------------------------------------------------------------

describe('fork() completeN optimization', () => {
  it('skips completeN optimization when streamFn is provided', async () => {
    const streamCallCount = { count: 0 };
    const countingStreamFn: StreamFn = (model, _messages, _options) => {
      streamCallCount.count++;
      const stream = createAssistantMessageEventStream();
      const msg = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: `response-${streamCallCount.count}` }],
        stopReason: 'stop' as const,
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: 'start', partial: msg });
      stream.push({ type: 'done', reason: 'stop', message: msg });
      return stream;
    };

    const agent = await createAgent({
      model: getModel('openai', 'gpt-4o-mini'),
      permissionMode: 'allowAll',
      enableMemory: false,
      streamFn: countingStreamFn,
      authToken: 'test-jwt',
    });

    const children = await agent.fork('test', 3);
    expect(children).toHaveLength(3);

    // With streamFn provided, each child should have called the stream function
    // (standard path), meaning streamCallCount >= 3.
    expect(streamCallCount.count).toBeGreaterThanOrEqual(3);

    for (const child of children) await child.dispose();
    await agent.dispose();
  });
});
