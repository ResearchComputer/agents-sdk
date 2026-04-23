import type { SdkTool, MemorySelection, PermissionMode, ResolvedSkill } from '../types.js';

export interface SystemPromptConfig {
  basePrompt?: string;
  skills?: ResolvedSkill[];
  tools?: SdkTool<any, any>[];
  memories?: MemorySelection[];
  permissionMode?: PermissionMode;
  swarmContext?: { teammates: string[]; instructions?: string };
}

const DEFAULT_BASE_PROMPT = 'You are a coding agent that helps users with software development tasks.';

/**
 * Builds a system prompt by assembling sections in order:
 * 1. Base prompt
 * 2. Skill instructions
 * 3. Tool descriptions
 * 4. Memory context
 * 5. Memory instructions
 * 6. Permission context
 * 7. Swarm context
 */
export function buildSystemPrompt(config: SystemPromptConfig): string {
  const sections: string[] = [];

  // 1. Base prompt
  sections.push(config.basePrompt ?? DEFAULT_BASE_PROMPT);

  // 2. Skill instructions
  if (config.skills && config.skills.length > 0) {
    const skillBlocks = config.skills
      .map((skill) => {
        const promptSections = (skill.promptSections ?? [])
          .map((section) => section.trim())
          .filter((section) => section.length > 0);

        if (!skill.description && promptSections.length === 0) {
          return '';
        }

        const parts = [`## ${skill.id}`];
        if (skill.description?.trim()) {
          parts.push(skill.description.trim());
        }
        parts.push(...promptSections);
        return parts.join('\n\n');
      })
      .filter((block) => block.length > 0);

    if (skillBlocks.length > 0) {
      sections.push(`# Active Skills\n\n${skillBlocks.join('\n\n')}`);
    }
  }

  // 3. Tool descriptions
  if (config.tools && config.tools.length > 0) {
    const toolLines = config.tools.map(t => `- **${t.name}**: ${t.description}`);
    sections.push(`# Available Tools\n\n${toolLines.join('\n')}`);
  }

  // 4. Memory context
  if (config.memories && config.memories.length > 0) {
    const memLines = config.memories.map(m => {
      const date = new Date(m.updatedAt).toISOString().split('T')[0];
      return `- [${m.source}, ${date}] ${m.memory.content}`;
    });
    sections.push(`# Relevant Memories\n\n${memLines.join('\n')}`);
  }

  // 5. Memory instructions (always)
  sections.push(
    'When the user provides feedback or corrections, remember them for future interactions. ' +
    'Use any available memory context to inform your responses.',
  );

  // 6. Permission context
  if (config.permissionMode) {
    sections.push(
      `# Permission Mode\n\nCurrent permission mode: ${config.permissionMode}. ` +
      'Respect tool permission rules when executing actions.',
    );
  }

  // 7. Swarm context
  if (config.swarmContext) {
    let swarmSection = `# Team Context\n\nYou are part of a team. Your teammates: ${config.swarmContext.teammates.join(', ')}.`;
    if (config.swarmContext.instructions) {
      swarmSection += `\n\n${config.swarmContext.instructions}`;
    }
    sections.push(swarmSection);
  }

  return sections.join('\n\n');
}
