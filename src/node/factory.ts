import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { createAgentCore, type CoreAdapters } from '../core/factory.js';
import { createTelemetryCollector } from '../core/telemetry/collector.js';
import { composeAgentConfig } from '../core/skills.js';
import { createNodeMemoryStore } from './memory/node-memory-store.js';
import { createNodeSessionStore } from './session/node-session-store.js';
import { createNodeTelemetrySink } from './telemetry/node-telemetry-sink.js';
import { createMcpManager } from './mcp/manager.js';
import { createNodeTrajectoryWriter } from './trajectory/node-trajectory-writer.js';
import { readNodeTrajectoryFile } from './trajectory/reader.js';
import { createNodeAuthTokenResolver, resolveAuthToken } from './auth/resolver.js';
import { createAiProviderLlmClient } from './llm/ai-provider-client.js';
import { getAllTools } from './tools/index.js';
import type { Agent, AgentConfig, SdkWarning } from '../core/types.js';
import { resolveTelemetryConfig } from './telemetry/resolve-config.js';

export type {
  AutoForkConfig,
  AgentConfig,
  Agent,
} from '../core/types.js';

export async function createAgent(config: AgentConfig): Promise<Agent> {
  const cwd = config.cwd ?? process.cwd();

  // 1. Auth
  const authToken = await resolveAuthToken(config);

  // 2. Telemetry config
  const optOut = config.telemetry === false;
  const uploadConfig = optOut ? null : await resolveTelemetryConfig(config.telemetry, authToken);

  // 3. Paths
  const memoryDir = config.memoryDir ?? path.join(os.homedir(), '.rc-agents', 'memory');
  const sessionDir = config.sessionDir ?? path.join(os.homedir(), '.rc-agents', 'sessions');
  // Trajectories co-locate with sessions by default; distinguished by extension.
  const trajectoryDir = sessionDir;

  // 4. Default tools (node-specific)
  const defaultTools = config.tools ?? getAllTools({
    cwd,
    onQuestion: config.onQuestion,
  });

  // 5. Pre-compose config to extract MCP server list for early connection
  const composedForMcp = composeAgentConfig(config, { defaultTools });

  // 6. MCP manager — connect all servers before building core adapters
  const mcp = createMcpManager();
  const mcpWarnings: SdkWarning[] = [];
  if (composedForMcp.mcpServers.length > 0) {
    for (const serverConfig of composedForMcp.mcpServers) {
      try {
        await mcp.connect(serverConfig);
      } catch (err) {
        mcpWarnings.push({
          code: 'mcp_connect_failed',
          message: `Failed to connect MCP server ${serverConfig.name}: ${(err as Error).message}`,
          timestamp: Date.now(),
          cause: err,
        });
      }
    }
  }

  // 7. Adapters
  const adapters: CoreAdapters = {
    memoryStore: createNodeMemoryStore(memoryDir),
    sessionStore: createNodeSessionStore(sessionDir),
    telemetryCollector: createTelemetryCollector({ optOut }),
    telemetrySink: createNodeTelemetrySink({ sessionDir, uploadConfig }),
    mcpManager: mcp,
    authTokenResolver: createNodeAuthTokenResolver(config),
    initialWarnings: mcpWarnings,
    llmClient: createAiProviderLlmClient(),
    telemetryOptOut: optOut,
    createTrajectoryWriter: (options) =>
      createNodeTrajectoryWriter({ dir: trajectoryDir, trajectoryId: options?.trajectoryId }),
    readTrajectoryFromStorage: (trajectoryId) => readNodeTrajectoryFile(trajectoryDir, trajectoryId),
    redactArgs: config.redactArgs,
    redactMessages: config.redactMessages,
  };

  // 8. System-prompt hash (createHash is sync; Web Crypto digest is async)
  // Hash the base system prompt from config. Core will re-build the full prompt
  // including skills/tools/memories — we hash the base as a stable identifier.
  // Full 64-char hex digest per spec/schemas/session.v1.schema.json.
  const basePromptForHash = config.systemPrompt ?? 'You are a coding agent that helps users with software development tasks.';
  const systemPromptHash = 'sha256:' + createHash('sha256').update(basePromptForHash).digest('hex');

  return createAgentCore({
    ...config,
    cwd,
    tools: defaultTools,
    systemPromptHash,
  }, adapters);
}
