import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Static, TSchema } from '@sinclair/typebox';
import type { PermissionRule, PermissionResult } from './permissions.js';

// Capabilities
export type Capability =
  | 'fs:read'
  | 'fs:write'
  | 'process:spawn'
  | 'network:egress'
  | 'git:mutate'
  | 'mcp:call'
  /** Mutation on the swarm (spawn/dismiss teammates, send messages). */
  | 'swarm:mutate'
  /**
   * Arbitrary shell execution with an LLM-supplied command string. Broader
   * than `process:spawn` (which can be granted to tools that exec a
   * validated argv). Claimed only by the Bash tool; rules targeting
   * 'shell:exec' let users gate the shell separately from other spawners.
   */
  | 'shell:exec';

// SdkTool
export interface SdkTool<TParameters extends TSchema = TSchema, TDetails = any> extends AgentTool<TParameters, TDetails> {
  capabilities: Capability[];
  permissionCheck?: (params: Static<TParameters>, rules: PermissionRule[]) => PermissionResult;
}

// Tool Options
export interface ToolOptions { cwd?: string; allowedRoots?: string[]; }

// Schema Conversion
export interface SchemaConversionResult { schema: TSchema; isExact: boolean; warnings: string[]; }
