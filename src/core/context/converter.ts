import type { Message } from '@researchcomputer/ai-provider';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { MemoryInjectionMessage, CompactionSummaryMessage, SwarmReportMessage } from '../types.js';

/**
 * Narrow a value to `{ role: string }` without the loose `as` cast. Returns
 * undefined if the value is not an object with a string role field — callers
 * can then skip the message instead of silently emitting a default segment.
 */
function readRole(msg: unknown): string | undefined {
  if (msg === null || typeof msg !== 'object') return undefined;
  const role = (msg as { role?: unknown }).role;
  return typeof role === 'string' ? role : undefined;
}

/**
 * Converts AgentMessage[] to LLM-compatible Message[].
 *
 * Standard messages (user, assistant, toolResult) pass through unchanged.
 * Custom SDK messages are converted to UserMessages with descriptive prefixes.
 * Malformed messages and unknown roles are skipped.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    const role = readRole(msg);
    if (role === undefined) continue;
    switch (role) {
      case 'user':
      case 'assistant':
      case 'toolResult':
        result.push(msg as Message);
        break;
      case 'memory': {
        const mem = msg as MemoryInjectionMessage;
        result.push({ role: 'user', content: `[Memory] ${mem.content}`, timestamp: mem.timestamp });
        break;
      }
      case 'summary': {
        const sum = msg as CompactionSummaryMessage;
        result.push({ role: 'user', content: `[Context Summary] ${sum.content}`, timestamp: sum.timestamp });
        break;
      }
      case 'swarmReport': {
        const rep = msg as SwarmReportMessage;
        result.push({ role: 'user', content: `[Agent Report: ${rep.fromAgent}] ${rep.content}`, timestamp: rep.timestamp });
        break;
      }
      default:
        // Unknown roles are skipped
        break;
    }
  }

  return result;
}
