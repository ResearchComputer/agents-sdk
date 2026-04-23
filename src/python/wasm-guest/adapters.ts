import type {
  CoreAdapters,
  MemoryStore,
  SessionStore,
  TelemetrySink,
  McpManager,
  AuthTokenResolver,
  LlmClient,
  SdkTool,
} from "../../core/index.js";
import { createTelemetryCollector } from "../../core/index.js";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import * as hostTools from "research-computer:flash-agents/host-tools@0.1.0";

const memoryStore: MemoryStore = {
  load: async () => [],
  save: async () => {},
  remove: async () => {},
};

const sessionStore: SessionStore = {
  load: async () => null,
  save: async () => {},
  list: async () => [],
};

const telemetrySink: TelemetrySink = { flush: async () => {} };

const mcpManager: McpManager = {
  connect: async () => {
    throw new Error("mcp not wired in flash-agents v1");
  },
  disconnect: async () => {},
  getTools: () => [],
  getConnections: () => [],
};

const authTokenResolver: AuthTokenResolver = {
  resolve: async () => "flash-agents-token",
};

/**
 * Build tools declared by the Python host via host-tools.list-tools().
 * Each tool's execute() delegates back to host-tools.execute-tool().
 *
 * SdkTool extends pi-agent-core's AgentTool; its execute signature is
 *   execute(toolCallId, params, signal?, onUpdate?) -> Promise<AgentToolResult<T>>
 * and the result must wrap as { content, details }.
 */
export function makeHostTools(): SdkTool[] {
  const listJson = hostTools.listTools();
  const decls = JSON.parse(listJson) as Array<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
  return decls.map((d): SdkTool => ({
    name: d.name,
    label: d.name,
    description: d.description,
    parameters: d.inputSchema as any,
    capabilities: ["mcp:call"],
    async execute(
      toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const result = hostTools.executeTool({
        callId: toolCallId,
        toolName: d.name,
        inputJson: JSON.stringify(params ?? {}),
      });
      const parsed = JSON.parse(result.outputJson);
      if (result.isError) {
        const detail = (typeof parsed === "object" && parsed !== null) ? parsed as Record<string, unknown> : {};
        const parts: string[] = [];
        if (typeof detail.type === "string" && typeof detail.error === "string") {
          parts.push(`${detail.type}: ${detail.error}`);
        } else if (typeof detail.error === "string") {
          parts.push(detail.error);
        } else {
          parts.push("tool error");
        }
        const e: Error & { detail?: unknown } = new Error(parts.join("\n"));
        e.detail = parsed;
        throw e;
      }
      const output = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      return { content: [{ type: "text", text: output }], details: parsed };
    },
  }));
}

export function makeStubAdapters(llmClient: LlmClient): CoreAdapters {
  return {
    memoryStore,
    sessionStore,
    telemetryCollector: createTelemetryCollector({ optOut: true }),
    telemetrySink,
    mcpManager,
    authTokenResolver,
    llmClient,
    telemetryOptOut: true,
  };
}
