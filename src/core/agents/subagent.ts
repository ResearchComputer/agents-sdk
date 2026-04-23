import { Agent as PiAgent } from '@mariozechner/pi-agent-core';
import type { AgentMessage, StreamFn, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Message, Model } from '@researchcomputer/ai-provider';
import type { SdkTool } from '../types.js';

export interface SubAgentConfig {
  model: Model<any>;
  systemPrompt?: string;
  tools?: SdkTool<any, any>[];
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  streamFn?: StreamFn;
}

/**
 * Runs a sub-agent with the given prompt, waits for it to finish,
 * and extracts the last assistant text response.
 */
export async function runSubAgent(prompt: string, config: SubAgentConfig): Promise<string> {
  const agent = new PiAgent({
    initialState: {
      systemPrompt: config.systemPrompt ?? 'You are a helpful assistant.',
      model: config.model,
      tools: config.tools ?? [],
      thinkingLevel: 'off' as ThinkingLevel,
    },
    convertToLlm: config.convertToLlm ?? defaultConvertToLlm,
    getApiKey: config.getApiKey,
    toolExecution: 'parallel',
    streamFn: config.streamFn,
  });

  await agent.prompt(prompt);
  await agent.waitForIdle();

  // Extract last assistant text response
  const messages = agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role: string; content: unknown };
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        const texts = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text);
        if (texts.length > 0) {
          return texts.join('\n');
        }
      }
    }
  }

  return '';
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter((m) => {
    const role = (m as { role: string }).role;
    return role === 'user' || role === 'assistant' || role === 'toolResult';
  }) as Message[];
}
