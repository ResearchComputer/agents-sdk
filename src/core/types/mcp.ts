import type { SdkTool } from './tools.js';

export interface McpServerConfig { name: string; transport: 'stdio' | 'sse' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; trustLevel?: 'trusted' | 'untrusted'; }
export interface McpConnection { name: string; config: McpServerConfig; close(): Promise<void>; }
export interface McpManager { connect(config: McpServerConfig): Promise<McpConnection>; disconnect(name: string): Promise<void>; getTools(): SdkTool<any, any>[]; getConnections(): McpConnection[]; }
