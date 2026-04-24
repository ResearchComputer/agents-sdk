import type { McpManager, McpConnection, McpServerConfig, SdkTool } from '../types.js';
import type { CoreAdapters } from '../factory.js';
import { createTelemetryCollector } from '../telemetry/collector.js';

/**
 * Build a child-safe view of the parent's CoreAdapters for use inside
 * a forked agent. Children share most state with the parent but MUST
 * NOT tear down parent-owned resources on their own dispose().
 *
 * What changes:
 *  - `mcpManager`: wrapped so child `dispose()` cannot disconnect parent
 *    MCP connections. Reads still pass through (child can list/call
 *    parent tools), but `getConnections()` returns empty so the dispose
 *    teardown loop finds nothing to tear down.
 *  - `telemetryCollector`: a fresh per-child collector. Prevents child
 *    events from double-counting on the parent's totals when the parent
 *    is also finalized.
 *
 * What is preserved (same reference):
 *  - `memoryStore`, `sessionStore`, `llmClient`, `authTokenResolver`,
 *    `createTrajectoryWriter`, `readTrajectoryFromStorage`, `redactArgs`,
 *    `redactMessages`, `telemetrySink`, `telemetryOptOut`.
 */
export function scopeAdaptersForChild(
  adapters: CoreAdapters,
  _parentSessionId: string,
  _childIndex: number,
): CoreAdapters {
  return {
    ...adapters,
    mcpManager: wrapMcpManagerChildSafe(adapters.mcpManager),
    telemetryCollector: createTelemetryCollector({
      optOut: adapters.telemetryOptOut ?? false,
    }),
  };
}

function wrapMcpManagerChildSafe(parent: McpManager): McpManager {
  return {
    // Reads pass through so the child sees the parent's servers.
    getTools(): SdkTool<import('@sinclair/typebox').TSchema, unknown>[] {
      return parent.getTools();
    },
    // Returning empty connections is what makes the dispose() teardown
    // loop a no-op for children — the loop iterates this list and calls
    // disconnect for each entry.
    getConnections(): McpConnection[] {
      return [];
    },
    async connect(config: McpServerConfig): Promise<McpConnection> {
      // A child is allowed to connect its own server, but we forward to
      // the parent's manager so the connection is tracked there. This is
      // uncommon in practice — children inherit the parent's tools.
      return parent.connect(config);
    },
    async disconnect(_name: string): Promise<void> {
      // Silent no-op: the parent owns these connections. If a child
      // explicitly requested a disconnect (e.g. via a user-written hook
      // before teardown), surfacing an error would be noisy and wrong.
    },
  };
}
