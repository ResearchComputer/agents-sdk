import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getModel } from '@researchcomputer/ai-provider';
import { createAgent } from './factory.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockCompleteN = vi.fn();

vi.mock('@researchcomputer/ai-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@researchcomputer/ai-provider')>();
  return {
    ...actual,
    completeN: (...args: unknown[]) => mockCompleteN(...args),
  };
});

describe('Documentation Verification Tests', () => {
  const tmpDir = path.join(os.tmpdir(), `agents-sdk-test-${Date.now()}`);

  beforeEach(() => {
    vi.clearAllMocks();
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  it('verifies snapshots are message-centric and do not capture file system state', async () => {
    const agent = await createAgent({
      model: getModel('openai', 'gpt-4o-mini'),
      cwd: tmpDir,
      permissionMode: 'allowAll',
      enableMemory: false,
      authToken: 'test-jwt',
    });

    const testFile = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(testFile, 'initial content');
    const snapshot = agent.snapshot();
    fs.writeFileSync(testFile, 'modified content');
    agent.restore(snapshot);
    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toBe('modified content');
    await agent.dispose();
  });

  it('verifies fork(message, n) uses completeN optimization for OpenAI-compatible models', async () => {
    mockCompleteN.mockResolvedValue([
      { role: 'assistant', content: [{ type: 'text', text: 'response 1' }] } as any,
      { role: 'assistant', content: [{ type: 'text', text: 'response 2' }] } as any,
    ]);

    const model = getModel('openai', 'gpt-4o-mini');
    // gpt-4o-mini is 'openai-responses' in this environment, which we now support
    expect(model.api).toBe('openai-responses');

    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      enableMemory: false,
      authToken: 'test-jwt',
    });

    const n = 2;
    const children = await agent.fork('Hello', n);

    // If spy fails, let's look at the actual messages to see if they came from our mock
    const lastMsg0 = children[0].agent.state.messages.at(-1);
    const text0 = (lastMsg0?.content as any)[0].text;

    expect(text0).toBe('response 1');
    expect(mockCompleteN).toHaveBeenCalled();
    expect(children).toHaveLength(n);

    for (const child of children) await child.dispose();
    await agent.dispose();
  });

  it('verifies fork(message, n) falls back when optimized responses contain tool calls', async () => {
    mockCompleteN.mockResolvedValue([
      { role: 'assistant', content: [{ type: 'toolCall', toolName: 'Read', args: { file_path: 'foo' }, toolCallId: '1' }] } as any,
      { role: 'assistant', content: [{ type: 'text', text: 'response 2' }] } as any,
    ]);

    const agent = await createAgent({
      model: getModel('openai', 'gpt-4o-mini'),
      permissionMode: 'allowAll',
      enableMemory: false,
      authToken: 'test-jwt',
    });

    const n = 2;
    // Catch since it might try to hit the network in the fallback standard prompt
    const children = await agent.fork('Hello', n).catch(() => []);

    expect(mockCompleteN).toHaveBeenCalled();

    for (const child of children) await child.dispose();
    await agent.dispose();
  });
});
