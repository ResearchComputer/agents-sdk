import type { SdkTool, ToolOptions } from '../../core/types.js';
import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';
import { createEditTool } from './edit.js';
import { createBashTool } from './bash.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';
import { createNotebookEditTool } from './notebook-edit.js';
import { createAskUserTool } from './ask-user.js';

export { resolvePath, isPathAllowed, isRealPathAllowed, truncateOutput, isBinaryContent } from './util.js';
export { createReadTool } from './read.js';
export { createWriteTool } from './write.js';
export { createEditTool } from './edit.js';
export { createBashTool } from './bash.js';
export type { BashToolOptions } from './bash.js';
export { createGlobTool } from './glob.js';
export { createGrepTool } from './grep.js';
export { createWebFetchTool } from './web-fetch.js';
export { createWebSearchTool } from './web-search.js';
export { createNotebookEditTool } from './notebook-edit.js';
export { createAskUserTool } from './ask-user.js';
export type { AskUserToolOptions } from './ask-user.js';

export interface GetAllToolsOptions extends ToolOptions {
  /** Timeout in seconds for bash commands (default 120) */
  bashTimeout?: number;
  /** Callback for AskUser tool */
  onQuestion?: (question: string) => Promise<string>;
}

/**
 * Returns all built-in tools with the given options.
 */
export function getAllTools(options?: GetAllToolsOptions): SdkTool<any, any>[] {
  const toolOpts: ToolOptions = { cwd: options?.cwd, allowedRoots: options?.allowedRoots };

  return [
    createReadTool(toolOpts),
    createWriteTool(toolOpts),
    createEditTool(toolOpts),
    createBashTool({ ...toolOpts, timeout: options?.bashTimeout }),
    createGlobTool(toolOpts),
    createGrepTool(toolOpts),
    createWebFetchTool(),
    createWebSearchTool(),
    createNotebookEditTool(toolOpts),
    createAskUserTool({ onQuestion: options?.onQuestion }),
  ];
}
