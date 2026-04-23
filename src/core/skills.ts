import type { HookHandler, McpServerConfig, PermissionRule, ResolvedSkill, SdkTool, AgentConfig } from './types.js';

export interface ComposeAgentConfigOptions {
  defaultTools?: SdkTool<any, any>[];
}

export interface ComposedAgentConfig extends AgentConfig {
  hooks: HookHandler[];
  mcpServers: McpServerConfig[];
  permissionRules: PermissionRule[];
  skills: ResolvedSkill[];
  tools: SdkTool<any, any>[];
}

export function composeAgentConfig(
  config: AgentConfig,
  options: ComposeAgentConfigOptions = {},
): ComposedAgentConfig {
  const skills = config.skills ?? [];
  const skillTools = skills.flatMap((skill) => skill.tools ?? []);
  const skillHooks = skills.flatMap((skill) => skill.hooks ?? []);
  const skillMcpServers = skills.flatMap((skill) => skill.mcpServers ?? []);
  const skillPermissionRules = skills.flatMap((skill) => skill.permissionRules ?? []);

  const tools = config.tools
    ? mergeByKey([...skillTools, ...config.tools], (tool) => tool.name)
    : mergeByKey([...(options.defaultTools ?? []), ...skillTools], (tool) => tool.name);

  return {
    ...config,
    hooks: [...skillHooks, ...(config.hooks ?? [])],
    mcpServers: mergeByKey([...skillMcpServers, ...(config.mcpServers ?? [])], (server) => server.name),
    permissionRules: [...skillPermissionRules, ...(config.permissionRules ?? [])],
    skills,
    tools,
  };
}

// Last-writer-wins merge: later items overwrite earlier ones with the same key,
// preserving the first-seen order. Callers order arrays so user-supplied
// entries appear AFTER skill-contributed ones, ensuring user wins.
function mergeByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  const orderedKeys: string[] = [];
  const merged = new Map<string, T>();

  for (const item of items) {
    const key = getKey(item);
    if (!merged.has(key)) {
      orderedKeys.push(key);
    }
    merged.set(key, item);
  }

  return orderedKeys.map((key) => merged.get(key)!);
}
