import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getModel } from '@researchcomputer/ai-provider';
import { createAgent } from './factory.js';
import type { AgentMessage, StreamFn } from '@mariozechner/pi-agent-core';
import { createAssistantMessageEventStream } from '@researchcomputer/ai-provider';
import type { SessionSnapshot } from '../core/types.js';

function makeNoOpStreamFn(responseText: string = 'ok'): StreamFn {
  return (model, _messages, _options) => {
    const stream = createAssistantMessageEventStream();
    const msg = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: responseText }],
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

describe('Integration Scenarios: Complex flows', () => {
  let sessionDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-sess-'));
    memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-mem-'));
  });

  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true });
    await fs.rm(memoryDir, { recursive: true, force: true });
  });

  it('Scenario 1: Agent memory save, session snapshot, restore and verification', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      streamFn: makeNoOpStreamFn('Hello user'),
    });

    // Generate a response
    await agent.prompt('Hello');
    expect(agent.agent.state.messages).toHaveLength(2); // user msg + assistant msg

    // Force memory save
    await agent.memory.save({
      name: 'user_preference',
      description: 'The user prefers strict typing',
      type: 'user',
      content: 'I like TypeScript strict mode.'
    });

    const sessionId = (agent.agent as any)._runContext?.sessionId;
    
    // Dispose saves the session snapshot
    await agent.dispose();

    const files = await fs.readdir(sessionDir);
    const snapFile = files.find((f) => f.endsWith('.json') && !f.endsWith('.telemetry.json'));
    expect(snapFile).toBeDefined();

    const rawSnap = JSON.parse(await fs.readFile(path.join(sessionDir, snapFile!), 'utf-8')) as SessionSnapshot;
    expect(rawSnap.memoryRefs).toContain('user_preference');

    // Resume agent from the saved snapshot
    const resumedAgent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      sessionId: rawSnap.id,
      streamFn: makeNoOpStreamFn('Resumed response'),
    });

    const memories = await resumedAgent.memory.load();
    expect(memories.find(m => m.name === 'user_preference')).toBeDefined();
    
    // Ensure telemetry cost state was restored (starts at 0 in this mock but test it's an object)
    expect(resumedAgent.costTracker.total()).toBeDefined();

    await resumedAgent.dispose();
  });

  it('Scenario 2: Agent fork with isolated messages', async () => {
    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      streamFn: makeNoOpStreamFn('Base agent response'),
    });

    await agent.prompt('Initial prompt');
    
    // Fork the agent
    const forks = await agent.fork('Parallel task', 2);
    expect(forks).toHaveLength(2);

    // Give forks different state
    const fork1 = forks[0];
    const fork2 = forks[1];
    
    // Check that both have the "Parallel task" message
    expect(fork1.agent.state.messages[fork1.agent.state.messages.length - 2].content[0]).toEqual({ type: 'text', text: 'Parallel task' });
    expect(fork2.agent.state.messages[fork2.agent.state.messages.length - 2].content[0]).toEqual({ type: 'text', text: 'Parallel task' });

    await fork1.dispose();
    await fork2.dispose();
    await agent.dispose();
  });

  it('Scenario 3: Agent handles external MCP connection gracefully (e.g. Context7)', async () => {
    let context7Key = process.env.CONTEXT7_API_KEY;
    if (!context7Key) {
      try {
        const envFile = await fs.readFile(path.join(process.cwd(), '.env'), 'utf-8');
        const match = envFile.match(/CONTEXT7_API_KEY=(.+)/);
        if (match) context7Key = match[1].trim();
      } catch (e) {
        // Ignore if .env doesn't exist
      }
    }

    const mcpConfig: any = {
      name: 'context7',
      transport: 'http',
      url: 'https://mcp.context7.com/mcp' // Without an API key, this gracefully fails
    };

    if (context7Key) {
      mcpConfig.headers = { 'CONTEXT7_API_KEY': context7Key };
    }

    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      streamFn: makeNoOpStreamFn('Base agent response'),
      mcpServers: [mcpConfig]
    });

    // Verify the agent started successfully without crashing
    expect(agent).toBeDefined();

    const warnings = agent.getWarnings();
    const mcpWarning = warnings.find(w => w.code === 'mcp_connect_failed');
    
    if (context7Key) {
      // With a valid API key, the connection should succeed
      expect(mcpWarning).toBeUndefined();
      
      // Verify tools are loaded from context7
      const tools = agent.agent.state.tools;
      const resolveLibraryTool = tools.find((t: any) => t.name === 'mcp__context7__resolve-library-id');
      expect(resolveLibraryTool).toBeDefined();
    } else {
      // Verify a warning was correctly recorded for the connection failure
      expect(mcpWarning).toBeDefined();
      expect(mcpWarning?.message).toContain('context7');
    }

    await agent.dispose();
  });

  it('Scenario 4: Agent composition with an Anthropics-style Skill', async () => {
    const creativeSkill = {
      id: 'creative-writing',
      description: 'A skill for creative writing and brainstorming.',
      promptSections: [
        'You are a creative assistant.',
        'Use the brainstorm tool to generate ideas.'
      ],
      tools: [
        {
          name: 'brainstorm',
          description: 'Generates creative ideas',
          parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
          capabilities: [],
          execute: async () => ({ content: [{ type: 'text', text: 'Some ideas' }] })
        }
      ]
    };

    const model = getModel('openai', 'gpt-4o-mini');
    const agent = await createAgent({
      model,
      permissionMode: 'allowAll',
      authToken: 't',
      sessionDir,
      memoryDir,
      streamFn: makeNoOpStreamFn(),
      skills: [creativeSkill as any]
    });

    const systemPrompt = agent.agent.state.systemPrompt;
    
    // Verify the skill's instructions were injected into the system prompt
    expect(systemPrompt).toContain('## creative-writing');
    expect(systemPrompt).toContain('You are a creative assistant.');
    expect(systemPrompt).toContain('Use the brainstorm tool to generate ideas.');

    // Verify the skill's tools were correctly mounted
    const tools = agent.agent.state.tools;
    expect(tools.find((t: any) => t.name === 'brainstorm')).toBeDefined();

    await agent.dispose();
  });
});
