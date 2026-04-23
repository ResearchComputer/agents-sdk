import { Type } from '@sinclair/typebox';
import type { SdkTool } from '../../core/types.js';

const AskUserParams = Type.Object({
  question: Type.String(),
});

export interface AskUserToolOptions {
  onQuestion?: (question: string) => Promise<string>;
}

export function createAskUserTool(options?: AskUserToolOptions): SdkTool<typeof AskUserParams> {
  return {
    name: 'AskUser',
    label: 'Ask user a question',
    description: 'Asks the user a question and returns their response.',
    parameters: AskUserParams,
    capabilities: [],
    async execute(_toolCallId, params) {
      if (options?.onQuestion) {
        const answer = await options.onQuestion(params.question);
        return {
          content: [{ type: 'text', text: answer }],
          details: { question: params.question },
        };
      }
      return {
        content: [{ type: 'text', text: 'User interaction is not available.' }],
        details: { question: params.question, available: false },
      };
    },
  };
}
