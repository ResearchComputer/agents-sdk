import type { SdkTool } from './tools.js';
import type { McpServerConfig } from './mcp.js';
import type { HookHandler } from './events.js';
import type { PermissionRule } from './permissions.js';

export interface ResolvedSkill {
  id: string;
  description?: string;
  promptSections?: string[];
  tools?: SdkTool<any, any>[];
  mcpServers?: McpServerConfig[];
  hooks?: HookHandler[];
  permissionRules?: PermissionRule[];
  metadata?: Record<string, string>;
}
