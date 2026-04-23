import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpConnection, McpManager, McpServerConfig, SdkTool } from '../../core/types.js';
import { McpConnectionError } from '../../core/errors.js';
import { wrapMcpTool, assertValidMcpServerName } from '../../core/mcp/tools.js';

interface InternalConnection extends McpConnection {
  client: Client;
  tools: SdkTool[];
}

export function createMcpManager(): McpManager {
  const connections = new Map<string, InternalConnection>();

  return {
    async connect(config: McpServerConfig): Promise<McpConnection> {
      assertValidMcpServerName(config.name);
      if (connections.has(config.name)) {
        throw new McpConnectionError(
          `MCP server name already connected: ${config.name}`,
        );
      }
      try {
        let transport: Transport;

        if (config.transport === 'stdio') {
          if (!config.command) {
            throw new McpConnectionError(`stdio transport requires a command for server: ${config.name}`);
          }
          transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: config.env as Record<string, string> | undefined,
          });
        } else if (config.transport === 'sse') {
          if (!config.url) {
            throw new McpConnectionError(`SSE transport requires a url for server: ${config.name}`);
          }
          transport = new SSEClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          });
        } else if (config.transport === 'http') {
          if (!config.url) {
            throw new McpConnectionError(`HTTP transport requires a url for server: ${config.name}`);
          }
          transport = new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          });
        } else {
          const exhaustive: never = config.transport;
          throw new McpConnectionError(`Unsupported transport: ${exhaustive}`);
        }

        const client = new Client({ name: '@researchcomputer/agents-sdk', version: '0.1.0' });
        await client.connect(transport);

        const { tools: mcpTools } = await client.listTools();

        const wrappedTools = mcpTools.map((mcpTool) =>
          wrapMcpTool(config.name, mcpTool, async (name, args) => {
            const result = await client.callTool({ name, arguments: args });
            return result as { content: Array<{ type: string; text?: string }> };
          }),
        );

        const connection: InternalConnection = {
          name: config.name,
          config,
          client,
          tools: wrappedTools,
          async close() {
            await client.close();
          },
        };

        connections.set(config.name, connection);
        return connection;
      } catch (err) {
        if (err instanceof McpConnectionError) throw err;
        throw new McpConnectionError(`Failed to connect to MCP server ${config.name}: ${(err as Error).message}`);
      }
    },

    async disconnect(name: string): Promise<void> {
      const conn = connections.get(name);
      if (conn) {
        await conn.close();
        connections.delete(name);
      }
    },

    getTools(): SdkTool[] {
      const allTools: SdkTool[] = [];
      for (const conn of connections.values()) {
        allTools.push(...conn.tools);
      }
      return allTools;
    },

    getConnections(): McpConnection[] {
      return Array.from(connections.values());
    },
  };
}
