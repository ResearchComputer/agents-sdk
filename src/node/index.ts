// Re-export all public core surface
export * from '../core/index.js';

// Node-only: auth
export { initiateLogin, exchangeToken } from './auth/login.js';
export { getSession, logout } from './auth/session.js';
export type { Session } from './auth/session.js';

// Node-only: spec loader + JSONL
export { findSpecDir, loadSchema, readJsonlStream } from './spec/index.js';

// Node-only: tools
export {
  resolvePath, isPathAllowed, truncateOutput, isBinaryContent,
  createReadTool, createWriteTool, createEditTool, createBashTool,
  createGlobTool, createGrepTool, createWebFetchTool, createWebSearchTool,
  createNotebookEditTool, createAskUserTool, getAllTools,
} from './tools/index.js';
export type { BashToolOptions, AskUserToolOptions, GetAllToolsOptions } from './tools/index.js';

// Node-only: memory/session stores (implement core's MemoryStore / SessionStore)
export { createNodeMemoryStore } from './memory/index.js';
export { createNodeSessionStore } from './session/index.js';

// Node-only: MCP manager (SDK-owning)
export { createMcpManager } from './mcp/index.js';

// Node-only: trajectory writer (filesystem-backed JSONL)
export { createNodeTrajectoryWriter, readNodeTrajectoryFile } from './trajectory/index.js';
export type { NodeTrajectoryWriterOptions } from './trajectory/index.js';

// Node-only: LLM client (ai-provider-backed default)
export { createAiProviderLlmClient } from './llm/index.js';

// Node-only: factory
export { createAgent } from './factory.js';
