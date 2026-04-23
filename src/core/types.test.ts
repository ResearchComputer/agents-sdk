import { describe, it, expect } from 'vitest';
import type {
  Capability,
  SdkTool,
  PermissionMode,
  PermissionResult,
  PermissionRule,
  PermissionTarget,
  PermissionDecision,
  HookEvent,
  HookContext,
  HookResult,
  HookHandler,
  RunContext,
  CostTracker,
  MemoryType,
  Memory,
  MemorySelection,
  MemoryManager,
  SessionSnapshot,
  SessionManager,
  SessionTelemetry,
  LlmCallRecord,
  ToolEventRecord,
  SegmentType,
  TranscriptSegment,
  CompressionConfig,
  McpServerConfig,
  McpConnection,
  McpManager,
  TaskBudget,
  TeammateConfig,
  TeamAgent,
  Team,
  TeamConfig,
  SwarmManager,
  ToolOptions,
  SchemaConversionResult,
  MemoryInjectionMessage,
  CompactionSummaryMessage,
  SwarmReportMessage,
} from './types.js';

describe('types', () => {
  it('Capability type accepts valid values', () => {
    const caps: Capability[] = ['fs:read', 'fs:write', 'process:spawn', 'network:egress', 'git:mutate', 'mcp:call'];
    expect(caps).toHaveLength(6);
  });

  it('PermissionMode type accepts valid values', () => {
    const modes: PermissionMode[] = ['default', 'allowAll', 'rulesOnly'];
    expect(modes).toHaveLength(3);
  });

  it('PermissionResult union types work', () => {
    const allow: PermissionResult = { behavior: 'allow' };
    const deny: PermissionResult = { behavior: 'deny', reason: 'not allowed' };
    const ask: PermissionResult = { behavior: 'ask', prompt: 'Allow?' };
    expect(allow.behavior).toBe('allow');
    expect(deny.behavior).toBe('deny');
    expect(ask.behavior).toBe('ask');
  });

  it('HookEvent type accepts valid values', () => {
    const events: HookEvent[] = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop'];
    expect(events).toHaveLength(9);
  });

  it('MemoryType type accepts valid values', () => {
    const types: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
    expect(types).toHaveLength(4);
  });

  it('SegmentType type accepts valid values', () => {
    const types: SegmentType[] = ['system', 'memory', 'user', 'assistant', 'toolIO', 'summary'];
    expect(types).toHaveLength(6);
  });

  it('PermissionTarget union types work', () => {
    const targets: PermissionTarget[] = [
      { type: 'tool', name: 'readFile' },
      { type: 'tool', name: 'writeFile', pattern: '*.ts' },
      { type: 'capability', capability: 'fs:read' },
      { type: 'mcp', server: 'myServer' },
      { type: 'mcp', server: 'myServer', tool: 'myTool' },
      { type: 'all' },
    ];
    expect(targets).toHaveLength(6);
  });

  it('McpServerConfig accepts valid transport types', () => {
    const stdio: McpServerConfig = { name: 'test', transport: 'stdio', command: 'node', args: ['server.js'] };
    const sse: McpServerConfig = { name: 'test', transport: 'sse', url: 'http://localhost:3000' };
    const http: McpServerConfig = { name: 'test', transport: 'http', url: 'http://localhost:3000' };
    expect(stdio.transport).toBe('stdio');
    expect(sse.transport).toBe('sse');
    expect(http.transport).toBe('http');
  });

  it('TaskBudget has correct shape', () => {
    const budget: TaskBudget = { maxTurns: 10 };
    const budgetFull: TaskBudget = { maxTurns: 10, maxTokens: 1000, timeoutMs: 5000 };
    expect(budget.maxTurns).toBe(10);
    expect(budgetFull.maxTokens).toBe(1000);
  });

  it('TeamAgent status values work', () => {
    const agent: TeamAgent = { name: 'worker', taskId: 't1', status: 'idle', budget: { maxTurns: 5 } };
    expect(['idle', 'running', 'stopped']).toContain(agent.status);
  });

  it('Custom message types have correct roles', () => {
    const mem: MemoryInjectionMessage = { role: 'memory', content: 'test', sources: ['a'], timestamp: Date.now() };
    const comp: CompactionSummaryMessage = { role: 'summary', content: 'test', compactedCount: 5, timestamp: Date.now() };
    const swarm: SwarmReportMessage = { role: 'swarmReport', content: 'test', fromAgent: 'a', taskId: 't1', timestamp: Date.now() };
    expect(mem.role).toBe('memory');
    expect(comp.role).toBe('summary');
    expect(swarm.role).toBe('swarmReport');
  });

  it('SessionTelemetry has correct shape', () => {
    const llmCall: LlmCallRecord = {
      timestamp: 1000,
      modelId: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.01,
      latencyMs: 300,
    };
    const toolEvent: ToolEventRecord = {
      timestamp: 2000,
      toolName: 'Read',
      durationMs: 50,
      success: true,
    };
    const telemetry: SessionTelemetry = {
      schemaVersion: 1,
      optOut: false,
      llmCalls: [llmCall],
      toolEvents: [toolEvent],
      totalCost: 0.01,
      totalTokens: 150,
    };
    expect(telemetry.schemaVersion).toBe(1);
    expect(telemetry.llmCalls).toHaveLength(1);
    expect(telemetry.toolEvents[0].toolName).toBe('Read');
  });

  it('SessionSnapshot accepts optional telemetry field', () => {
    const snap: SessionSnapshot = {
      version: 2,
      id: 'test-id',
      trajectoryId: '01J9ZSZABCDEFGHJKMNPQRSTVW',
      lastEventId: null,
      modelId: 'gpt-4o',
      providerName: 'openai',
      systemPromptHash: 'abc',
      memoryRefs: [],
      createdAt: 1000,
      updatedAt: 2000,
      // telemetry is optional — omitting it is valid
    };
    expect(snap.telemetry).toBeUndefined();
  });
});
