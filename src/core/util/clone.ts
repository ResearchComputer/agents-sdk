import type { AgentMessage } from '@mariozechner/pi-agent-core';

/**
 * Optimized cloning for arrays of AgentMessages.
 * `structuredClone` is notoriously slow for large arrays. Because AgentMessages
 * are mostly plain objects (JSON serializable), `JSON.parse(JSON.stringify(messages))`
 * is typically 2x-5x faster for large message histories, avoiding the structural
 * cycle-checking overhead of structuredClone.
 */
export function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  return JSON.parse(JSON.stringify(messages));
}
