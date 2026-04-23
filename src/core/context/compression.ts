import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@researchcomputer/ai-provider';
import type { CompressionConfig, SegmentType, TranscriptSegment } from '../types.js';

/**
 * Estimates token count as ceil(text.length / 4).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extracts text content from an AgentMessage.
 * Handles string content, array of TextContent, or falls back to JSON.stringify.
 */
export function messageText(msg: AgentMessage): string {
  if (msg === null || typeof msg !== 'object') return '';
  const m = msg as unknown as Record<string, unknown>;
  const content = m.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const c of content) {
      if (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text') {
        const text = (c as TextContent).text;
        if (typeof text === 'string') texts.push(text);
      }
    }
    if (texts.length > 0) {
      return texts.join('\n');
    }
  }

  return JSON.stringify(m);
}

function roleToSegmentType(role: string): SegmentType {
  switch (role) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'toolResult': return 'toolIO';
    case 'memory': return 'memory';
    case 'summary': return 'summary';
    default: return 'user'; // fallback
  }
}

/**
 * Groups messages into TranscriptSegments by consecutive role type.
 */
export function segmentMessages(messages: AgentMessage[]): TranscriptSegment[] {
  if (messages.length === 0) return [];

  const segments: TranscriptSegment[] = [];
  let currentType: SegmentType | null = null;
  let currentMessages: AgentMessage[] = [];

  for (const msg of messages) {
    const role = msg && typeof msg === 'object' ? (msg as { role?: unknown }).role : undefined;
    if (typeof role !== 'string') continue;
    const type = roleToSegmentType(role);

    if (type === currentType) {
      currentMessages.push(msg);
    } else {
      if (currentType !== null) {
        segments.push({ type: currentType, protected: false, messages: currentMessages });
      }
      currentType = type;
      currentMessages = [msg];
    }
  }

  if (currentType !== null) {
    segments.push({ type: currentType, protected: false, messages: currentMessages });
  }

  return segments;
}

/**
 * Creates a transformContext middleware for context compression.
 *
 * Truncate strategy:
 * - Protects the most recent N turns (protectedRecentTurns * 3 messages)
 * - If total tokens are under 80% of maxTokens, returns unchanged
 * - Otherwise keeps as many older messages as fit in budget, starting from most recent older ones
 *
 * Summarize strategy falls back to truncate for now.
 */
export function createCompressionMiddleware(
  config: CompressionConfig,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const protectedRecentTurns = config.protectedRecentTurns ?? 3;
  const protectedMessageCount = protectedRecentTurns * 3;

  if (config.strategy === 'summarize') {
    // eslint-disable-next-line no-console
    console.warn(
      '[agents-sdk] compressionStrategy "summarize" is not yet implemented; falling back to "truncate".',
    );
  }

  return async (messages: AgentMessage[], _signal?: AbortSignal): Promise<AgentMessage[]> => {
    // Compute messageText exactly once per message. At long histories the
    // previous version called messageText on each message 3–4 times (total
    // scan, recent scan, per-segment scan), trending toward O(N²) per turn
    // because JSON.stringify fallback serializes the whole message object.
    const texts = new Array<string>(messages.length);
    const tokens = new Array<number>(messages.length);
    let totalTokens = 0;
    for (let i = 0; i < messages.length; i++) {
      const t = messageText(messages[i]);
      texts[i] = t;
      const tok = estimateTokens(t);
      tokens[i] = tok;
      totalTokens += tok;
    }

    // If under 80% of budget, return unchanged
    if (totalTokens <= config.maxTokens * 0.8) {
      return messages;
    }

    // Split into older and protected recent messages
    const protectedCount = Math.min(protectedMessageCount, messages.length);
    const splitIndex = messages.length - protectedCount;
    const olderMessages = messages.slice(0, splitIndex);
    const recentMessages = messages.slice(splitIndex);

    // Reuse cached per-message tokens instead of re-running messageText.
    let recentTokens = 0;
    for (let i = splitIndex; i < messages.length; i++) recentTokens += tokens[i];
    const olderBudget = config.maxTokens - recentTokens;

    if (olderBudget <= 0) {
      // Only recent messages fit
      return recentMessages;
    }

    // Use segment-based truncation to avoid splitting mid-turn. Segment
    // objects retain the original AgentMessage references, so we map back
    // to the cached token counts via index identity.
    const indexByMessage = new Map<AgentMessage, number>();
    for (let i = 0; i < olderMessages.length; i++) indexByMessage.set(olderMessages[i], i);

    const segments = segmentMessages(olderMessages);
    const kept: AgentMessage[] = [];
    let usedTokens = 0;

    for (let i = segments.length - 1; i >= 0; i--) {
      let segTokens = 0;
      for (const m of segments[i].messages) {
        const idx = indexByMessage.get(m);
        segTokens += idx === undefined ? estimateTokens(messageText(m)) : tokens[idx];
      }
      if (usedTokens + segTokens <= olderBudget) {
        kept.unshift(...segments[i].messages);
        usedTokens += segTokens;
      } else {
        break;
      }
    }

    return [...kept, ...recentMessages];
  };
}
