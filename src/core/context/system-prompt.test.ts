import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './system-prompt.js';
import type { SystemPromptConfig } from './system-prompt.js';
import type { ResolvedSkill, SdkTool, MemorySelection } from '../types.js';
import { Type } from '@sinclair/typebox';

describe('buildSystemPrompt', () => {
  it('uses default base prompt when none provided', () => {
    const result = buildSystemPrompt({});
    expect(result).toContain('You are a coding agent');
  });

  it('uses provided base prompt', () => {
    const result = buildSystemPrompt({ basePrompt: 'You are a helpful bot.' });
    expect(result).toContain('You are a helpful bot.');
    expect(result).not.toContain('You are a coding agent');
  });

  it('includes tool descriptions when tools provided', () => {
    const tool: SdkTool = {
      name: 'Read',
      label: 'Read files',
      description: 'Reads a file from disk',
      capabilities: ['fs:read'],
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: null }),
    };
    const result = buildSystemPrompt({ tools: [tool] });
    expect(result).toContain('# Available Tools');
    expect(result).toContain('Read');
    expect(result).toContain('Reads a file from disk');
  });

  it('excludes tool section when no tools provided', () => {
    const result = buildSystemPrompt({});
    expect(result).not.toContain('# Available Tools');
  });

  it('omits the Active Skills section when every skill is empty', () => {
    const skills: ResolvedSkill[] = [
      { id: 'empty-one' },
      { id: 'empty-two', promptSections: ['   ', ''] },
    ];
    const result = buildSystemPrompt({ skills });
    expect(result).not.toContain('# Active Skills');
  });

  it('includes active skills when prompt sections are provided', () => {
    const skills: ResolvedSkill[] = [
      {
        id: 'typescript',
        description: 'TypeScript house style',
        promptSections: ['Prefer explicit return types on exported functions.'],
      },
    ];

    const result = buildSystemPrompt({ skills });

    expect(result).toContain('# Active Skills');
    expect(result).toContain('typescript');
    expect(result).toContain('TypeScript house style');
    expect(result).toContain('Prefer explicit return types');
  });

  it('includes memory context when memories provided', () => {
    const memories: MemorySelection[] = [
      {
        memory: { name: 'pref1', description: 'User pref', type: 'user', content: 'Prefers TypeScript' },
        relevanceScore: 0.9,
        source: 'user-prefs.md',
        updatedAt: 1700000000000,
      },
    ];
    const result = buildSystemPrompt({ memories });
    expect(result).toContain('# Relevant Memories');
    expect(result).toContain('Prefers TypeScript');
    expect(result).toContain('user-prefs.md');
  });

  it('excludes memory section when no memories provided', () => {
    const result = buildSystemPrompt({});
    expect(result).not.toContain('# Relevant Memories');
  });

  it('always includes memory instructions', () => {
    const result = buildSystemPrompt({});
    expect(result).toContain('memory');
  });

  it('includes permission context when mode provided', () => {
    const result = buildSystemPrompt({ permissionMode: 'allowAll' });
    expect(result).toContain('allowAll');
  });

  it('excludes permission section when no mode provided', () => {
    const result = buildSystemPrompt({});
    expect(result).not.toContain('Permission');
  });

  it('includes swarm context when provided', () => {
    const result = buildSystemPrompt({
      swarmContext: { teammates: ['worker-1', 'worker-2'], instructions: 'Coordinate tasks' },
    });
    expect(result).toContain('# Team Context');
    expect(result).toContain('worker-1');
    expect(result).toContain('worker-2');
    expect(result).toContain('Coordinate tasks');
  });

  it('includes swarm context without instructions', () => {
    const result = buildSystemPrompt({
      swarmContext: { teammates: ['agent-a'] },
    });
    expect(result).toContain('# Team Context');
    expect(result).toContain('agent-a');
  });

  it('excludes swarm section when no swarm context provided', () => {
    const result = buildSystemPrompt({});
    expect(result).not.toContain('# Team Context');
  });

  it('assembles all sections in correct order', () => {
    const tool: SdkTool = {
      name: 'Bash',
      label: 'Bash',
      description: 'Run shell commands',
      capabilities: ['process:spawn'],
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: null }),
    };
    const memories: MemorySelection[] = [
      {
        memory: { name: 'm1', description: 'd', type: 'project', content: 'Project uses ESM' },
        relevanceScore: 0.8,
        source: 'project.md',
        updatedAt: 1700000000000,
      },
    ];
    const result = buildSystemPrompt({
      basePrompt: 'Base prompt.',
      skills: [{ id: 'ts', promptSections: ['Prefer TypeScript.'] }],
      tools: [tool],
      memories,
      permissionMode: 'rulesOnly',
      swarmContext: { teammates: ['helper'] },
    });

    const skillsIdx = result.indexOf('# Active Skills');
    const toolsIdx = result.indexOf('# Available Tools');
    const memIdx = result.indexOf('# Relevant Memories');
    const permIdx = result.indexOf('Permission');
    const swarmIdx = result.indexOf('# Team Context');

    expect(skillsIdx).toBeGreaterThan(0);
    expect(toolsIdx).toBeGreaterThan(skillsIdx);
    expect(toolsIdx).toBeGreaterThan(0);
    expect(memIdx).toBeGreaterThan(toolsIdx);
    expect(permIdx).toBeGreaterThan(memIdx);
    expect(swarmIdx).toBeGreaterThan(permIdx);
  });
});
