import { Type } from '@sinclair/typebox';
import type { SdkTool } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';
import { truncateOutput } from './util.js';

const WebFetchParams = Type.Object({
  url: Type.String(),
});

export function createWebFetchTool(): SdkTool<typeof WebFetchParams> {
  return {
    name: 'WebFetch',
    label: 'Fetch URL content',
    description: 'Fetches content from a URL.',
    parameters: WebFetchParams,
    capabilities: ['network:egress'],
    async execute(_toolCallId, params, signal) {
      try {
        const response = await fetch(params.url, { signal });
        if (!response.ok) {
          throw new ToolExecutionError(`HTTP ${response.status}: ${response.statusText}`);
        }
        const text = await response.text();
        const output = truncateOutput(text, 100 * 1024);
        return {
          content: [{ type: 'text', text: output }],
          details: { url: params.url, status: response.status },
        };
      } catch (err: any) {
        if (err instanceof ToolExecutionError) throw err;
        throw new ToolExecutionError(`Failed to fetch ${params.url}: ${err.message}`);
      }
    },
  };
}
