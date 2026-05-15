import type { Capability } from './tools.js';

export type PermissionMode = 'default' | 'allowAll' | 'rulesOnly';
export type PermissionResult = { behavior: 'allow' } | { behavior: 'deny'; reason: string } | { behavior: 'ask'; prompt: string };
export interface PermissionRule { target: PermissionTarget; behavior: 'allow' | 'deny'; source: 'user' | 'project' | 'session'; }
export type PermissionTarget = { type: 'tool'; name: string; pattern?: string } | { type: 'capability'; capability: Capability } | { type: 'mcp'; server: string; tool?: string } | { type: 'all' };
export interface PermissionDecision { toolName: string; args: unknown; behavior: 'allow' | 'deny'; matchedRule?: PermissionRule; normalizedTarget: string; timestamp: number; }
