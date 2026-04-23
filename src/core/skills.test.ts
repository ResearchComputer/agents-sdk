import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { HookHandler, PermissionRule, ResolvedSkill, SdkTool } from './types.js';
import { composeAgentConfig } from './skills.js';
import { getModel } from '@researchcomputer/ai-provider';

function createTool(name: string, description: string): SdkTool {
  return {
    name,
    label: name,
    description,
    capabilities: [],
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text', text: name }], details: { name } };
    },
  };
}

describe('composeAgentConfig', () => {
  it('merges skill prompt, tools, hooks, MCP servers, and permission rules', () => {
    const hook: HookHandler = {
      event: 'SessionStart',
      async handler() {},
    };
    const rule: PermissionRule = {
      target: { type: 'tool', name: 'Read' },
      behavior: 'allow',
      source: 'project',
    };
    const skill: ResolvedSkill = {
      id: 'typescript',
      promptSections: ['Prefer TypeScript.'],
      tools: [createTool('SkillTool', 'Provided by skill')],
      hooks: [hook],
      mcpServers: [{ name: 'skill-mcp', transport: 'sse', url: 'https://example.invalid/sse' }],
      permissionRules: [rule],
    };

    const composed = composeAgentConfig(
      {
        model: getModel('openai', 'gpt-4o-mini'),
        skills: [skill],
      },
      {
        defaultTools: [createTool('Read', 'Default read tool')],
      },
    );

    expect(composed.skills).toEqual([skill]);
    expect(composed.tools.map((tool) => tool.name)).toEqual(['Read', 'SkillTool']);
    expect(composed.hooks).toEqual([hook]);
    expect(composed.mcpServers.map((server) => server.name)).toEqual(['skill-mcp']);
    expect(composed.permissionRules).toEqual([rule]);
  });

  it('treats missing skill fields as empty arrays', () => {
    const composed = composeAgentConfig({
      model: getModel('openai', 'gpt-4o-mini'),
      skills: [{ id: 'bare' }],
    });

    expect(composed.tools).toEqual([]);
    expect(composed.hooks).toEqual([]);
    expect(composed.mcpServers).toEqual([]);
    expect(composed.permissionRules).toEqual([]);
  });

  it('defaults defaultTools to empty when both config.tools and options are omitted', () => {
    const composed = composeAgentConfig({
      model: getModel('openai', 'gpt-4o-mini'),
      skills: [{ id: 'empty' }],
    });

    expect(composed.tools).toEqual([]);
  });

  it('lets explicit tools override skill tools with the same name', () => {
    const composed = composeAgentConfig({
      model: getModel('openai', 'gpt-4o-mini'),
      skills: [{
        id: 'formatter',
        tools: [createTool('Format', 'Skill formatter')],
      }],
      tools: [createTool('Format', 'Explicit formatter')],
    });

    expect(composed.tools).toHaveLength(1);
    expect(composed.tools[0]?.description).toBe('Explicit formatter');
  });
});
