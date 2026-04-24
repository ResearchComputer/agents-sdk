import type { TSchema } from '@sinclair/typebox';
import type { SdkTool } from '../types.js';
import { jsonSchemaToTypeBox } from './schema-convert.js';
import { McpConnectionError } from '../errors.js';
import { BoundedMap } from '../util/bounded-map.js';

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export type CallToolFn = (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>;

// Server names appear in the tool name as `mcp__<server>__<tool>`. Allowing
// `__` inside a server name makes parsing ambiguous (a server `foo__bar`
// could alias into a different server's namespace) and permission rules
// keyed on `{ type: 'mcp', server }` can be silently bypassed. Reject at
// registration instead of later at the match site.
export function assertValidMcpServerName(name: string): void {
  if (!name) {
    throw new McpConnectionError('MCP server name must be non-empty');
  }
  if (name.includes('__')) {
    throw new McpConnectionError(
      `MCP server name must not contain "__" (got ${JSON.stringify(name)}); this would make mcp__<server>__<tool> parsing ambiguous`,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new McpConnectionError(
      `MCP server name must match /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ (got ${JSON.stringify(name)})`,
    );
  }
}

// Caches jsonSchemaToTypeBox output keyed by the raw schema JSON. MCP tool
// schemas are static per-connection and reconnecting (or listing the same
// server from another host) re-enters this code path — re-parsing the same
// schema per tool is pure waste. Bounded so a pathological MCP server
// exposing many distinct schemas (or many reconnects with schema drift)
// cannot grow the cache unbounded across a long-running host process.
const schemaCache = new BoundedMap<string, TSchema>(1000);

function convertSchemaCached(inputSchema: Record<string, any>): TSchema {
  const key = JSON.stringify(inputSchema ?? {});
  const cached = schemaCache.get(key);
  if (cached) return cached;
  const { schema } = jsonSchemaToTypeBox(inputSchema ?? {});
  schemaCache.set(key, schema);
  return schema;
}

export function wrapMcpTool(
  serverName: string,
  mcpTool: McpToolDefinition,
  callTool: CallToolFn,
): SdkTool {
  assertValidMcpServerName(serverName);
  const schema = convertSchemaCached(mcpTool.inputSchema ?? {});

  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    label: `MCP: ${serverName}/${mcpTool.name}`,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
    parameters: schema,
    capabilities: ['mcp:call'],
    async execute(_toolCallId: string, args: unknown) {
      const result = await callTool(mcpTool.name, (args ?? {}) as Record<string, unknown>);
      const text = result.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n');

      return {
        content: [{ type: 'text' as const, text: text || 'Tool executed successfully.' }],
        details: {},
      };
    },
  };
}
