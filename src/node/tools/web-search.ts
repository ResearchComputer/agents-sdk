import { Type } from '@sinclair/typebox';
import type { SdkTool } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';

const WebSearchParams = Type.Object({
  query: Type.String(),
});

export function createWebSearchTool(): SdkTool<typeof WebSearchParams> {
  return {
    name: 'WebSearch',
    label: 'Search the web',
    description: 'Searches the web for information.',
    parameters: WebSearchParams,
    capabilities: ['network:egress'],
    async execute(_toolCallId, _params) {
      throw new ToolExecutionError(
        'WebSearch is not configured on this agent. Do not retry.',
      );
    },
  };
}
